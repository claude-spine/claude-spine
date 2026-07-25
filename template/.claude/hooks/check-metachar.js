#!/usr/bin/env node
'use strict';
// PATTERN 3 — THE METACHAR GUARD  (PreToolUse)
//
// Shells interpret characters. When an agent builds a message containing $, backticks,
// quotes or ! and hands it to Bash as an argument, the shell rewrites the content before
// the command ever sees it. The message arrives mangled — or, with backticks, the embedded
// text EXECUTES.
//
// The fix is always the same: content to a file, filename on the command line. This hook
// warns when a call looks like it is about to lose data, and stays quiet otherwise.
//
// Registered as PreToolUse. Exits 0 with a message on stdout — a warning, not a block,
// because there are legitimate reasons to interpolate and the agent should decide.

const CHUNK = [];
process.stdin.on('data', (d) => CHUNK.push(d));
process.stdin.on('end', () => {
  __stamp('check-metachar');
  let input;
  try {
    input = JSON.parse(Buffer.concat(CHUNK).toString('utf8') || '{}');
  } catch {
    process.exit(0); // never break a tool call over a parse failure
  }
  if (input.tool_name !== 'Bash') process.exit(0);

  const cmd = String(input.tool_input?.command ?? '');
  if (!cmd) process.exit(0);

  const { segments, skeleton } = scan(cmd);

  // The correct pattern is already in use — content is on disk, filename on the command
  // line. Say nothing.
  //
  // This test runs against the SKELETON (the command with all quoted bodies removed), not
  // the raw string. Testing the raw string means a payload that merely mentions "--file"
  // silences the guard for its own command — the hook stays installed, reports nothing,
  // and protects nothing. That is the exact failure this tool exists to surface, and it
  // was in here first.
  if (/--file[= ]/.test(skeleton) || /<\s*\S+\.(txt|md|json)\b/.test(skeleton)) process.exit(0);

  const hits = [];
  for (const seg of segments) {
    if (seg.quote === "'") continue; // single quotes are literal in POSIX; nothing expands
    // $ followed by a DIGIT matters as much as $ followed by a letter: $4 is a positional
    // parameter, so a price like "$49" expands to empty and the 9 arrives alone. That is
    // the single most common real-world case — every price, every dollar figure in copy —
    // and a letters-only pattern sails straight past it.
    if (/\$[\w{(*@?#!]/.test(seg.body)) hits.push('$ expansion');
    if (/`[^`]*`/.test(seg.body)) hits.push('backtick command substitution');
    if (/\$\(/.test(seg.body)) hits.push('$( ) command substitution');
    if (/!!|!\d/.test(seg.body)) hits.push('! history expansion');
    if (seg.quote === '"' && /'/.test(seg.body)) hits.push("apostrophe inside double quotes");
    if (/\\[nt]/.test(seg.body)) hits.push('escape sequence');
  }

  if (!hits.length) process.exit(0);

  const unique = [...new Set(hits)];
  console.log(
    `METACHAR GUARD: this Bash argument contains ${unique.join(', ')}. ` +
      `The shell will rewrite it before the command runs. ` +
      `Write the content with the Write tool to a temp file, then pass --file <path> instead.`
  );
  process.exit(0);
});

/**
 * Single pass over the command, producing both things this hook needs:
 *
 *   segments  each quoted run, with the quote character that opened it — the payload
 *   skeleton  the command with every quoted body removed — the actual shell structure
 *
 * A regex cannot do this correctly; quotes nest and escape. And the two views must come
 * from the same walk, because deciding "is this already using --file" against the payload
 * instead of the structure is what silently disarmed this guard the first time.
 */
function scan(cmd) {
  const segments = [];
  let skeleton = '';
  let quote = null;
  let body = '';
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === '\\' && quote === '"') {
        body += c + (cmd[++i] ?? '');
        continue;
      }
      if (c === quote) {
        segments.push({ quote, body });
        skeleton += quote + quote; // keep the quoting visible, drop the contents
        quote = null;
        body = '';
        continue;
      }
      body += c;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else {
      skeleton += c;
    }
  }
  if (quote) segments.push({ quote, body }); // unterminated quote: inspect it anyway
  return { segments, skeleton };
}

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
