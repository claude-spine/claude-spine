'use strict';
// ADOPT — route existing hooks through the canary without touching their code.
//
// The hooks worth monitoring in any real repo are the ones already in it. I cannot inline a
// stamp into somebody else's hook file: it is theirs, it changes under them, and editing it
// would make every future diff mine to explain. So adopt rewrites the COMMAND in the settings
// file to run the shim, which stamps and then execs their hook untouched.
//
//   before:  node .claude/hooks/their-hook.js
//   after:   node .claude/hooks/spine-wrap.js their-hook -- node .claude/hooks/their-hook.js
//
// Rules this follows, because it is editing a file it did not write:
//
//   1. Back up first, always, with a timestamp. Never destroy a recoverable state.
//   2. Rewrite one file surgically — re-read it raw and change only `command` strings, so
//      every other key, comment-free or not, survives byte-for-byte through JSON round-trip.
//   3. Be exactly reversible. `--undo` strips the wrapper and restores the original command.
//   4. Idempotent. Running twice must not double-wrap.
//   5. Never wrap our own hooks — they already stamp themselves.

const fs = require('fs');
const path = require('path');

const SHIM = 'spine-wrap.js';
const OURS = new Set(['check-metachar', 'permission-ratchet', 'verify-claims', 'heartbeat', 'spine-wrap']);

/** Which settings file to edit: prefer the local one, since that is where real hooks live. */
function targetFile(repoRoot) {
  const dir = path.join(repoRoot, '.claude');
  for (const name of ['settings.local.json', 'settings.json']) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function hookNameOf(command) {
  const m = command.match(/([^\s"']+\.(?:js|mjs|cjs|sh|ps1|py))/);
  return m ? path.basename(m[1]).replace(/\.[^.]+$/, '') : null;
}

function isWrapped(command) {
  return command.includes(SHIM);
}

/** Recover the original command from a wrapped one. */
function unwrap(command) {
  const i = command.indexOf(' -- ');
  return i === -1 ? command : command.slice(i + 4);
}

/**
 * Plan the change without writing anything. Callers show this first — editing somebody's
 * settings file should never be a surprise.
 */
function plan(repoRoot, opts = {}) {
  const file = targetFile(repoRoot);
  if (!file) return { file: null, changes: [], error: 'no .claude/settings.json or settings.local.json found' };

  // THE SHIM MUST EXIST BEFORE ANYTHING IS REWRITTEN.
  //
  // Adopt points every wrapped command at spine-wrap.js. If that file is not on disk, the rewrite
  // takes a repo full of working hooks and turns each one into a command that cannot run — and it
  // does it to the settings file, so the damage is to configuration rather than code and no test
  // suite anywhere would notice.
  //
  // Found by aiming this at my own repo, whose hooks include the heartbeat that keeps me running
  // between turns. It would have broken all six of them at once. Nothing about the plan looked
  // wrong; the shim simply was not there, because `init` had never been run in that repo.
  if (!opts.undo) {
    const shimPath = path.join(repoRoot, '.claude', 'hooks', SHIM);
    if (!fs.existsSync(shimPath)) {
      return {
        file,
        changes: [],
        error:
          `${SHIM} is not installed at .claude/hooks/ — wrapping would point every hook at a file that does not exist.\n` +
          `  run \`claude-spine init\` first (it is additive and will not touch your existing hooks).`,
      };
    }
  }

  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  } catch (e) {
    return { file, changes: [], error: `cannot parse ${path.basename(file)}: ${e.message}` };
  }

  const changes = [];
  const shimPath = path.join('.claude', 'hooks', SHIM).replace(/\\/g, '/');

  for (const [event, entries] of Object.entries(settings.hooks || {})) {
    for (const entry of Array.isArray(entries) ? entries : [entries]) {
      for (const h of Array.isArray(entry?.hooks) ? entry.hooks : [entry]) {
        if (typeof h?.command !== 'string') continue;
        const name = hookNameOf(h.command);

        if (opts.undo) {
          if (isWrapped(h.command)) {
            changes.push({ event, name, from: h.command, to: unwrap(h.command), action: 'unwrap' });
          }
          continue;
        }

        if (isWrapped(h.command)) continue;          // idempotent
        if (!name || OURS.has(name)) continue;        // ours already stamp themselves
        changes.push({
          event,
          name,
          from: h.command,
          to: `node ${shimPath} ${name} -- ${h.command}`,
          action: 'wrap',
        });
      }
    }
  }
  return { file, changes, settings };
}

/** Apply a plan. Backs up first; returns what it did. */
function apply(repoRoot, opts = {}) {
  const p = plan(repoRoot, opts);
  if (p.error) return { ...p, applied: 0 };
  if (!p.changes.length) return { ...p, applied: 0, backup: null };

  const backup = `${p.file}.spine-backup-${Date.now()}`;
  fs.copyFileSync(p.file, backup);

  const byFrom = new Map(p.changes.map((c) => [c.from, c.to]));
  const settings = p.settings;
  let applied = 0;

  for (const entries of Object.values(settings.hooks || {})) {
    for (const entry of Array.isArray(entries) ? entries : [entries]) {
      for (const h of Array.isArray(entry?.hooks) ? entry.hooks : [entry]) {
        if (typeof h?.command === 'string' && byFrom.has(h.command)) {
          h.command = byFrom.get(h.command);
          applied++;
        }
      }
    }
  }

  fs.writeFileSync(p.file, JSON.stringify(settings, null, 2) + '\n');
  return { ...p, applied, backup };
}

module.exports = { plan, apply, targetFile, isWrapped, unwrap, SHIM, OURS };
