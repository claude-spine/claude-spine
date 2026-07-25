'use strict';
// THE CANARY — proof your hooks are being CALLED, not merely that they are correct.
//
// This exists because of a structural limit in every hook-testing approach including my own:
// a harness that spawns your hook will always find it healthy. It cannot see the failure that
// 467 open issues are actually about — the hook that stops being invoked at all. Partway
// through a session (#76322). After a worktree switch (#76897). In the VSCode extension host
// (#76413, #77480). On print-mode exit (#79702).
//
// In every one of those cases the file is on disk, the JSON is valid, the schema-linter is
// green, `doctor` says all checks pass — and nothing has run for three days.
//
// So the hooks stamp a file each time they fire, and this reads the clock on it. That is the
// whole idea, and it is embarrassingly simple, and nobody ships it. A guard you cannot prove
// ran is a guard you are only assuming.

const fs = require('fs');
const path = require('path');

const STAMP = '.last-fired.json';

/** Called BY a hook, on every invocation. Must never throw and never slow a turn down. */
function stamp(hooksDir, hookName) {
  try {
    const file = path.join(hooksDir, STAMP);
    let all = {};
    try {
      all = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {}
    all[hookName] = { at: Date.now(), n: (all[hookName]?.n || 0) + 1 };
    fs.writeFileSync(file, JSON.stringify(all));
  } catch {
    // A canary that can break a turn is worse than no canary.
  }
}

/**
 * Read the canary. Returns per-hook liveness plus an overall verdict.
 *
 * `staleAfterHours` is deliberately generous — a repo untouched over a weekend is not a
 * broken repo, and crying wolf here would be the same sin the NOISE grade exists to catch.
 */
function read(repoRoot, opts = {}) {
  const hooksDir = path.join(repoRoot, '.claude', 'hooks');
  const staleAfter = (opts.staleAfterHours ?? 72) * 3.6e6;
  const file = path.join(hooksDir, STAMP);

  const registered = listRegistered(repoRoot);

  if (!fs.existsSync(file)) {
    return {
      available: false,
      registered,
      // No stamp file yet is genuinely ambiguous: either nothing has ever fired, or the hooks
      // predate the canary. Say which it is rather than guessing at a verdict.
      verdict: registered.length ? 'unknown' : 'no-hooks',
      hooks: {},
      note: 'no canary data yet — run a turn with the hooks installed, then check again',
    };
  }

  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { available: false, registered, verdict: 'unreadable', hooks: {}, note: e.message };
  }

  const now = Date.now();
  const hooks = {};
  for (const name of registered) {
    const rec = data[name];
    if (!rec) {
      hooks[name] = { everFired: false, verdict: 'NEVER FIRED' };
      continue;
    }
    const ageMs = now - rec.at;
    hooks[name] = {
      everFired: true,
      lastFired: new Date(rec.at).toISOString(),
      ageHours: +(ageMs / 3.6e6).toFixed(1),
      invocations: rec.n,
      verdict: ageMs > staleAfter ? 'STALE' : 'live',
    };
  }

  const bad = Object.values(hooks).filter((h) => h.verdict !== 'live');
  return {
    available: true,
    registered,
    hooks,
    verdict: bad.length ? 'gaps' : 'live',
  };
}

/**
 * Which hooks settings.json actually invokes. The canary can only speak about these — a hook
 * that was never wired has not "stopped firing", it was never started.
 */
function listRegistered(repoRoot) {
  // Reads settings.json AND settings.local.json — the latter is where most real hooks live,
  // and looking only at the former is how this reported "nothing invokes these hooks" on a
  // repo with three firing every turn.
  const { hooks } = require('./settings').registeredHooks(repoRoot);
  return [...new Set(hooks.map((h) => h.name))].sort();
}

module.exports = { stamp, read, listRegistered, STAMP };
