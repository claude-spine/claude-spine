'use strict';
// FIXTURES — the known-bad inputs.
//
// This file is the actual product. Anyone can copy a hook config off a blog post;
// nobody can tell you whether theirs FIRES. Each fixture is a real payload shaped
// exactly like what Claude Code hands a hook on stdin, drawn from a failure that
// actually happened. `doctor` feeds these to whatever hooks a repo has installed
// and reports which ones the repo would have caught.
//
// A fixture is: { id, pattern, tool, input, expect: 'block'|'warn'|'silent', why }
//   block  — the hook must exit non-zero (deny the call)
//   warn   — the hook must emit something on stdout (surface it to the agent)
//   silent — the hook must NOT fire; this is the false-positive check
//
// The silent cases matter as much as the loud ones. A guard that screams at every
// Bash call gets switched off inside a week, and then it protects nothing.

/** Shape a PreToolUse payload the way Claude Code delivers it. */
function preTool(tool_name, tool_input) {
  return { hook_event_name: 'PreToolUse', tool_name, tool_input, cwd: process.cwd() };
}

const FIXTURES = [
  // ── Pattern 3: metachar guard ──────────────────────────────────────────────
  {
    id: 'metachar/dollar-in-quotes',
    pattern: 3,
    hook: 'metachar',
    input: preTool('Bash', {
      command: `node tools/say.js "the tier is $49 and the flag is --file" 1522128060013350973`,
    }),
    expect: 'warn',
    why: 'Unescaped $49 inside double quotes. The shell expands $4 to empty and the price arrives as "9".',
  },
  {
    id: 'metachar/backtick-substitution',
    pattern: 3,
    hook: 'metachar',
    input: preTool('Bash', {
      command: 'gh pr comment 12 --body "run `npm test` before merging"',
    }),
    expect: 'warn',
    why: 'Backticks inside the argument are command substitution. `npm test` executes and its output is pasted into the comment.',
  },
  {
    id: 'metachar/history-expansion',
    pattern: 3,
    hook: 'metachar',
    input: preTool('Bash', {
      command: `echo "it broke!! here's why" > notes.txt`,
    }),
    expect: 'warn',
    why: 'Apostrophe inside double quotes plus !! history expansion. Two separate ways for this to arrive mangled.',
  },
  {
    id: 'metachar/clean-file-flag',
    pattern: 3,
    hook: 'metachar',
    input: preTool('Bash', {
      command: 'node tools/say.js --file /tmp/msg.txt 1522128060013350973',
    }),
    expect: 'silent',
    why: 'This is the correct pattern — content on disk, filename on the command line. Must not warn.',
  },
  {
    id: 'metachar/plain-command',
    pattern: 3,
    hook: 'metachar',
    input: preTool('Bash', { command: 'npm test' }),
    expect: 'silent',
    why: 'False-positive check. A guard that fires on `npm test` gets disabled by Friday.',
  },

  // ── Pattern 7: verify-before-ship ──────────────────────────────────────────
  {
    id: 'verify/unread-file-claims',
    pattern: 7,
    hook: 'verify',
    input: preTool('Bash', {
      command: `git commit -m "refactor auth: update login.ts, session.ts, token.ts, middleware.ts, guard.ts"`,
    }),
    expect: 'warn',
    why: 'Five files named in one message. The common failure is asserting changes to files never opened this session.',
  },
  {
    id: 'verify/single-file-commit',
    pattern: 7,
    hook: 'verify',
    input: preTool('Bash', { command: `git commit -m "fix typo in README"` }),
    expect: 'silent',
    why: 'Ordinary commit. Must not warn.',
  },

  // ── Pattern 6: permission ratchet ──────────────────────────────────────────
  {
    id: 'ratchet/rm-rf',
    pattern: 6,
    hook: 'ratchet',
    input: preTool('Bash', { command: 'rm -rf ./build ./dist' }),
    expect: 'block',
    why: 'Recursive force delete. Should be denied outright, not warned about — by the time the agent reads a warning the tool has run.',
  },
  {
    id: 'ratchet/force-push',
    pattern: 6,
    hook: 'ratchet',
    input: preTool('Bash', { command: 'git push --force origin main' }),
    expect: 'block',
    why: 'Force push to a shared branch overwrites upstream history. Irreversible from inside the repo.',
  },
  {
    id: 'ratchet/destructive-sql',
    pattern: 6,
    hook: 'ratchet',
    input: preTool('Bash', {
      command: `psql -c "DROP TABLE users;"`,
    }),
    expect: 'block',
    why: 'Schema destruction routed through a shell call, which most allowlists never inspect.',
  },
  {
    id: 'ratchet/ordinary-git',
    pattern: 6,
    hook: 'ratchet',
    input: preTool('Bash', { command: 'git status' }),
    expect: 'silent',
    why: 'The whole point of the ratchet is that safe reads stop prompting. Must not block.',
  },
  {
    id: 'ratchet/rm-single-file',
    pattern: 6,
    hook: 'ratchet',
    input: preTool('Bash', { command: 'rm /tmp/msg.txt' }),
    expect: 'silent',
    why: 'Deleting one temp file is not the hazard. Blocking it teaches the team to bypass the guard.',
  },
];

/**
 * Core fixtures plus the upstream corpus — checks derived from real filed bug reports.
 *
 * The corpus ships FREE and deliberately so. It is the proof: four hazards traceable to named
 * strangers' issues, with dates. Nobody believes a verifier because of its marketing, they
 * believe it because they can see what it caught and where the hazard came from. Putting the
 * evidence behind a paywall would leave the free tier arguing for itself with adjectives.
 *
 * What is paid is a team's OWN fixtures — their deploy script, their prod database. That is the
 * part that recurs and the part nobody else can write for them.
 */
function allFixtures() {
  const { UPSTREAM } = require('./corpus');
  return [...FIXTURES, ...UPSTREAM];
}

/** Fixtures for one hook id, or all of them. */
function forHook(hook) {
  const all = allFixtures();
  return hook ? all.filter((f) => f.hook === hook) : all;
}

/** Distinct hook ids that have fixture coverage. */
function hooks() {
  return [...new Set(allFixtures().map((f) => f.hook))];
}

module.exports = { FIXTURES, allFixtures, forHook, hooks, preTool };
