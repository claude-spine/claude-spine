'use strict';
// SETTINGS RESOLUTION — read the files Claude Code actually reads.
//
// This module exists because of a MISS found by running doctor against a real repo: everything
// looked at `.claude/settings.json` only, and reported "nothing invokes these hooks" on a repo
// with three hooks firing on every single turn. They were in `settings.local.json` — which is
// where most people's real hooks live, because that is the untracked per-developer file.
//
// A verifier blind to the most common configuration on earth is worse than no verifier, since
// it hands you a confident green.
//
// Precedence, lowest to highest: settings.json → settings.local.json.
// Local wins on conflict, matching Claude Code's own behaviour.

const fs = require('fs');
const path = require('path');

const FILES = ['settings.json', 'settings.local.json'];

/** Parse tolerantly — line comments appear in these files in practice. */
function readOne(file) {
  if (!fs.existsSync(file)) return { found: false };
  let raw = fs.readFileSync(file, 'utf8');
  raw = raw.replace(/^\s*\/\/.*$/gm, '');
  try {
    return { found: true, settings: JSON.parse(raw), file };
  } catch (e) {
    return { found: true, parseError: e.message, file };
  }
}

/**
 * Merge every settings file present. Hook ARRAYS concatenate rather than replace: both files
 * genuinely contribute hooks at runtime, and a resolver that let local silently drop the
 * project's shared hooks would hide exactly the wiring gap this is here to find.
 */
function resolve(repoRoot) {
  const dir = path.join(repoRoot, '.claude');
  const sources = [];
  const errors = [];
  const merged = { hooks: {} };

  for (const name of FILES) {
    const r = readOne(path.join(dir, name));
    if (!r.found) continue;
    if (r.parseError) {
      errors.push({ file: name, error: r.parseError });
      continue;
    }
    sources.push(name);
    for (const [event, entries] of Object.entries(r.settings.hooks || {})) {
      merged.hooks[event] = [...(merged.hooks[event] || []), ...(Array.isArray(entries) ? entries : [entries])];
    }
    for (const [k, v] of Object.entries(r.settings)) {
      if (k !== 'hooks') merged[k] = v;
    }
  }

  return { sources, errors, settings: merged, anyFound: sources.length > 0 };
}

/**
 * Every hook command registered anywhere, flattened.
 *
 * Returns { event, matcher, command, script, name } — where `script` is the .js/.mjs/.sh path
 * if one is discernible and `name` is its basename. Foreign hooks matter as much as ours: the
 * people worth selling to already HAVE hooks and want to know whether THOSE fire.
 */
