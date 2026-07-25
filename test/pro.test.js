'use strict';
// Tests for the paid surface. These exist because "I ran it once in a temp directory and it
// looked right" and "there is a check that fails the day it breaks" are different claims,
// and this product's entire argument is that the difference matters.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const { install } = require('../lib/init');
const { diagnose } = require('../lib/doctor');
const custom = require('../lib/custom');
const license = require('../lib/license');
const { REPORTERS } = require('../lib/reporters');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'cli.js');
const SIGNER = path.join(ROOT, 'sign-license.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'spine-pro-'));

/** Sign a key with the real signer, the way fulfilment actually will. */
function mintKey(name, extra = []) {
  const out = execFileSync(process.execPath, [SIGNER, name, ...extra], { cwd: ROOT, encoding: 'utf8' });
  const key = out.split('\n').map((l) => l.trim()).find((l) => l.startsWith('CS1.'));
  assert.ok(key, 'signer produced no key');
  return key;
}

test('a signed key verifies and carries its claims', () => {
  const key = mintKey('acme corp', ['--plan', 'pro', '--seats', '7', '--days', '365']);
  const res = license.parse(key);
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.payload.sub, 'acme corp');
  assert.equal(res.payload.seats, 7);
  assert.equal(res.plan, 'pro');
  assert.equal(res.expired, false);
});

test('a tampered payload fails verification', () => {
  const key = mintKey('acme corp');
  const [prefix, body, sig] = key.split('.');
  // Rewrite the customer name, keep the original signature.
  const forged = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  forged.sub = 'someone else';
  forged.seats = 9999;
  const badBody = Buffer.from(JSON.stringify(forged)).toString('base64url');
  const res = license.parse(`${prefix}.${badBody}.${sig}`);
  assert.equal(res.ok, false, 'a forged payload verified — the whole scheme is broken');
});

test('a key signed by a different keypair is rejected', () => {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const body = Buffer.from(JSON.stringify({ sub: 'pirate', plan: 'pro' })).toString('base64url');
  const sig = crypto.sign(null, Buffer.from(body), privateKey).toString('base64url');
  const res = license.parse(`CS1.${body}.${sig}`);
  assert.equal(res.ok, false, 'a self-signed key was accepted');
});

test('malformed keys are refused without throwing', () => {
  for (const bad of ['', 'nonsense', 'CS1.only-two', 'CS9.a.b', 'CS1.!!!.!!!']) {
    const res = license.parse(bad);
    assert.equal(res.ok, false, `accepted ${JSON.stringify(bad)}`);
    assert.ok(res.reason, 'no reason given');
  }
});

test('an expired key degrades to free instead of failing hard', () => {
  const key = mintKey('lapsed customer', ['--days', '-1']);
  const res = license.parse(key);
  // Still genuine — that matters. It just no longer grants pro.
  assert.equal(res.ok, true, 'expired key should still verify as authentic');
  assert.equal(res.expired, true);
  assert.equal(res.plan, 'free', 'expired key must fall back to free, not break the build');
});

test('a key in the repo is found; env var takes priority', () => {
  const repo = tmp();
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  const repoKey = mintKey('repo customer');
  fs.writeFileSync(path.join(repo, '.claude', 'spine-license'), repoKey + '\n');

  assert.equal(license.check(repo).sub, 'repo customer');

  const envKey = mintKey('env customer');
  process.env.CLAUDE_SPINE_KEY = envKey;
  try {
    assert.equal(license.check(repo).sub, 'env customer', 'env var should win');
  } finally {
    delete process.env.CLAUDE_SPINE_KEY;
  }
});

test('custom fixtures load and are graded like core ones', async () => {
  const repo = tmp();
  install(repo);
  const dir = path.join(repo, 'spine-fixtures');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'deploy.json'),
    JSON.stringify([
      {
        id: 'deploy/nuke-prod',
        hook: 'ratchet',
        command: 'rm -rf /srv/prod/data',
        expect: 'block',
        why: 'A real incident would go here.',
      },
      {
        id: 'deploy/safe-status',
        hook: 'ratchet',
        command: 'git status',
        expect: 'silent',
        why: 'The harmless twin.',
      },
    ])
  );

  const { fixtures, errors } = custom.load(dir);
  assert.deepEqual(errors, []);
  assert.equal(fixtures.length, 2);

  const diag = await diagnose(repo, { extra: fixtures });
  const ids = diag.results.map((r) => r.id);
  assert.ok(ids.includes('deploy/nuke-prod'), 'custom fixture was not run');

  const mine = diag.results.filter((r) => r.custom);
  assert.equal(mine.length, 2);
  assert.ok(mine.every((r) => r.verdict === 'pass'), 'shipped hooks failed a reasonable custom fixture');
});

test('bad fixtures are reported, never silently dropped', () => {
  const dir = tmp();
  fs.writeFileSync(
    path.join(dir, 'broken.json'),
    JSON.stringify([
      { id: 'no-hook', expect: 'block', command: 'x', why: 'y' },
      { id: 'bad-hook', hook: 'nonsense', expect: 'block', command: 'x', why: 'y' },
      { id: 'bad-expect', hook: 'ratchet', expect: 'maybe', command: 'x', why: 'y' },
      { id: 'no-command', hook: 'ratchet', expect: 'block', why: 'y' },
      { id: 'no-why', hook: 'ratchet', expect: 'block', command: 'x' },
      { hook: 'ratchet', expect: 'block', command: 'x', why: 'y' },
    ])
  );
  const { fixtures, errors } = custom.load(dir);
  assert.equal(fixtures.length, 0, 'an invalid fixture was accepted');
  assert.equal(errors.length, 6, `expected 6 errors, got ${errors.length}: ${errors.join(' | ')}`);
});

