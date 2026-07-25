'use strict';
// DOCTOR — run every fixture against the hooks a repo actually has installed.
//
// This is the part that is worth money. A config you copied is a claim; this turns it
// into a result. We spawn the real hook file the way Claude Code does — payload on
// stdin, read exit code and stdout — and compare against what the fixture says should
// happen. No mocking, no "looks right." The hook either fired or it did not.
//
// Verdict per fixture:
//   pass    behaved as specified
//   MISS    should have caught it and stayed quiet   (the dangerous one)
//   NOISE   fired on something harmless              (the one that gets guards deleted)
//   absent  no hook installed for that pattern

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { forHook, hooks } = require('./fixtures');

const HOOK_FILES = {
  metachar: 'check-metachar.js',
  verify: 'verify-claims.js',
  ratchet: 'permission-ratchet.js',
};

/**
 * Run one hook against one payload exactly as Claude Code would.
 * Resolves { code, stdout, stderr, timedOut } — never rejects on a non-zero exit,
 * because a non-zero exit is a legitimate result (that is how a hook blocks).
 */
function runHook(hookPath, payload, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [hookPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: path.dirname(path.dirname(hookPath)), // repo root, as the hook expects
      // Mark this as synthetic so the hook does not stamp the canary. Without it, running
      // doctor counts as the hooks having fired, and liveness can never read stale — the
      // measurement refreshes what it is measuring.
      env: { ...process.env, CLAUDE_SPINE_HARNESS: '1' },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(e.message), timedOut, spawnFailed: true });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });

    child.stdin.end(JSON.stringify(payload));
  });
}

/**
 * What a hook run actually did, in fixture vocabulary.
 *
 * There are TWO ways a PreToolUse hook denies a call and they look nothing alike:
 *
 *   exit 2                  → stderr is the reason, stdout is discarded (legacy)
 *   exit 0 + JSON on stdout → hookSpecificOutput.permissionDecision: "deny" (preferred)
 *
 * Grading only the first is how this grader spent its first morning quietly marking
 * correctly-written modern hooks as mere warnings — a MISS inside the thing whose entire
 * job is finding MISSes. Check both.
 */
function classify(result) {
  if (result.spawnFailed) return 'error';
  if (result.timedOut) return 'timeout';
  if (result.code !== 0) return 'block';

  const out = result.stdout.trim();
  if (!out) return 'silent';

  const decision = permissionDecision(out);
  if (decision === 'deny') return 'block';
  // "ask" escalates to the human rather than stopping the call outright — louder than a
  // warning, quieter than a block. Grade it as a warning; it does not guarantee a stop.
  if (decision === 'ask') return 'warn';

  return 'warn';
}

/** Pull permissionDecision out of hook stdout, tolerating log lines around the JSON. */
function permissionDecision(stdout) {
  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  let obj = tryParse(stdout);
  if (!obj) {
    // Hooks legitimately print diagnostics alongside their JSON. Find the outermost object.
    const first = stdout.indexOf('{');
    const last = stdout.lastIndexOf('}');
    if (first !== -1 && last > first) obj = tryParse(stdout.slice(first, last + 1));
  }
  if (!obj || typeof obj !== 'object') return null;
  return obj.hookSpecificOutput?.permissionDecision ?? obj.permissionDecision ?? null;
}

/** A block also satisfies an expectation of warn — it is strictly louder. */
function satisfies(expected, actual) {
  if (expected === actual) return true;
  if (expected === 'warn' && actual === 'block') return true;
  return false;
}

function verdictFor(fixture, actual) {
  if (satisfies(fixture.expect, actual)) return 'pass';
  if (actual === 'silent') return 'MISS';
  if (fixture.expect === 'silent') return 'NOISE';
  return 'MISS';
}

/**
 * Check a repo. Returns a structured report; printing is report.js's job so this
 * stays usable from CI (`--json`) as well as a terminal.
 */