function registeredHooks(repoRoot) {
  const { settings, sources, errors } = resolve(repoRoot);
  const out = [];

  for (const [event, entries] of Object.entries(settings.hooks || {})) {
    for (const entry of entries) {
      const matcher = entry?.matcher ?? '';
      const inner = Array.isArray(entry?.hooks) ? entry.hooks : [entry];
      for (const h of inner) {
        const command = typeof h?.command === 'string' ? h.command : null;
        if (!command) continue;

        // A wrapped command names the SHIM first: `node spine-wrap.js their-guard -- node
        // their-guard.js`. Taking the first .js off that keys the hook as "spine-wrap", so the
        // canary looks up a name that never exists and every adopted hook reads as untimed.
        // The shim carries the real name as its first argument — use that.
        const wrapped = command.match(/spine-wrap\.js\s+(\S+)/);
        if (wrapped) {
          const real = command.split(' -- ')[1] || command;
          const rm = real.match(/([^\s"']+\.(?:js|mjs|cjs|sh|ps1|py))/);
          out.push({
            event,
            matcher,
            command,
            script: rm ? rm[1] : null,
            name: wrapped[1],
            wrapped: true,
            timeout: h.timeout,
          });
          continue;
        }

        const m = command.match(/([^\s"']+\.(?:js|mjs|cjs|sh|ps1|py))/);
        const script = m ? m[1] : null;
        out.push({
          event,
          matcher,
          command,
          script,
          name: script ? path.basename(script).replace(/\.[^.]+$/, '') : command.slice(0, 40),
          timeout: h.timeout,
        });
      }
    }
  }
  return { hooks: out, sources, errors };
}

/**
 * AUDIT: PostToolUse hooks that cover MCP tools and therefore do nothing.
 *
 * From #73586 (Chulf58, 2026-07-02, verified over a 3-week window with an otherwise-healthy
 * hook dispatch): PostToolUse hooks NEVER execute for MCP tool calls. The matcher is correct,
 * the docs show `mcp__memory__.*` style examples, the changelog implies MCP names participate
 * in matching — and the hook simply never runs. The same hooks.json fires reliably on native
 * tools in the same session.
 *
 * Corroborated by #75071 as its third finding, independently, over a separate 3-week window.
 * And #77341 reports PostToolUse not firing in daemon/background-job sessions at all.
 *
 * Why this one matters more than it looks: MCP tools are where the dangerous integrations live
 * — the database server, the deploy server, the ticketing system. Someone who wrote a
 * PostToolUse audit hook to log or verify MCP calls has exactly zero coverage on the highest-
 * consequence surface in their setup, and every part of the config says otherwise.
 */
function auditMcpHooks(repoRoot) {
  const { settings } = resolve(repoRoot);
  const findings = [];

  for (const [event, entries] of Object.entries(settings.hooks || {})) {
    if (event !== 'PostToolUse') continue;
    for (const entry of Array.isArray(entries) ? entries : [entries]) {
      const matcher = typeof entry?.matcher === 'string' ? entry.matcher : '';
      if (!matcher) continue;

      // Does this matcher target MCP tools? Either explicitly, or by being broad enough to
      // claim them (`.*`, `*`, or an empty-ish catch-all).
      const explicit = /mcp__/i.test(matcher);
      const catchAll = /^(\.\*|\*|\.\+)$/.test(matcher.trim());
      if (!explicit && !catchAll) continue;

      const commands = (Array.isArray(entry.hooks) ? entry.hooks : [entry])
        .map((h) => (typeof h?.command === 'string' ? h.command : null))
        .filter(Boolean);

      findings.push({
        event,
        matcher,
        commands,
        explicit,
        why: explicit
          ? `this PostToolUse hook targets MCP tools explicitly and will never run — PostToolUse does not fire for MCP tool calls at all (#73586, corroborated in #75071). MCP is usually where the database and deploy servers live, so this is zero coverage on the highest-consequence surface in the setup.`
          : `this PostToolUse matcher is a catch-all, so it reads as covering MCP tools — it does not. PostToolUse never fires for MCP tool calls (#73586). Native tools are covered; every mcp__ call is not.`,
      });
    }
  }
  return findings;
}

/**
 * AUDIT: deny rules that do not deny.
 *
 * Two bypasses from #78752 (gyrostar, 2026-07-18), both auditable from config alone:
 *
 *  1. On Windows, `permissions.deny` is matched against the LITERAL path string with no
 *     canonicalisation. Windows resolves one file through multiple spellings, so a deny on
 *     `C:\Program Files\x` is bypassed by addressing `C:\PROGRA~1\x`. Any path containing a
 *     space (or a long component) has an 8.3 alias, which means the rule is spelling-dependent.
 *
 *  2. Wildcard deny patterns that ARE honoured by `Read` and `Edit` are NOT honoured by `Glob`
 *     — so a nominally-denied tree can still be enumerated.
 *
 * This is the audit that lands hardest on someone who already has a deny list, because a deny
 * list is precisely the thing people write once and then trust forever. Nothing else reports it:
 * the rule is valid, the file is valid, and the protection is not there.
 */
function auditDenyRules(repoRoot) {
  const { settings } = resolve(repoRoot);
  const deny = settings?.permissions?.deny;
  if (!Array.isArray(deny)) return [];

  const findings = [];
  for (const rule of deny) {
    if (typeof rule !== 'string') continue;

    const inner = rule.match(/^\w+\(([^)]*)\)$/);
    const target = inner ? inner[1] : rule;

    // 8.3 aliasing: any path component over 8 chars, or containing a space, has a short alias.
    const looksLikePath = /[\\/]/.test(target) || /^[A-Za-z]:/.test(target);
    if (looksLikePath) {
      const aliasable = target.split(/[\\/]/).filter((seg) => seg && (seg.includes(' ') || /[^.]{9,}/.test(seg.replace(/\*/g, ''))));
      if (aliasable.length) {
        findings.push({
          rule,
          kind: '8.3-alias',
          why:
            `path segment${aliasable.length > 1 ? 's' : ''} ${aliasable.map((s) => JSON.stringify(s)).join(', ')} ` +
            `ha${aliasable.length > 1 ? 've' : 's'} a Windows 8.3 short alias. deny matches the literal string with no ` +
            `canonicalisation (#78752), so the same file reached via e.g. PROGRA~1 is not denied.`,
        });
      }
    }

    if (target.includes('*')) {
      findings.push({
        rule,
        kind: 'glob-not-honoured',
        why:
          `wildcard denies are honoured by Read and Edit but NOT by Glob (#78752) — this tree can ` +
          `still be enumerated even though reading a file in it is blocked.`,
      });
    }
  }
  return findings;
}

/**
 * AUDIT: schema faults that silently disable EVERY hook in the file.
 *
 * From #75071 (thomasdigital, 2026-07-07, verified by controlled A/B): a single schema-invalid
 * matcher entry disables ALL settings.json hooks — every event type, every hook — with no error
 * or warning surfaced anywhere. In their case that was ~100 hooks (telemetry, guardrails,
 * enforcement) dark for 30 hours, and it "looked identical to nothing to report."
 *
 * Worse, tolerance for the bad entry CHANGED across an automatic CLI update: the same config ran
 * for weeks, then loaded zero hooks after 2.1.202. Sessions already running kept firing until
 * they ended, so the failure presented as a mysterious time-based outage rather than a config
 * error. Nobody debugging that would think to look at a matcher they had not touched in weeks.
 *
 * This is the highest-consequence check here by a distance. Every other finding degrades one
 * guard; this one takes the whole file, quietly, and a schema linter that only checks the file
 * *parses* will pass it happily.
 */
function auditSchema(repoRoot) {
  const dir = path.join(repoRoot, '.claude');
  const faults = [];

  for (const name of FILES) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;

    let settings;
    try {
      settings = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, ''));
    } catch (e) {
      faults.push({ file: name, fatal: true, where: name, what: `will not parse: ${e.message}`, kills: 'every hook in this file' });
      continue;
    }

    const hooks = settings.hooks;
    if (hooks === undefined) continue;
    if (typeof hooks !== 'object' || Array.isArray(hooks)) {
      faults.push({ file: name, fatal: true, where: 'hooks', what: `must be an object keyed by event name, got ${Array.isArray(hooks) ? 'an array' : typeof hooks}`, kills: 'every hook in this file' });
      continue;
    }

    for (const [event, entries] of Object.entries(hooks)) {
      if (!Array.isArray(entries)) {
        faults.push({ file: name, fatal: true, where: `hooks.${event}`, what: `must be an array, got ${typeof entries}`, kills: 'every hook in this file' });
        continue;
      }

      entries.forEach((entry, i) => {
        const at = `hooks.${event}[${i}]`;
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
          faults.push({ file: name, fatal: true, where: at, what: `must be an object, got ${entry === null ? 'null' : Array.isArray(entry) ? 'an array' : typeof entry}`, kills: 'every hook in this file' });
          return;
        }

        // The matcher is the field the outage was about.
        if ('matcher' in entry && typeof entry.matcher !== 'string') {
          faults.push({
            file: name,
            fatal: true,
            where: `${at}.matcher`,
            what: `must be a string, got ${Array.isArray(entry.matcher) ? 'an array' : entry.matcher === null ? 'null' : typeof entry.matcher}`,
            kills: 'every hook in this file (#75071)',
          });
        }
        if (typeof entry.matcher === 'string' && entry.matcher !== '') {
          try {
            new RegExp(entry.matcher);
          } catch {
            faults.push({ file: name, fatal: true, where: `${at}.matcher`, what: `is not a valid pattern: ${JSON.stringify(entry.matcher)}`, kills: 'every hook in this file (#75071)' });
          }
        }

        const inner = entry.hooks;
        if (inner === undefined) {
          faults.push({ file: name, fatal: false, where: at, what: 'has no `hooks` array — nothing will run for this entry', kills: 'this entry only' });
          return;
        }
        if (!Array.isArray(inner)) {
          faults.push({ file: name, fatal: true, where: `${at}.hooks`, what: `must be an array, got ${typeof inner}`, kills: 'every hook in this file' });
          return;
        }
        inner.forEach((h, j) => {
          const hat = `${at}.hooks[${j}]`;
          if (!h || typeof h !== 'object') {
            faults.push({ file: name, fatal: true, where: hat, what: 'must be an object', kills: 'every hook in this file' });
            return;
          }
          if (h.type !== undefined && h.type !== 'command') {
            faults.push({ file: name, fatal: false, where: `${hat}.type`, what: `unrecognised type ${JSON.stringify(h.type)} — expected "command"`, kills: 'this hook only' });
          }
          if (typeof h.command !== 'string' || !h.command.trim()) {
            faults.push({ file: name, fatal: false, where: `${hat}.command`, what: 'missing or empty — this hook cannot run', kills: 'this hook only' });
          }
          if (h.timeout !== undefined && (typeof h.timeout !== 'number' || h.timeout <= 0)) {
            faults.push({ file: name, fatal: false, where: `${hat}.timeout`, what: `must be a positive number, got ${JSON.stringify(h.timeout)}`, kills: 'this hook only' });
          }
        });
      });
    }
  }
  return faults;
}

/**
 * AUDIT: hooks whose scoping is load-bearing but unsound.
 *
 * From #80140 (filed 2026-07-22, reproduced with two spy hooks over deterministic runs): an `if`
 * condition naming only a command — `Bash(cat *)` — fires on commands that do not match it at
 * all as soon as the command contains `$(...)` or a backtick. `$HOME` discriminates correctly;
 * substitution does not. The documented matching table says the opposite.
 *
 * The danger is not "an extra hook ran." It is that you cannot reason about WHICH hooks run when
 * substitution is present — and `if` is exactly what people reach for to keep an expensive guard
 * off the hot path. A guard whose scoping is decided by an unreliable filter is a guard whose
 * coverage you cannot state.
 *
 * The rule that follows, and it is the issue author's own conclusion: never let `if` decide what
 * your guard sees. Re-check `tool_input.command` inside the script, every time.
 *
 * No linter reports this, because the settings file is perfectly valid.
 */
function auditIfConditions(repoRoot) {
  const { settings } = resolve(repoRoot);
  const findings = [];

  for (const [event, entries] of Object.entries(settings.hooks || {})) {
    for (const entry of Array.isArray(entries) ? entries : [entries]) {
      for (const h of Array.isArray(entry?.hooks) ? entry.hooks : [entry]) {
        if (!h || typeof h !== 'object') continue;
        const cond = h.if;
        if (typeof cond !== 'string') continue;

        const m = cond.match(/^Bash\(([^)]*)\)$/);
        // A command-name-only pattern is the exact shape that misfires: one token then a wildcard.
        const commandOnly = m && /^\S+\s*\*?$/.test(m[1].trim());
        findings.push({
          event,
          command: h.command,
          if: cond,
          commandOnly: Boolean(commandOnly),
          why: commandOnly
            ? `\`if: "${cond}"\` names only a command, which is the shape that fires on non-matching commands whenever $() or a backtick is present (#80140). Re-check tool_input.command inside the hook.`
            : `\`if: "${cond}"\` gates this hook. Scoping is unreliable when the command contains $() or backticks (#80140) — do not let it decide what the guard inspects.`,
        });
      }
    }
  }
  return findings;
}

/** Does a registered script actually exist on disk? A dead path is a hook that never runs. */
function checkScriptsExist(repoRoot) {
  const { hooks } = registeredHooks(repoRoot);
  return hooks.map((h) => {
    if (!h.script) return { ...h, exists: null };
    const abs = path.isAbsolute(h.script) ? h.script : path.join(repoRoot, h.script);
    return { ...h, resolved: abs, exists: fs.existsSync(abs) };
  });
}

module.exports = { resolve, registeredHooks, checkScriptsExist, auditIfConditions, auditSchema, auditDenyRules, auditMcpHooks, FILES };
