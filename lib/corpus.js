'use strict';
// UPSTREAM CORPUS — fixtures derived from real, filed, open bug reports.
//
// Every entry cites an issue on anthropics/claude-code, filed by a named third party on a
// known date. That provenance is the point: these are not hazards I imagined, they are ways
// hooks have actually failed for other people, and a linter cannot see any of them because a
// hook that stopped working is still schema-valid.
//
// HONEST SCOPE, and it decides the shape of the whole product:
//
//   TESTABLE HERE — authoring faults. The hook is handed a payload and responds wrongly.
//   A harness that spawns the hook can prove these, and does, below.
//
//   NOT TESTABLE HERE — runtime faults. The hook is never invoked at all: it stops firing
//   partway through a session (#76322), after a worktree switch (#76897), in the VSCode
//   extension host (#77480, #76413), or on print-mode exit (#79702). My harness invokes the
//   hook itself, so it will always find these healthy. Claiming otherwise would be selling
//   exactly the false green this product exists to expose.
//
// The second class is the larger one, and the answer to it is not a fixture — it is the
// canary in ./canary.js. Fixtures prove a hook is CORRECT. The canary proves it is being
// CALLED. You need both, and nobody ships the second one.

const { preTool } = require('./fixtures');

const UPSTREAM = [
  {
    id: 'upstream/exit2-does-not-block-on-windows',
    hook: 'ratchet',
    pattern: 6,
    issue: 80039,
    filed: '2026-07-22',
    input: preTool('Bash', { command: 'rm -rf ./dist' }),
    expect: 'block',
    why:
      'Denying by `exit 2` does not block the tool call on Windows (#80039), and exit 2 makes ' +
      'Claude Code discard stdout — so a ratchet built that way reports itself installed and ' +
      'green while every rm -rf goes through. The deny must come as JSON on stdout with exit 0.',
  },
  {
    id: 'upstream/exit2-stderr-never-reaches-the-model',
    hook: 'ratchet',
    pattern: 6,
    issue: 78393,
    filed: '2026-07-17',
    input: preTool('Bash', { command: 'git push --force origin main' }),
    expect: 'block',
    why:
      'exit-2 stderr is documented as feedback to the model but is not surfaced (#78393). A guard ' +
      'whose only output channel is exit-2 stderr is a guard whose reason is invisible — it must ' +
      'carry its reason inside the JSON decision instead.',
  },
  {
    id: 'upstream/ask-decision-silently-dropped',
    hook: 'ratchet',
    pattern: 6,
    issue: 79449,
    filed: '2026-07-20',
    input: preTool('Bash', { command: 'psql -c "DROP TABLE users;"' }),
    expect: 'block',
    why:
      'An `ask` decision can silently fail to surface (#79449), which fails OPEN — the call ' +
      'proceeds and nobody is asked. For anything irreversible, decide `deny`; never delegate ' +
      'an unrecoverable action to a prompt that may never appear.',
  },
  {
    id: 'upstream/if-condition-fails-open-on-substitution',
    hook: 'metachar',
    pattern: 3,
    issue: 80140,
    filed: '2026-07-22',
    input: preTool('Bash', { command: 'cat "$(cat /etc/passwd)"' }),
    expect: 'warn',
    why:
      'Hook `if` conditions naming only a command fire on commands that do not match them at all ' +
      'as soon as a $() or backtick is present (#80140) — the scoping fails open exactly when the ' +
      'payload is dangerous. So a guard must never rely on `if` to decide what it sees: inspect ' +
      'the command yourself, every time, substitution included.',
  },
  {
    id: 'upstream/deny-reason-must-stand-alone',
    hook: 'ratchet',
    pattern: 6,
    issue: 80919,
    filed: '2026-07-24',
    input: preTool('Bash', { command: 'git reset --hard HEAD~3' }),
    expect: 'block',
    why:
      'When two PreToolUse hooks both deny the same call, only ONE permissionDecisionReason ' +
      'reaches the model — the rest are silently dropped (#80919). So every deny reason has to be ' +
      'self-contained: name the hazard AND the alternative in the one string, because it may be ' +
      'the only one that survives.',
  },
  {
    id: 'upstream/subagent-bash-not-matched',
    hook: 'ratchet',
    pattern: 6,
    issue: 76322,
    filed: '2026-07-10',
    input: preTool('Bash', { command: 'rm -rf /srv/data', subagent: true }),
    expect: 'block',
    why:
      'Bash-matcher hooks have been reported not invoked for subagent tool calls, and to stop ' +
      'firing partway through a session (#76322). A hook must not assume anything about who is ' +
      'calling it — same payload, same verdict, every time.',
  },
];

/** Runtime failures a spawning harness cannot detect. Reported, not tested — see canary.js. */
const UNTESTABLE = [
  { issue: 76322, what: 'PreToolUse Bash hooks silently stop firing partway through a session' },
  { issue: 76897, what: 'PreToolUse hooks stop firing after EnterWorktree switches to a linked worktree' },
  { issue: 76413, what: 'PreToolUse hooks intermittently not invoked at all (VSCode extension host, Windows)' },
  { issue: 77480, what: 'Stop hook does not fire reliably in the VSCode extension (works via CLI)' },
  { issue: 79702, what: 'SessionEnd hooks do not fire on normal `claude -p` print-mode exit' },
  { issue: 80697, what: 'a hook that fails to LAUNCH is treated as a deliberate deny — exit-code collision' },
];

module.exports = { UPSTREAM, UNTESTABLE };
