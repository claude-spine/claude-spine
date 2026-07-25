'use strict';
// Tests for `adopt` — the only code here that edits a file it did not write. That makes it the
// most dangerous thing in the package, so it gets the most coverage: the wrap must be exactly
// reversible, must preserve every sibling key, must not double-apply, and above all must not
// change what the wrapped hook DOES. A monitoring layer that alters the thing it monitors is
// worse than no monitoring.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { install } = require('../lib/init');
const adopt = require('../lib/adopt');
const { diagnose } = require('../lib/doctor');
const settingsLib = require('../lib/settings');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'spine-adopt-'));

/** A repo with our spine installed plus one foreign hook registered in settings.local.json. */
function repoWithForeignHook(body = 'process.exit(0)') {
  const repo = tmp();
  install(repo);
  const hooksDir = path.join(repo, '.claude', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, 'their-guard.js'), body);
  fs.writeFileSync(
    path.join(repo, '.claude', 'settings.local.json'),
    JSON.stringify(
      {
        env: { THEIR_VAR: 'keep-me' },
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ type: 'command', command: 'node .claude/hooks/their-guard.js', timeout: 5 }],
            },
          ],
        },
      },
      null,
      2
    )
  );
  return repo;
}

const readCmd = (repo) =>
  JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'settings.local.json'), 'utf8')).hooks.PreToolUse[0]
    .hooks[0];

test('settings resolution reads settings.local.json, not just settings.json', () => {
  const repo = repoWithForeignHook();
  const { hooks, sources } = settingsLib.registeredHooks(repo);

  assert.ok(sources.includes('settings.local.json'), 'local settings file was ignored');
  assert.ok(
    hooks.some((h) => h.name === 'their-guard'),
    'a hook registered in settings.local.json was invisible — this reported "nothing invokes these hooks" on a live repo'
  );
  // Our own hooks come from settings.json; both files must contribute.
  assert.ok(hooks.some((h) => h.name === 'permission-ratchet'), 'settings.json hooks were dropped by the merge');
});

test('doctor names foreign hooks instead of silently grading only its own', async () => {
  const repo = repoWithForeignHook();
  const diag = await diagnose(repo);
  const foreign = diag.wiring.foreign.map((h) => h.name);
  assert.ok(foreign.includes('their-guard'), 'foreign hook not reported');
  assert.ok(!foreign.includes('permission-ratchet'), 'our own hook misreported as foreign');
});

test('a registered hook missing from disk is reported — a valid settings file cannot catch this', async () => {
  const repo = repoWithForeignHook();
  fs.unlinkSync(path.join(repo, '.claude', 'hooks', 'their-guard.js'));
  const diag = await diagnose(repo);
  assert.ok(
    diag.wiring.deadPaths.some((h) => h.name === 'their-guard'),
    'a registered script that does not exist was not flagged'
  );
});

test('adopt wraps, and undo restores byte-identically', () => {
  const repo = repoWithForeignHook();
  const original = readCmd(repo).command;

  adopt.apply(repo);
  const wrapped = readCmd(repo).command;
  assert.ok(wrapped.includes('spine-wrap.js'), 'command was not wrapped');
  assert.ok(wrapped.endsWith(original), 'the original command must survive verbatim after the --');

  adopt.apply(repo, { undo: true });
  assert.equal(readCmd(repo).command, original, 'undo did not restore the original command');
});

test('adopt preserves sibling keys and unrelated settings', () => {
  const repo = repoWithForeignHook();
  adopt.apply(repo);

  const entry = readCmd(repo);
  assert.equal(entry.timeout, 5, 'timeout was lost');
  assert.equal(entry.type, 'command', 'type was lost');

  const all = JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'settings.local.json'), 'utf8'));
  assert.equal(all.hooks.PreToolUse[0].matcher, 'Bash', 'matcher was lost');
  assert.deepEqual(all.env, { THEIR_VAR: 'keep-me' }, 'unrelated top-level settings were lost');
});

