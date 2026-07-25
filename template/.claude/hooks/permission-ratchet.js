#!/usr/bin/env node
'use strict';
// PATTERN 6 — THE PERMISSION RATCHET  (PreToolUse)
//
// Allowlists solve the wrong half of the problem. They stop the prompts for safe reads,
// which is good, and then people widen them — `Bash(*)`, or a blanket allow — because the
// prompting is exhausting. The ratchet is the other jaw: a small, explicit DENY list of
// irreversible operations that no amount of allowlist widening can open.
//
// Note the split. The metachar guard WARNS, because the agent should judge. This one DENIES,
// because by the time a warning is read the delete has happened. It denies via JSON on stdout
// with exit 0 — see the long note at the deny site for why exit 2 is the wrong mechanism.
//
// The deny set is deliberately short. Every entry is something you cannot undo from
// inside the repo. Resist adding merely-annoying commands — a long deny list gets
// replaced by no deny list.

const CHUNK = [];
process.stdin.on('data', (d) => CHUNK.push(d));
process.stdin.on('end', () => {
  __stamp('permission-ratchet');
  let input;
  try {
    input = JSON.parse(Buffer.concat(CHUNK).toString('utf8') || '{}');
  } catch {
    process.exit(0);
  }
  if (input.tool_name !== 'Bash') process.exit(0);

  const cmd = String(input.tool_input?.command ?? '');
  if (!cmd) process.exit(0);

  for (const rule of RULES) {
    if (rule.test.test(cmd)) {
      // DENY VIA JSON ON STDOUT, EXIT 0 — not exit 2.
      //
      // Both are documented, and they are mutually exclusive: exit 2 makes Claude Code read
      // stderr and DISCARD stdout entirely, so you cannot belt-and-brace this. You pick one.
      //
      // Exit 2 is the wrong pick. It is confirmed not to block on Windows
      // (anthropics/claude-code#80039), which means a ratchet built on it reports itself
      // installed, healthy, and green while every `rm -rf` sails straight through. The JSON
      // form is the documented preferred path and it is the one that actually lands.
      //
      // Older runtimes that do not parse this see exit 0 with no decision and fall through
      // to the normal permission flow — the user still gets the prompt. That is a weaker
      // floor than a hard block and it is stated plainly in the README rather than papered
      // over, because a guard whose limits are undocumented is how people end up trusting
      // one that isn't there.
      const reason = `${rule.why}. ${rule.instead}`;
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `PERMISSION RATCHET — ${reason}`,
          },
        })
      );
      process.exit(0);
    }
  }
  process.exit(0);
});

const RULES = [
  {
    // -rf / -fr / -r -f, in any order, with or without a path
    test: /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*\s+-[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*\s+-[a-zA-Z]*[rR]|-[a-zA-Z]*[rRf]{2,}[a-zA-Z]*)\b/,
    why: 'recursive force delete',
    instead: 'Delete specific paths without -r, or ask the user to run it themselves.',
  },
  {
    test: /\bgit\s+push\b[^\n]*(--force\b(?!-with-lease)|(?:^|\s)-f(?:\s|$))/,
    why: 'force push overwrites upstream history and cannot be recovered from the local repo',
    instead: 'Use --force-with-lease, or push a new branch and open a PR.',
  },
  {
    test: /\bgit\s+reset\s+--hard\b/,
    why: 'hard reset discards uncommitted work with no recovery path',
    instead: 'git stash first, or commit to a scratch branch.',
  },
  {
    test: /\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE|DELETE\s+FROM\s+\w+\s*;)/i,
    why: 'destructive SQL routed through a shell call',
    instead: 'Run schema changes through a reviewed migration, not an ad-hoc shell command.',
  },
  {
    test: /\bgit\s+(branch\s+-D|push\s+\S+\s+--delete|push\s+\S+\s+:\S)/,
    why: 'branch deletion (local -D discards unmerged commits; remote delete affects others)',
    instead: 'Confirm the branch is merged, then let the user delete it.',
  },
  {
    test: /\bchmod\s+(-R\s+)?777\b/,
    why: 'world-writable permissions',
    instead: 'Set the narrowest mode that works — 644 for files, 755 for directories.',
  },
  {
    test: /\bcurl\b[^\n]*\|\s*(sudo\s+)?(ba)?sh\b/,
    why: 'piping a downloaded script straight into a shell executes unreviewed remote code',
    instead: 'Download it, read it, then run it.',
  },
];

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
