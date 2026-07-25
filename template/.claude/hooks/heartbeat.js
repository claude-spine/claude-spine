#!/usr/bin/env node
'use strict';
// PATTERN 2 — THE HEARTBEAT  (Stop)
//
// A coding agent has no clock and no inbox. Between turns it is not waiting, it is simply
// not running, so it cannot know that the build finished, that twenty minutes went by, or
// that someone replied. Everything it "knows" about the outside world came in through the
// last message a human typed.
//
// The Stop hook is the seam. It fires when a turn ends, and whatever it prints becomes
// context for the next one. So: print the time, print how stale the session state is, and
// drain a signals file that ANY external process can append to — CI, a deploy script, a
// webhook, a chat bridge. One line each. This is the difference between an agent that asks
// "did the tests finish?" and one that already knows.
//
// Keep it cheap. It runs on every single turn.

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
__stamp('heartbeat');
const REPO = path.dirname(path.dirname(HERE));
const out = [];

// ── time ────────────────────────────────────────────────────────────────────────
const now = new Date();
const h = now.getHours();
const part =
  h < 5 ? 'the small hours' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 22 ? 'evening' : 'late';
out.push(`[${now.toLocaleTimeString()}] ${part}, ${now.toLocaleDateString(undefined, { weekday: 'long' })}`);

// ── session state staleness ─────────────────────────────────────────────────────
// Cheap proxy for "am I about to lose the thread." Four hours is roughly a work block.
const stateFile = path.join(REPO, '.claude', 'state.md');
if (fs.existsSync(stateFile)) {
  const ageH = (Date.now() - fs.statSync(stateFile).mtimeMs) / 3.6e6;
  if (ageH > 4) out.push(`[state] .claude/state.md is ${Math.round(ageH)}h old — refresh it before you lose the thread.`);
} else {
  out.push('[state] no .claude/state.md yet — create it so the next session starts mid-thought.');
}

// ── external signals ────────────────────────────────────────────────────────────
// Anything can write here:  echo '{"text":"CI green on main"}' >> .claude/hooks/signals.jsonl
// Consumed by byte offset so nothing is ever replayed, and the file is never rewritten
// in place — rewriting an offset-consumed queue re-delivers the entire backlog, which is
// a mistake you only make once.
const sigFile = path.join(HERE, 'signals.jsonl');
const offFile = path.join(HERE, '.signals.offset');
try {
  if (fs.existsSync(sigFile)) {
    const size = fs.statSync(sigFile).size;
    let off = 0;
    if (fs.existsSync(offFile)) off = parseInt(fs.readFileSync(offFile, 'utf8'), 10) || 0;
    if (off > size) off = 0; // file was truncated or rotated
    if (size > off) {
      const fd = fs.openSync(sigFile, 'r');
      const buf = Buffer.alloc(size - off);
      fs.readSync(fd, buf, 0, buf.length, off);
      fs.closeSync(fd);
      for (const line of buf.toString('utf8').split('\n').filter(Boolean)) {
        try {
          const s = JSON.parse(line);
          out.push(`[signal] ${s.text ?? line}`);
        } catch {
          out.push(`[signal] ${line}`);
        }
      }
      fs.writeFileSync(offFile, String(size));
    }
  }
} catch {
  // A broken signal queue must never break a turn.
}

if (out.length) console.log(out.join('\n'));

// ── CANARY ──────────────────────────────────────────────────────────────────────
// Stamp every invocation. This is how `claude-spine doctor` can tell the difference
// between "this guard is correct" and "this guard is actually being called" — the
// second being what 467 open upstream issues are really about. Inlined rather than
// required, because these hooks stay dependency-free and live in YOUR repo.
function __stamp(name) {
  // A synthetic invocation must NOT count as the hook having fired. `claude-spine doctor`
  // spawns these hooks to run its fixtures, so without this guard the act of checking
  // liveness refreshes it — the canary would report every repo healthy forever, including one
  // whose hooks have been dead for a week. Measuring the thing must not change the thing.
  //
  // (This very comment lost the word `doctor` to shell command substitution when it was first
  // written through a bash heredoc. Pattern 3, in the file that implements Pattern 3.)
  if (process.env.CLAUDE_SPINE_HARNESS) return;
  try {
    const fs = require('fs'), path = require('path');
    const f = path.join(__dirname, '.last-fired.json');
    let all = {};
    try { all = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
    all[name] = { at: Date.now(), n: (all[name] && all[name].n || 0) + 1 };
    fs.writeFileSync(f, JSON.stringify(all));
  } catch {}
}