test('adopt backs up before writing, and is idempotent', () => {
  const repo = repoWithForeignHook();
  const res = adopt.apply(repo);
  assert.ok(res.backup && fs.existsSync(res.backup), 'no backup was written before editing');
  assert.equal(res.applied, 1);

  const again = adopt.apply(repo);
  assert.equal(again.applied, 0, 'running adopt twice double-wrapped the hook');
  assert.ok(!readCmd(repo).command.match(/spine-wrap[\s\S]*spine-wrap/), 'double wrap detected');
});

test('adopt never wraps our own hooks — they already stamp themselves', () => {
  const repo = repoWithForeignHook();
  const p = adopt.plan(repo);
  const names = p.changes.map((c) => c.name);
  assert.deepEqual(names, ['their-guard'], `expected only the foreign hook, got ${names.join(', ')}`);
});

test('the shim passes exit 2 through — wrapping must not disarm a guard', () => {
  const repo = repoWithForeignHook("process.stderr.write('DENIED\\n');process.exit(2);");
  const shim = path.join(repo, '.claude', 'hooks', 'spine-wrap.js');
  const target = path.join(repo, '.claude', 'hooks', 'their-guard.js');

  let code = 0;
  let stderr = '';
  try {
    execFileSync(process.execPath, [shim, 'their-guard', '--', process.execPath, target], {
      input: '{}',
      encoding: 'utf8',
    });
  } catch (e) {
    code = e.status;
    stderr = e.stderr || '';
  }
  assert.equal(code, 2, 'a denying hook stopped denying once wrapped');
  assert.match(stderr, /DENIED/, "the hook's own stderr did not pass through");
});

