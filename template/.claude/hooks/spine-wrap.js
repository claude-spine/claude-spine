#!/usr/bin/env node
'use strict';
// SPINE-WRAP — make the canary work on hooks I did not write.
//
// The hooks that matter in any real repo are the ones already there. I cannot inline a stamp
// into someone else's file — it is theirs, it changes, and editing it would be both rude and
// fragile. So instead the registered command is rewritten to route through this shim:
//
//   before:  node .claude/hooks/their-hook.js
//   after:   node .claude/hooks/spine-wrap.js their-hook -- node .claude/hooks/their-hook.js
//
// This stamps the canary, then runs their command completely unchanged and gets out of the
// way. Everything is passed straight through — stdin, stdout, stderr, exit code — because a
// wrapper that alters ANY of those breaks the hook contract, and a monitoring layer that
// breaks the thing it monitors is worse than no monitoring at all.
//
// Failure policy: if this shim cannot spawn the real command, it exits 0, not 2. Exit 2 means
// "deny the tool call" — so a broken wrapper exiting non-zero would silently start denying
// every tool call in the repo and look exactly like a deliberate policy decision
// (anthropics/claude-code#80697 is that exact collision). Fail open, loudly, on stderr.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const name = argv[0];
const cmd = sep === -1 ? [] : argv.slice(sep + 1);

// Buffer stdin before spawning: the payload is small, and reading it here means we can hand
// the identical bytes to the child even though we also needed to be first on the pipe.
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => run(Buffer.concat(chunks)));
// Some events deliver no stdin at all; do not hang waiting for an end that never comes.
setTimeout(() => { if (!started) run(Buffer.concat(chunks)); }, 250);

let started = false;

function run(input) {
  if (started) return;
  started = true;

  stamp(name);

  if (!cmd.length) {
    process.stderr.write('spine-wrap: no command given after --; nothing to run\n');
    process.exit(0);
  }

  let child;
  try {
    child = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'inherit', 'inherit'], shell: false });
  } catch (e) {
    // Fail OPEN. See the note above about exit 2 being a deny signal.
    process.stderr.write(`spine-wrap: could not run wrapped hook (${e.message}) — failing open\n`);
    process.exit(0);
  }

  child.on('error', (e) => {
    process.stderr.write(`spine-wrap: wrapped hook failed to launch (${e.message}) — failing open\n`);
    process.exit(0);
  });

  // The child's exit code is the hook's real decision. Pass it through untouched: 2 must stay
  // 2, or wrapping a working guard would quietly disarm it.
  child.on('close', (code, signal) => process.exit(signal ? 0 : code ?? 0));

  child.stdin.end(input);
}

function stamp(hookName) {
  if (process.env.CLAUDE_SPINE_HARNESS) return;
  try {
    const f = path.join(__dirname, '.last-fired.json');
    let all = {};
    try { all = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
    all[hookName] = { at: Date.now(), n: (all[hookName] && all[hookName].n || 0) + 1, wrapped: true };
    fs.writeFileSync(f, JSON.stringify(all));
  } catch {}
}