async function diagnose(repoRoot = process.cwd(), opts = {}) {
  const hooksDir = path.join(repoRoot, '.claude', 'hooks');
  const results = [];
  const installed = {};

  // Custom fixtures (paid tier) join the core set and are graded identically — a team's own
  // footgun is not a second-class check.
  const extra = opts.extra || [];
  const allHooks = [...new Set([...hooks(), ...extra.map((f) => f.hook)])];

  for (const hook of allHooks) {
    const file = HOOK_FILES[hook];
    const full = file ? path.join(hooksDir, file) : null;
    installed[hook] = Boolean(full && fs.existsSync(full));

    const set = [...forHook(hook), ...extra.filter((f) => f.hook === hook)];
    for (const fixture of set) {
      if (!installed[hook]) {
        results.push({ ...fixture, actual: 'absent', verdict: 'absent' });
        continue;
      }
      const run = await runHook(full, fixture.input, opts.timeout);
      const actual = classify(run);
      results.push({
        ...fixture,
        actual,
        verdict: verdictFor(fixture, actual),
        stdout: run.stdout.trim(),
      });
    }
  }

  const settingsPath = path.join(repoRoot, '.claude', 'settings.json');
  const wiring = checkWiring(settingsPath, installed);

  // Fixtures prove a hook is CORRECT. They cannot prove it is being CALLED — this harness
  // spawns the hook itself, so a hook that stopped being invoked mid-session still passes
  // every check. That is the larger failure class upstream (#76322, #76897, #77480, #79702),
  // and the canary is the only thing here that can see it.
  const canary = require('./canary').read(repoRoot, opts);

  // Hooks whose scoping is load-bearing but unsound (#80140). No linter reports this, because
  // the settings file is entirely valid — the bug is in what the filter does at runtime.
  const ifAudit = require('./settings').auditIfConditions(repoRoot);

  // Schema faults that take the WHOLE FILE down silently (#75071). Highest-consequence check
  // here: everything else degrades one guard, this one disables every hook with no warning.
  const schema = require('./settings').auditSchema(repoRoot);

  // Deny rules that do not deny (#78752): 8.3 short-name aliasing on Windows, and wildcards that
  // Read/Edit honour but Glob does not. A deny list is the thing people write once and trust
  // forever, which is exactly why an unreported bypass in one is worth finding.
  const denyAudit = require('./settings').auditDenyRules(repoRoot);

  // PostToolUse hooks that cover MCP tools and therefore never run (#73586). MCP is where the
  // database and deploy servers live, so this is zero coverage on the highest-consequence
  // surface in a setup — while every part of the config says otherwise.
  const mcpAudit = require('./settings').auditMcpHooks(repoRoot);

  // Hooks whose entire product is stdout, on versions where stdout goes nowhere (#79299). The
  // canary cannot catch this one — the hook fires, so liveness reads healthy. Only knowing what
  // the hook was FOR tells you it has stopped doing it.
  const injectAudit = require('./settings').auditContextInjection(repoRoot);

  // There is currently no safe way to deny (#78527 + #79449). Deny ends the turn silently on
  // 2.1.210+; ask can fail to surface and fails OPEN. This check exists so the choice is made
  // deliberately rather than discovered at 3am.
  const denyMech = require('./settings').auditDenyMechanism(repoRoot);

  const counts = results.reduce((a, r) => ((a[r.verdict] = (a[r.verdict] || 0) + 1), a), {});
  return {
    repoRoot,
    installed,
    wiring,
    results,
    counts,
    // Computed above and — for one embarrassing hour — left out of this object entirely, so
    // the canary ran, returned a verdict, and reported to nobody while the summary said all
    // checks pass. Which is precisely the failure the canary exists to catch. It is in the
    // payload now, and there is a test below that fails if it ever falls out again.
    canary,
    ifAudit,
    schema,
    denyAudit,
    mcpAudit,
    injectAudit,
    denyMech,
    // BARE: not one of our guards is installed, so every fixture came back absent. This is the
    // first thing a stranger ever sees, and it used to render as sixteen "absent" rows followed
    // by the words "spine healthy" — a health certificate for having no protection whatsoever.
    // That is the exact false green this tool exists to destroy, sitting in its own front door.
    bare: Object.values(installed).every((v) => !v),
    // A repo is only healthy if nothing is missed, nothing is noisy, AND something is actually
    // installed. An empty repo has no gaps because it has no guards — that is not health, and
    // `doctor` exits non-zero on it so CI says so out loud.
    ok:
      !counts.MISS &&
      !counts.NOISE &&
      !counts.error &&
      !counts.timeout &&
      !Object.values(installed).every((v) => !v),
  };
}

/**
 * A hook file on disk that is not registered in settings.json never runs. This is
 * the single most common way a "configured" repo turns out to be unprotected.
 */
function checkWiring(settingsPath, installed) {
  // Resolves settings.json + settings.local.json together. Reading only the first one made
  // this report "nothing invokes these hooks" against a live repo with three hooks firing on
  // every turn — a confident green on the most common configuration there is.
  const repoRoot = path.dirname(path.dirname(settingsPath));
  const { resolve, checkScriptsExist } = require('./settings');
  const res = resolve(repoRoot);

  if (!res.anyFound) {
    return {
      settingsFound: false,
      sources: [],
      unregistered: Object.keys(installed).filter((h) => installed[h]),
      foreign: [],
      deadPaths: [],
    };
  }
  if (res.errors.length) {
    return {
      settingsFound: true,
      sources: res.sources,
      parseError: res.errors.map((e) => `${e.file}: ${e.error}`).join('; '),
      unregistered: [],
      foreign: [],
      deadPaths: [],
    };
  }

  const blob = JSON.stringify(res.settings.hooks || {});
  const unregistered = Object.entries(installed)
    .filter(([hook, present]) => present && !blob.includes(HOOK_FILES[hook]))
    .map(([hook]) => hook);

  // Hooks this repo runs that are not ours. These are the ones a buyer actually cares about,
  // and the canary cannot see them until they are adopted — so name them rather than ignoring.
  const known = new Set(Object.values(HOOK_FILES).map((f) => f.replace(/\.js$/, '')));
  const scripts = checkScriptsExist(repoRoot);
  const foreign = scripts.filter((h) => !known.has(h.name));

  // A registered script that is not on disk never runs, and nothing else reports it.
  const deadPaths = scripts.filter((h) => h.exists === false);

  return { settingsFound: true, sources: res.sources, unregistered, foreign, deadPaths, hooks: res.settings.hooks || {} };
}

module.exports = { diagnose, runHook, classify, verdictFor, satisfies, HOOK_FILES };