test('the shim forwards a crashing hook as a NON-blocking failure, never as a deny', () => {
  const repo = repoWithForeignHook();
  const shim = path.join(repo, '.claude', 'hooks', 'spine-wrap.js');

  // Per the hook contract only exit 2 blocks a tool call; other non-zero codes are
  // non-blocking errors. So a hook that crashes (node exits 1 on a missing module) must come
  // back as 1 — NOT as 2. If wrapping ever converted a crash into a 2, a single broken hook
  // would start denying every tool call in the repo and look like deliberate policy (#80697).
  //
  // My first pass at verifying this read `$?` after a shell pipe, which reports the exit code
  // of `tail`, not the shim. It printed 0 and looked exactly like proof.
  let code = 0;
  try {
    execFileSync(process.execPath, [shim, 'ghost', '--', process.execPath, path.join(repo, '.claude', 'hooks', 'nope.js')], {
      input: '{}',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    code = e.status;
  }
  assert.notEqual(code, 2, 'a crashing hook was converted into a deny — this would block every tool call');
  assert.equal(code, 1, 'crash exit code was not forwarded faithfully');
});

test('the shim fails open when the command cannot be spawned at all', () => {
  const repo = repoWithForeignHook();
  const shim = path.join(repo, '.claude', 'hooks', 'spine-wrap.js');

  // Nothing after `--`: there is no command to run. The shim must not treat its own
  // misconfiguration as a policy decision.
  const out = execFileSync(process.execPath, [shim, 'ghost'], { input: '{}', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  assert.equal(typeof out, 'string', 'shim exited non-zero on its own misconfiguration');
});

test('the shim stamps the canary so foreign hooks become measurable', async () => {
  const repo = repoWithForeignHook();
  adopt.apply(repo);
  const shim = path.join(repo, '.claude', 'hooks', 'spine-wrap.js');
  const target = path.join(repo, '.claude', 'hooks', 'their-guard.js');

  execFileSync(process.execPath, [shim, 'their-guard', '--', process.execPath, target], {
    input: '{}',
    encoding: 'utf8',
  });

  const diag = await diagnose(repo);
  const live = diag.canary.hooks['their-guard'];
  assert.ok(live, 'canary cannot see the adopted foreign hook');
  assert.equal(live.verdict, 'live', 'adopted hook did not register as firing');
});

test('adopt REFUSES when the shim is not installed', () => {
  // The failure this prevents: adopt points every wrapped command at spine-wrap.js. If that file
  // is missing, the rewrite converts a repo full of working hooks into commands that cannot run —
  // and it does it to the settings file, so nothing in any test suite would catch it.
  //
  // Found by aiming this at my own repo, where the hooks include the heartbeat that keeps me
  // running between turns. It would have broken all six at once, and the plan looked perfectly
  // fine; `init` had simply never been run there.
  const repo = tmp();
  fs.mkdirSync(path.join(repo, '.claude', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'hooks', 'their-guard.js'), 'process.exit(0)');
  fs.writeFileSync(
    path.join(repo, '.claude', 'settings.local.json'),
    JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node .claude/hooks/their-guard.js' }] }] },
    })
  );

  const p = adopt.plan(repo);
  assert.ok(p.error, 'adopt proposed a rewrite with no shim on disk');
  assert.match(p.error, /spine-wrap\.js is not installed/);
  assert.deepEqual(p.changes, [], 'changes were planned despite the error');

  // And applying must be a no-op that leaves the settings file untouched.
  const before = fs.readFileSync(path.join(repo, '.claude', 'settings.local.json'), 'utf8');
  adopt.apply(repo);
  assert.equal(fs.readFileSync(path.join(repo, '.claude', 'settings.local.json'), 'utf8'), before, 'settings were modified despite the refusal');
});

test('--undo still works even if the shim was deleted', () => {
  // Someone will wrap their hooks, delete the shim, and then need out. Undo must not be gated on
  // the thing it is removing references to.
  const repo = repoWithForeignHook();
  adopt.apply(repo);
  fs.unlinkSync(path.join(repo, '.claude', 'hooks', 'spine-wrap.js'));

  const res = adopt.apply(repo, { undo: true });
  assert.equal(res.applied, 1, 'undo refused to run without the shim present');
  assert.equal(readCmd(repo).command, 'node .claude/hooks/their-guard.js');
});

test('schema audit catches the fault that silently disables EVERY hook (#75071)', async () => {
  // The filed case: one schema-invalid matcher took ~100 hooks dark for 30 hours with no warning
  // anywhere, and it "looked identical to nothing to report." Highest-consequence check here —
  // everything else degrades one guard, this takes the whole file.
  const repo = tmp();
  install(repo);
  const sp = path.join(repo, '.claude', 'settings.json');
  const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
  s.hooks.PreToolUse[0].matcher = ['Bash', 'Edit']; // array where a string belongs
  fs.writeFileSync(sp, JSON.stringify(s, null, 2));

  const diag = await diagnose(repo);
  const fatal = diag.schema.filter((f) => f.fatal);
  assert.ok(fatal.length > 0, 'an invalid matcher did not register as fatal');
  assert.match(fatal[0].where, /matcher/);
  assert.match(fatal[0].what, /must be a string/);
  assert.match(fatal[0].kills, /every hook/);
});

test('schema audit stays silent on a valid settings file', async () => {
  // The false-positive half. A schema check that fires on correct config is worse than none,
  // because the banner it prints is the loudest thing in the report.
  const repo = tmp();
  install(repo);
  const diag = await diagnose(repo);
  assert.deepEqual(
    diag.schema.filter((f) => f.fatal),
    [],
    'flagged a freshly installed, valid settings file as fatally broken'
  );
});

test('schema audit catches non-fatal faults without crying wolf', async () => {
  const repo = tmp();
  install(repo);
  const sp = path.join(repo, '.claude', 'settings.json');
  const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
  s.hooks.PreToolUse[0].hooks[0].timeout = -5;     // invalid but scoped
  s.hooks.PreToolUse[0].hooks[1].command = '';      // cannot run
  fs.writeFileSync(sp, JSON.stringify(s, null, 2));

  const diag = await diagnose(repo);
  assert.deepEqual(diag.schema.filter((f) => f.fatal), [], 'scoped faults were escalated to fatal');
  const minor = diag.schema.filter((f) => !f.fatal);
  assert.ok(minor.some((f) => /timeout/.test(f.where)), 'bad timeout not reported');
  assert.ok(minor.some((f) => /command/.test(f.where)), 'empty command not reported');
});

test('unparseable settings is reported as fatal, not swallowed', async () => {
  const repo = tmp();
  install(repo);
  fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), '{ "hooks": { oops }');
  const diag = await diagnose(repo);
  assert.ok(
    diag.schema.some((f) => f.fatal && /will not parse/.test(f.what)),
    'a settings file that will not parse was not flagged'
  );
});