test('duplicate fixture ids are caught across files', () => {
  const dir = tmp();
  const one = [{ id: 'same/id', hook: 'ratchet', expect: 'block', command: 'rm -rf /', why: 'a' }];
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify(one));
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify(one));
  const { errors } = custom.load(dir);
  assert.ok(errors.some((e) => /duplicate id/.test(e)), 'shadowed fixture id went unreported');
});

test('reporters emit well-formed output for a failing repo', async () => {
  const repo = tmp();
  install(repo);
  // Break a guard on purpose so there is a MISS to report.
  fs.writeFileSync(path.join(repo, '.claude', 'hooks', 'check-metachar.js'), 'process.exit(0);');
  const diag = await diagnose(repo);
  assert.ok(diag.counts.MISS > 0, 'sabotaged hook did not register as a MISS');

  const xml = REPORTERS.junit(diag);
  assert.match(xml, /^<\?xml version="1\.0"/);
  assert.match(xml, /<failure type="MISS"/);
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(xml), 'unescaped ampersand in JUnit output');
  assert.equal((xml.match(/<testcase/g) || []).length, diag.results.length);

  const gha = REPORTERS.github(diag);
  assert.match(gha, /^::error title=claude-spine MISS/m);

  const tap = REPORTERS.tap(diag);
  assert.match(tap, /^TAP version 13/);
  assert.match(tap, /^not ok /m);
});

test('canary distinguishes a correct hook from a hook that is being called', async () => {
  const repo = tmp();
  install(repo);
  const hooksDir = path.join(repo, '.claude', 'hooks');
  const fire = (name) =>
    execFileSync(process.execPath, [path.join(hooksDir, name)], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status' } }),
      encoding: 'utf8',
    });

  // Nothing has run yet: registered, valid, and never invoked.
  let diag = await diagnose(repo);
  assert.equal(diag.canary.verdict, 'unknown', 'a repo with no canary data should say so, not claim health');

  fire('permission-ratchet.js');
  fire('check-metachar.js');
  diag = await diagnose(repo);
  assert.equal(diag.canary.hooks['permission-ratchet'].verdict, 'live');
  assert.equal(diag.canary.hooks['heartbeat'].verdict, 'NEVER FIRED', 'a hook that never ran must not read as live');
  assert.equal(diag.canary.verdict, 'gaps');
});

test('running doctor does NOT refresh the canary — measuring must not change the thing', async () => {
  const repo = tmp();
  install(repo);
  const hooksDir = path.join(repo, '.claude', 'hooks');
  const stampFile = path.join(hooksDir, '.last-fired.json');

  execFileSync(process.execPath, [path.join(hooksDir, 'permission-ratchet.js')], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status' } }),
    encoding: 'utf8',
  });

  // Backdate well past the staleness threshold.
  const stamps = JSON.parse(fs.readFileSync(stampFile, 'utf8'));
  const fiveDaysAgo = Date.now() - 5 * 86400_000;
  for (const k of Object.keys(stamps)) stamps[k].at = fiveDaysAgo;
  fs.writeFileSync(stampFile, JSON.stringify(stamps));

  // diagnose() SPAWNS every hook to run its fixtures. Without the CLAUDE_SPINE_HARNESS guard
  // those spawns count as real invocations, the stamps refresh, and the canary reports every
  // repo healthy forever — including one whose hooks have been dead for a week. This is the
  // regression test for that, because the bug returns the day someone deletes one env line.
  const diag = await diagnose(repo);

  assert.equal(diag.canary.hooks['permission-ratchet'].verdict, 'STALE', 'doctor refreshed the canary it was measuring');
  assert.ok(diag.canary.hooks['permission-ratchet'].ageHours > 100, 'stamp age was reset by the harness');

  const after = JSON.parse(fs.readFileSync(stampFile, 'utf8'));
  assert.equal(after['permission-ratchet'].at, fiveDaysAgo, 'the harness wrote to the stamp file');
});

test('the canary is actually present in the diagnosis payload', async () => {
  // It was computed and left out of the return object for an hour: the canary ran, reached a
  // verdict, and reported to nobody while the summary said all checks pass. Exactly the
  // failure it exists to catch. This asserts it stays wired.
  const repo = tmp();
  install(repo);
  const diag = await diagnose(repo);
  assert.ok(diag.canary, 'diagnosis has no canary field');
  assert.ok(Array.isArray(diag.canary.registered));
  assert.ok(diag.canary.registered.includes('permission-ratchet'), 'canary cannot see the registered hooks');
});

test('CLI refuses --fixtures without a licence and exits non-zero', () => {
  const repo = tmp();
  install(repo);
  let code = 0;
  let out = '';
  try {
    out = execFileSync(process.execPath, [CLI, 'doctor', '--fixtures', 'spine-fixtures'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_SPINE_KEY: '' },
    });
  } catch (e) {
    code = e.status;
    out = (e.stdout || '') + (e.stderr || '');
  }
  assert.notEqual(code, 0, 'unlicensed pro flag should exit non-zero');
  assert.match(out, /claude-spine pro/, 'no upsell shown');
});

test('CLI accepts --fixtures with a valid licence', () => {
  const repo = tmp();
  install(repo);
  const dir = path.join(repo, 'spine-fixtures');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'x.json'),
    JSON.stringify([{ id: 'x/ok', hook: 'ratchet', expect: 'silent', command: 'git status', why: 'z' }])
  );

  const out = execFileSync(process.execPath, [CLI, 'doctor', '--fixtures', 'spine-fixtures', '--reporter', 'tap'], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_SPINE_KEY: mintKey('paying customer') },
  });
  assert.match(out, /x\/ok/, 'custom fixture did not run under a valid licence');
});
