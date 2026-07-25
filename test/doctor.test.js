'use strict';
// The tool's own test suite. It installs the template into a throwaway directory and
// then runs the real diagnosis against it — same code path a customer gets. If these
// pass, the shipped template actually catches what the README claims it catches.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { install, templateFiles } = require('../lib/init');
const { diagnose, runHook, classify, satisfies, HOOK_FILES } = require('../lib/doctor');
const { FIXTURES, forHook } = require('../lib/fixtures');

function tmpRepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-'));
  return d;
}

test('template contains a hook file for every fixture group', () => {
  const files = templateFiles();
  for (const hook of new Set(FIXTURES.map((f) => f.hook))) {
    const expected = path.join('.claude', 'hooks', HOOK_FILES[hook]);
    assert.ok(
      files.some((f) => f === expected || f.replace(/\\/g, '/') === expected.replace(/\\/g, '/')),
      `no template hook for fixture group "${hook}" (expected ${expected})`
    );
  }
});

test('every template hook is valid JavaScript', () => {
  for (const rel of templateFiles().filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'template', rel), 'utf8');
    assert.doesNotThrow(() => new (require('vm').Script)(src, { filename: rel }), `${rel} does not parse`);
  }
});

test('settings.json template parses and registers every installed hook', () => {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'template', '.claude', 'settings.json'), 'utf8');
  const settings = JSON.parse(raw);
  const blob = JSON.stringify(settings.hooks);
  for (const file of Object.values(HOOK_FILES)) {
    assert.ok(blob.includes(file), `${file} is installed but not registered in settings.json — it would never run`);
  }
});

test('init writes the spine and does not clobber existing files', () => {
  const repo = tmpRepo();
  const first = install(repo);
  assert.ok(first.written.length > 0, 'nothing was written');
  assert.equal(first.skipped.length, 0, 'clean repo should skip nothing');

  const target = path.join(repo, 'CLAUDE.md');
  fs.writeFileSync(target, 'MINE — do not overwrite');
  const second = install(repo);
  assert.ok(second.skipped.includes('CLAUDE.md'), 'existing CLAUDE.md was not reported as skipped');
  assert.equal(fs.readFileSync(target, 'utf8'), 'MINE — do not overwrite', 'existing file was clobbered');
});

test('a freshly initialised repo passes doctor with zero gaps', async () => {
  const repo = tmpRepo();
  install(repo);
  const diag = await diagnose(repo);

  const misses = diag.results.filter((r) => r.verdict === 'MISS');
  const noise = diag.results.filter((r) => r.verdict === 'NOISE');

  assert.deepEqual(
    misses.map((m) => m.id),
    [],
    'hooks stayed silent on hazards they are supposed to catch'
  );
  assert.deepEqual(
    noise.map((n) => n.id),
    [],
    'hooks fired on harmless commands — this is what gets guards disabled'
  );
  assert.equal(diag.wiring.unregistered.length, 0, 'a hook is installed but not wired into settings.json');
  assert.ok(diag.ok, 'fresh install should be healthy');
});

test('a bare repo is reported as unprotected, not as healthy', async () => {
  const repo = tmpRepo();
  const diag = await diagnose(repo);

  assert.ok(diag.results.every((r) => r.verdict === 'absent'), 'empty repo should be all absent');
  assert.equal(diag.wiring.settingsFound, false);
  assert.equal(diag.bare, true, 'a repo with nothing installed must be flagged bare');

  // This assertion used to read `ok === true`, on the reasoning that an empty repo has no gaps
  // because it has nothing to have gaps in. That reasoning produced the words "spine healthy"
  // on a repo with zero protection — a health certificate for having nothing, which is the
  // exact false green this tool exists to destroy, sitting in its own front door.
  //
  // An absent guard is not a passing guard. `doctor` exits non-zero here so CI says so.
  assert.equal(diag.ok, false, 'a repo with no guards installed must not report healthy');
});

test('doctor catches a hook that exists but is not registered', async () => {
  const repo = tmpRepo();
  install(repo);
  const sp = path.join(repo, '.claude', 'settings.json');
  const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
  // Remove the ratchet from the wiring, leave the file on disk.
  s.hooks.PreToolUse[0].hooks = s.hooks.PreToolUse[0].hooks.filter(
    (h) => !h.command.includes('permission-ratchet')
  );
  fs.writeFileSync(sp, JSON.stringify(s, null, 2));

  const diag = await diagnose(repo);
  assert.ok(diag.wiring.unregistered.includes('ratchet'), 'unregistered hook was not detected');
});

test('block satisfies an expectation of warn, but not the reverse', () => {
  assert.equal(satisfies('warn', 'block'), true);
  assert.equal(satisfies('block', 'warn'), false);
  assert.equal(satisfies('silent', 'warn'), false);
  assert.equal(satisfies('silent', 'silent'), true);
});

test('hooks survive malformed stdin without breaking the tool call', async () => {
  const repo = tmpRepo();
  install(repo);
  for (const file of Object.values(HOOK_FILES)) {
    const hookPath = path.join(repo, '.claude', 'hooks', file);
    const res = await new Promise((resolve) => {
      const { spawn } = require('child_process');
      const c = spawn(process.execPath, [hookPath], { stdio: ['pipe', 'pipe', 'pipe'] });
      let o = '';
      c.stdout.on('data', (d) => (o += d));
      c.on('close', (code) => resolve({ code, o }));
      c.stdin.end('this is not json at all {{{');
    });
    assert.equal(res.code, 0, `${file} exited non-zero on garbage input — that would block a real tool call`);
  }
});

test('the ratchet denies via JSON on stdout with exit 0, and says why', async () => {
  const repo = tmpRepo();
  install(repo);
  const hookPath = path.join(repo, '.claude', 'hooks', HOOK_FILES.ratchet);
  const fixture = forHook('ratchet').find((f) => f.expect === 'block');
  const res = await runHook(hookPath, fixture.input);

  // Exit 2 is the legacy path and it is confirmed not to block on Windows
  // (anthropics/claude-code#80039). The JSON form is the documented preferred contract and
  // the only one that lands everywhere, so the shipped ratchet must use it — which means
  // exit 0, because exit 2 causes stdout to be discarded.
  assert.equal(res.code, 0, 'ratchet must exit 0 so its JSON decision is read, not discarded');

  const payload = JSON.parse(res.stdout);
  assert.equal(payload.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(payload.hookSpecificOutput.permissionDecisionReason, /RATCHET/i, 'denied without telling the agent why');

  // And the grader has to recognise that as a block, or it would quietly mark every
  // correctly-written modern hook as a mere warning.
  assert.equal(classify(res), 'block');
});

test('the grader recognises a JSON deny as a block, not a warning', () => {
  const jsonDeny = {
    code: 0,
    stdout: JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' },
    }),
    stderr: '',
  };
  assert.equal(classify(jsonDeny), 'block');

  // Diagnostics printed around the JSON must not defeat the parse.
  assert.equal(classify({ ...jsonDeny, stdout: `checking...\n${jsonDeny.stdout}\ndone` }), 'block');

  // "ask" escalates to a human; it does not guarantee a stop, so it is not a block.
  assert.equal(
    classify({
      code: 0,
      stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'ask' } }),
      stderr: '',
    }),
    'warn'
  );

  // Legacy exit 2 must still grade as a block.
  assert.equal(classify({ code: 2, stdout: '', stderr: 'blocked' }), 'block');
});