test('deny audit catches 8.3 short-name bypass and the Glob wildcard hole (#78752)', async () => {
  const repo = tmp();
  install(repo);
  const sp = path.join(repo, '.claude', 'settings.json');
  const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
  // Written from disk on purpose. My first attempt at this passed the paths through a shell,
  // which ate the backslashes, so I tested the detector on "C:Program Filessecrets.txt" and
  // learned nothing. Representative input or it isn't a test.
  s.permissions.deny = [
    'Read(C:\\Program Files\\Anthropic\\secrets.txt)',
    'Read(./config/**)',
    'Read(./.env)',
    'Bash(rm -rf)',
  ];
  fs.writeFileSync(sp, JSON.stringify(s, null, 2));

  const diag = await diagnose(repo);
  const alias = diag.denyAudit.filter((f) => f.kind === '8.3-alias');
  const globHole = diag.denyAudit.filter((f) => f.kind === 'glob-not-honoured');

  assert.equal(alias.length, 1, 'the Program Files path was not flagged as 8.3-aliasable');
  assert.match(alias[0].why, /Program Files/);
  assert.equal(globHole.length, 1, 'the wildcard deny was not flagged as unenforced by Glob');

  // The quiet half: short, space-free paths and non-path rules must NOT be flagged. A security
  // audit that fires on `Read(./.env)` and `Bash(rm -rf)` gets muted, and then it protects nothing.
  assert.ok(!diag.denyAudit.some((f) => f.rule.includes('.env')), 'flagged a short path with no alias');
  assert.ok(!diag.denyAudit.some((f) => f.rule.includes('rm -rf')), 'flagged a non-path command rule');
});

test('deny audit is silent when there are no deny rules at all', async () => {
  // NOT a fresh install — the shipped template carries its own deny list, and four of those
  // rules are genuinely bypassable (wildcards Glob ignores). The audit flagging my own template
  // is correct behaviour, not a false positive, so this test needs a repo with no permissions
  // block at all. My first version of it asserted a fresh install was clean and failed, which is
  // how I found out I ship the exact hole I wrote the detector for.
  const repo = tmp();
  install(repo);
  const sp = path.join(repo, '.claude', 'settings.json');
  const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
  delete s.permissions;
  fs.writeFileSync(sp, JSON.stringify(s, null, 2));

  const diag = await diagnose(repo);
  assert.deepEqual(diag.denyAudit, [], 'invented findings from an absent deny list');
});

test('the shipped template is honest about its own bypassable deny rules', async () => {
  // Locking this in deliberately. The template denies `./**/credentials*` and `./**/*.pem`, and
  // wildcard denies are not honoured by Glob (#78752) — so those trees can still be enumerated.
  // I cannot fix that from here; it is upstream. What I can do is refuse to ship a template that
  // quietly claims protection it does not have, and fail this test the day the wording drifts.
  const repo = tmp();
  install(repo);
  const diag = await diagnose(repo);
  assert.ok(diag.denyAudit.length > 0, 'template deny rules stopped being flagged — did the audit break?');

  const template = fs.readFileSync(path.join(repo, '.claude', 'settings.json'), 'utf8');
  assert.match(
    template,
    /78752/,
    'the template must cite #78752 next to its deny list — a deny rule that can be walked past has to say so'
  );
});

