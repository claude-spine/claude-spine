#!/usr/bin/env node
'use strict';
// PATTERN 7 — VERIFY BEFORE SHIP  (PreToolUse)
//
// The dominant failure mode of a coding agent is not writing bad code. It is asserting
// something it did not check: "all tests pass" (never ran them), "updated five files"
// (opened two), "the endpoint returns 200" (inferred from the handler). The assertion is
// fluent and confident, which is exactly why it survives review.
//
// This hook catches the moment a claim is about to become permanent — a commit message, a
// PR body, a release note — and asks whether the claim was verified in THIS session.
// It cannot know the answer. It does not need to. Naming the claim out loud is enough;
// the agent either has the receipt or notices it doesn't.
//
// Warns (exit 0). Never blocks — a false positive that stops a commit is worse than a
// prompt the agent answers in one line.

const CHUNK = [];
process.stdin.on('data', (d) => CHUNK.push(d));
process.stdin.on('end', () => {
  __stamp('verify-claims');
  let input;
  try {
    input = JSON.parse(Buffer.concat(CHUNK).toString('utf8') || '{}');
  } catch {
    process.exit(0);
  }
  if (input.tool_name !== 'Bash') process.exit(0);

  const cmd = String(input.tool_input?.command ?? '');
  if (!isPermanentClaim(cmd)) process.exit(0);

  const body = claimBody(cmd);
  if (!body) process.exit(0);

  const flags = [];

  // Many files named at once — the classic "I refactored all of these" overreach.
  const files = body.match(/\b[\w.-]+\/?[\w.-]*\.(ts|tsx|js|jsx|py|go|rs|java|rb|php|md|json|ya?ml|sql)\b/g);
  if (files && new Set(files).size > 3) {
    flags.push(`names ${new Set(files).size} files — confirm each was actually read or edited this session`);
  }

  // Verification language. If the words are in the message, the command should be in the log.
  const claims = [
    [/\b(all|every)\s+tests?\s+(pass|passing|green)\b/i, 'claims tests pass — was the suite actually run?'],
    [/\btests?\s+(pass|passing|green)\b/i, 'claims tests pass — was the suite actually run?'],
    [/\bverified\b/i, 'says "verified" — verified by what command?'],
    [/\bno\s+regressions?\b/i, 'claims no regressions — against what baseline?'],
    [/\b(fully|now)\s+working\b/i, 'claims it works — was it exercised end to end?'],
    [/\bfixes\s+#\d+/i, 'claims a fix closes an issue — was the reported case reproduced, then re-run?'],
    [/\bbenchmark|(\d+)%\s+faster/i, 'quotes a performance number — from a measurement, or an estimate?'],
  ];
  for (const [re, msg] of claims) {
    if (re.test(body)) {
      flags.push(msg);
      break; // one verification nag is plenty
    }
  }

  if (!flags.length) process.exit(0);

  console.log(
    'VERIFY BEFORE SHIP — this is about to become permanent:\n' +
      flags.map((f) => `  · ${f}`).join('\n') +
      '\n  If you have the receipt, proceed. If it came from memory, check it first.'
  );
  process.exit(0);
});

/** Commands that write a claim somewhere durable. */
function isPermanentClaim(cmd) {
  return (
    /\bgit\s+commit\b/.test(cmd) ||
    /\bgh\s+(pr|release|issue)\s+(create|comment|edit)\b/.test(cmd) ||
    /\bgit\s+tag\b.*-m/.test(cmd)
  );
}

/** Pull the human-written text out of -m / --body, whichever form it took. */
function claimBody(cmd) {
  const patterns = [
    /-m\s+"((?:[^"\\]|\\.)*)"/s,
    /-m\s+'([^']*)'/s,
    /--body\s+"((?:[^"\\]|\\.)*)"/s,
    /--body\s+'([^']*)'/s,
    /--body-file\s+(\S+)/,
  ];
  for (const p of patterns) {
    const m = cmd.match(p);
    if (m) return m[1];
  }
  // Heredoc form: git commit -m "$(cat <<'EOF' ... EOF)"
  const heredoc = cmd.match(/<<'?EOF'?\s*([\s\S]*?)\s*EOF/);
  return heredoc ? heredoc[1] : null;
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
