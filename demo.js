#!/usr/bin/env node
'use strict';
// DEMO — generate the whole story as one terminal transcript.
//
// Not a screencast. A transcript, because a transcript pastes into a README, a reddit post, an
// HN comment and a chat message without re-recording anything, and it can be regenerated the
// moment the tool changes so the marketing can never drift from the behaviour.
//
// Everything below is really executed in a throwaway directory. Nothing is staged, nothing is
// typed by hand. If the tool regresses, this output changes — which is the point.
//
//   node demo.js            print the transcript
//   node demo.js --md       wrap it in a fenced block for pasting

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLI = path.join(__dirname, 'bin', 'cli.js');
const md = process.argv.includes('--md');
const out = [];

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-demo-'));
const run = (args, opts = {}) => {
  try {
    return execFileSync(process.execPath, [CLI, ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });
  } catch (e) {
    // doctor exits non-zero when it finds gaps — that is a result, not a failure.
    return (e.stdout || '') + (e.stderr || '');
  }
};

const say = (s = '') => out.push(s);
const cmd = (c) => say(`$ ${c}`);
const body = (s) => say(s.replace(/\s+$/, ''));

// ── 1. install ──────────────────────────────────────────────────────────────────
cmd('npx claude-spine init');
body(run(['init']).split('\n').filter((l) => l.startsWith('  +') || l.includes('verifying')).join('\n'));
say();

// ── 1b. the worst one, and it leads ─────────────────────────────────────────────
// One schema-invalid matcher disables EVERY hook in the file, silently (#75071). This goes
// first because it is the highest-consequence check and because it is the clearest possible
// statement of what separates this from a schema linter: the file is valid JSON.
say('# someone puts an array where a string belongs. one character of intent, no typo warning.');
{
  const sp = path.join(repo, '.claude', 'settings.json');
  const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
  s.hooks.PreToolUse[0].matcher = ['Bash', 'Edit'];
  fs.writeFileSync(sp, JSON.stringify(s, null, 2));
}
cmd('claude-spine doctor');
{
  const d = run(['doctor']);
  const lines = d.split('\n');
  const i = lines.findIndex((l) => /EVERY HOOK/.test(l));
  body(lines.slice(i, i + 5).join('\n'));
  // put it back so the rest of the story runs against a valid file
  const sp = path.join(repo, '.claude', 'settings.json');
  const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
  s.hooks.PreToolUse[0].matcher = 'Bash';
  fs.writeFileSync(sp, JSON.stringify(s, null, 2));
}
say();
say('# that file is valid JSON. every key spelled right. a schema linter passes it.');
say('# ~100 hooks went dark for 30 hours on that exact fault (#75071).');
say();

// ── 2. a guard that is registered, valid, present — and does nothing ─────────────
say('# a guard goes quietly dead. valid JSON, correct event name, file on disk.');
fs.writeFileSync(
  path.join(repo, '.claude', 'hooks', 'check-metachar.js'),
  'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));'
);
cmd('claude-spine doctor');
body(run(['doctor']).split('\n').slice(2, 14).join('\n'));
say();

// ── 3. a foreign hook, adopted ──────────────────────────────────────────────────
say('# the hooks that matter are the ones already in your repo. adopt them.');
fs.writeFileSync(
  path.join(repo, '.claude', 'hooks', 'their-guard.js'),
  'const c=[];process.stdin.on("data",d=>c.push(d));process.stdin.on("end",()=>process.exit(0));'
);
fs.writeFileSync(
  path.join(repo, '.claude', 'settings.local.json'),
  JSON.stringify(
    { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node .claude/hooks/their-guard.js', timeout: 5 }] }] } },
    null,
    2
  )
);
cmd('claude-spine adopt --dry-run');
body(run(['adopt', '--dry-run']).split('\n').filter((l) => l.trim()).slice(0, 5).join('\n'));
say();
run(['adopt']);

// ── 4. the canary: is it being CALLED? ──────────────────────────────────────────
say('# now fire the adopted hook once for real, then let it go stale.');
const shim = path.join(repo, '.claude', 'hooks', 'spine-wrap.js');
const target = path.join(repo, '.claude', 'hooks', 'their-guard.js');
execFileSync(process.execPath, [shim, 'their-guard', '--', process.execPath, target], { input: '{}', encoding: 'utf8' });

const stampFile = path.join(repo, '.claude', 'hooks', '.last-fired.json');
const stamps = JSON.parse(fs.readFileSync(stampFile, 'utf8'));
for (const k of Object.keys(stamps)) stamps[k].at = Date.now() - 5 * 86400_000;
fs.writeFileSync(stampFile, JSON.stringify(stamps));

cmd('claude-spine doctor');
const d = run(['doctor']);
// Find the canary VERDICT line specifically — matching any line containing the word grabs the
// adopt blurb further up and slices the punchline off.
const lines = d.split('\n');
const start = lines.findIndex((l) => /^\s{2}canary\s/.test(l));
const block = [];
for (let i = start; i < lines.length && start !== -1; i++) {
  if (i > start && lines[i].trim() === '') break;
  block.push(lines[i]);
}
body(block.join('\n'));
say();
say('# every fixture above still passes. the guards are correct.');
say('# they just have not run in five days, and nothing else on earth tells you that.');

try { fs.rmSync(repo, { recursive: true, force: true }); } catch {}

const text = out.join('\n');
process.stdout.write(md ? '```console\n' + text + '\n```\n' : text + '\n');