test('MCP audit flags PostToolUse hooks that can never run (#73586)', async () => {
  // MCP is where the database and deploy servers live. A PostToolUse hook written to audit that
  // surface has zero coverage — and the matcher is CORRECT, which is exactly why nobody notices.
  const repo = tmp();
  install(repo);
  const sp = path.join(repo, '.claude', 'settings.json');
  const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
  s.hooks.PostToolUse = [
    { matcher: 'mcp__postgres__.*', hooks: [{ type: 'command', command: 'node .claude/hooks/audit-db.js' }] },
    { matcher: '.*', hooks: [{ type: 'command', command: 'node .claude/hooks/log-all.js' }] },
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'node .claude/hooks/native-only.js' }] },
  ];
  fs.writeFileSync(sp, JSON.stringify(s, null, 2));

  const diag = await diagnose(repo);
  const explicit = diag.mcpAudit.filter((f) => f.explicit);
  const catchAll = diag.mcpAudit.filter((f) => !f.explicit);

  assert.equal(explicit.length, 1, 'an explicit mcp__ matcher was not flagged');
  assert.equal(catchAll.length, 1, 'a catch-all matcher that reads as covering MCP was not flagged');

  // The quiet half. A PostToolUse hook scoped to a native tool is fine and must stay silent,
  // or the finding gets muted and takes the real one with it.
  assert.ok(!diag.mcpAudit.some((f) => f.matcher === 'Bash'), 'flagged a native-tool matcher');
});

test('MCP audit stays silent on PreToolUse and on a repo with no PostToolUse hooks', async () => {
  const repo = tmp();
  install(repo);
  // The shipped template registers PreToolUse + Stop only. PreToolUse DOES fire for MCP, so
  // flagging it would be a false positive on our own install.
  let diag = await diagnose(repo);
  assert.deepEqual(diag.mcpAudit, [], 'flagged something in a fresh install with no PostToolUse hooks');

  const sp = path.join(repo, '.claude', 'settings.json');
  const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
  s.hooks.PreToolUse[0].matcher = 'mcp__anything__.*';
  fs.writeFileSync(sp, JSON.stringify(s, null, 2));
  diag = await diagnose(repo);
  assert.deepEqual(diag.mcpAudit, [], 'flagged a PreToolUse MCP matcher — those DO fire');
});

test('injection audit flags hooks whose whole product is stdout (#79299)', async () => {
  // The nastiest shape of the three: the hook is correct, it IS invoked, it does its work, and
  // the work is discarded in transit. The canary cannot catch it — the stamp lands, so liveness
  // reads green. Only knowing what the hook was FOR tells you it stopped doing it.
  const repo = tmp();
  install(repo);
  const sp = path.join(repo, '.claude', 'settings.json');
  const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
  s.hooks.SessionStart = [{ hooks: [{ type: 'command', command: 'node .claude/hooks/inject-context.js' }] }];
  s.hooks.UserPromptSubmit = [{ hooks: [{ type: 'command', command: 'node .claude/hooks/add-memory.js' }] }];
  fs.writeFileSync(sp, JSON.stringify(s, null, 2));

  const diag = await diagnose(repo);
  const events = diag.injectAudit.map((f) => f.event).sort();
  assert.deepEqual(events, ['SessionStart', 'UserPromptSubmit'], 'context-injecting hooks not flagged');
  assert.match(diag.injectAudit[0].why, /79299/);

  // Must NOT flag PreToolUse/Stop — those aren't injecting context, and a finding that fires on
  // every hook in the file is a finding people scroll past.
  assert.ok(!diag.injectAudit.some((f) => f.event === 'PreToolUse'), 'flagged a PreToolUse hook');
  assert.ok(!diag.injectAudit.some((f) => f.event === 'Stop'), 'flagged a Stop hook');
});

test('injection audit is silent on a fresh install', async () => {
  // The shipped template registers PreToolUse + Stop only, so this must say nothing about it.
  const repo = tmp();
  install(repo);
  const diag = await diagnose(repo);
  assert.deepEqual(diag.injectAudit, [], 'flagged something in our own template');
});

test('adopt reports cleanly when there is nothing to do', () => {
  const repo = tmp();
  install(repo); // only our own hooks
  const p = adopt.plan(repo);
  assert.deepEqual(p.changes, [], 'proposed changes in a repo with only our hooks');
  assert.ok(!p.error, 'errored on a valid repo');
});
