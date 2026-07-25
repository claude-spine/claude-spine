'use strict';
// REPORT — turn a diagnosis into something a person acts on.
//
// The ordering is deliberate: MISS first, because a guard that stays silent on a real
// hazard is the only genuinely dangerous outcome. NOISE second, because a guard that
// cries wolf gets muted and then it is a MISS with extra steps.

const C = process.stdout.isTTY && !process.env.NO_COLOR
  ? { r: '\x1b[31m', y: '\x1b[33m', g: '\x1b[32m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }
  : { r: '', y: '', g: '', d: '', b: '', x: '' };

const MARK = { pass: `${C.g}ok${C.x}`, MISS: `${C.r}MISS${C.x}`, NOISE: `${C.y}NOISE${C.x}`, absent: `${C.d}--${C.x}`, error: `${C.r}ERR${C.x}`, timeout: `${C.r}TIMEOUT${C.x}` };

function print(diag, opts = {}) {
  const L = [];
  L.push('');
  L.push(`${C.b}claude-spine doctor${C.x}  ${C.d}${diag.repoRoot}${C.x}`);
  L.push('');

  // FATAL FIRST, BEFORE THE COLD-START RETURN. Found by pointing doctor at a real stranger's
  // repo for the first time: parcadei/Continuous-Claude-v3, 3.8k stars, a hooks product whose
  // own PostToolUse[3] matcher is "*" — invalid regex, which per #75071 disables every hook in
  // the file. auditSchema found it. The payload carried it. And the render never reached it,
  // because `bare` returns at the branch below and the fatal block sits ~120 lines further on.
  //
  // So the one thing this tool exists to say was unreachable for every first-time user — the
  // whole audience — while the output looked calm and complete. Reports green, does nothing:
  // the exact species this product is built to catch, sitting in its own front door for the
  // second time. It is hoisted above every early return now, and a test pins it there.
  const fatalTop = (diag.schema || []).filter((f) => f.fatal);
  if (fatalTop.length) {
    L.push(`  ${C.r}${C.b}EVERY HOOK IN THIS FILE IS DISABLED${C.x}  ${C.d}(#75071)${C.x}`);
    for (const f of fatalTop) L.push(`    ${C.r}${f.file}${C.x}  ${f.where}  ${C.d}${f.what}${C.x}`);
    L.push(`  ${C.d}one schema-invalid entry disables ALL hooks — every event, no warning anywhere.${C.x}`);
    L.push(`  ${C.d}it looks exactly like "nothing to report". fix this before anything else here.${C.x}`);
    L.push('');
  }

  // COLD START. A repo with nothing installed used to get sixteen "absent" rows and then the
  // words "spine healthy" — a health certificate for having no protection at all, which is
  // precisely the false green this tool exists to destroy. It was the first thing a stranger
  // would ever see.
  //
  // So: say the true thing in four lines and get out of the way.
  if (diag.bare) {
    L.push(`  ${C.r}no guards installed${C.x} — nothing here is checking anything.`);
    L.push('');
    L.push(`  ${diag.results.length} known hazards go completely unchecked, including:`);
    for (const r of diag.results.slice(0, 3)) L.push(`    ${C.d}· ${r.why.split('.')[0]}.${C.x}`);
    L.push('');
    if (diag.wiring.foreign?.length) {
      L.push(`  you do have ${diag.wiring.foreign.length} hook(s) of your own — none of them timed:`);
      for (const h of diag.wiring.foreign) L.push(`    ${C.d}${h.event}  ${h.name}${C.x}`);
      L.push(`  ${C.d}claude-spine adopt${C.x}  to prove those are still firing`);
      L.push('');
    }
    L.push(`  ${C.b}claude-spine init${C.x}  lays the guards down, then verifies them`);
    L.push('');
    return L.join('\n');
  }

  const byHook = {};
  for (const r of diag.results) (byHook[r.hook] ||= []).push(r);

  for (const [hook, rows] of Object.entries(byHook)) {
    const absent = rows.every((r) => r.verdict === 'absent');
    const bad = rows.filter((r) => r.verdict === 'MISS' || r.verdict === 'NOISE').length;
    const head = absent
      ? `${C.d}not installed${C.x}`
      : bad
        ? `${C.r}${bad} problem${bad > 1 ? 's' : ''}${C.x}`
        : `${C.g}all ${rows.length} checks pass${C.x}`;
    L.push(`  ${C.b}${hook}${C.x}  ${head}`);

    for (const r of rows) {
      if (r.verdict === 'pass') continue; // the interesting rows are the failures
      L.push(`    ${MARK[r.verdict] || r.verdict}  ${r.id}`);
      L.push(`        ${C.d}expected ${r.expect}, got ${r.actual}${C.x}`);
      L.push(`        ${r.why}`);
    }
    L.push('');
  }

  // A hook file that exists but is not registered in settings.json never runs. Silent
  // and total. This is the most common way a "configured" repo turns out to be bare.
  const w = diag.wiring;
  if (!w.settingsFound) {
    L.push(`  ${C.r}no .claude/settings.json${C.x} — hook files are present but nothing invokes them.`);
    L.push('');
  } else if (w.parseError) {
    L.push(`  ${C.r}.claude/settings.json will not parse${C.x} — ${w.parseError}`);
    L.push('');
  } else if (w.unregistered.length) {
    L.push(`  ${C.r}installed but never invoked:${C.x} ${w.unregistered.join(', ')}`);
    L.push(`  ${C.d}the file exists; no settings file references it, so it never runs.${C.x}`);
    L.push('');
  }

  // A registered script that is not on disk never runs, and nothing else in the toolchain
  // reports it — the settings file is valid, so a schema linter passes it happily.
  if (w.deadPaths?.length) {
    L.push(`  ${C.r}registered but missing from disk:${C.x}`);
    for (const h of w.deadPaths) L.push(`    ${h.event}  ${C.d}${h.script}${C.x}`);
    L.push(`  ${C.d}these can never fire. the settings file is still perfectly valid.${C.x}`);
    L.push('');
  }

  // The hooks this repo actually runs that aren't ours. These are the ones a buyer cares
  // about, and the canary cannot time them until they're adopted — so say so plainly instead
  // of quietly grading only our own and calling the repo healthy.
  if (w.foreign?.length) {
    L.push(`  ${C.b}your own hooks${C.x}  ${C.d}${w.foreign.length} found in ${(w.sources || []).join(' + ')}${C.x}`);
    for (const h of w.foreign) {
      const live = diag.canary?.hooks?.[h.name];
      const mark = !live
        ? `${C.y}not timed${C.x}`
        : live.verdict === 'live'
          ? `${C.g}live ${live.ageHours}h${C.x}`
          : `${C.r}${live.verdict}${C.x}`;
      L.push(`    ${h.event.padEnd(16)} ${h.name.padEnd(22)} ${mark}`);
    }
    L.push(`  ${C.d}fixtures only grade guards we ship. run: claude-spine adopt${C.x}`);
    L.push(`  ${C.d}— wraps these so the canary can prove they're still firing.${C.x}`);
    L.push('');
  }

  // THE CANARY — the only thing here that can see a hook which stopped being called.
  // Every fixture above proves correctness; none of them prove invocation, because this
  // harness spawns the hooks itself. A repo can pass every check and have run nothing
  // for a week.
  const k = diag.canary;
  if (k) {
    if (k.verdict === 'gaps') {
      L.push(`  ${C.b}canary${C.x}  ${C.r}hooks are not being called${C.x}`);
      for (const [name, h] of Object.entries(k.hooks)) {
        if (h.verdict === 'live') continue;
        L.push(
          h.everFired
            ? `    ${C.r}STALE${C.x}  ${name}  ${C.d}last fired ${h.ageHours}h ago (${h.invocations} total)${C.x}`
            : `    ${C.r}NEVER${C.x}  ${name}  ${C.d}registered, but has never once run${C.x}`
        );
      }
      L.push(`  ${C.d}every check above can pass while this is true — that is the point of it.${C.x}`);
      L.push('');
    } else if (k.verdict === 'live') {
      const live = Object.entries(k.hooks).map(([n, h]) => `${n} ${h.ageHours}h`).join(' · ');
      L.push(`  ${C.b}canary${C.x}  ${C.g}all firing${C.x}  ${C.d}${live}${C.x}`);
      L.push('');
    } else if (k.verdict === 'unknown') {
      L.push(`  ${C.b}canary${C.x}  ${C.d}no data yet — run a turn with the hooks installed${C.x}`);
      L.push('');
    }
  }

  // SCHEMA FAULTS THAT KILL THE WHOLE FILE (#75071). Printed FIRST and loudest, because every
  // other finding degrades one guard while this one silently disables every hook in the file —
  // ~100 hooks dark for 30 hours in the filed case, presenting as "nothing to report".
  const fatal = (diag.schema || []).filter((f) => f.fatal);
  const minor = (diag.schema || []).filter((f) => !f.fatal);
  if (fatal.length) {
    L.push(`  ${C.r}${C.b}EVERY HOOK IN THIS FILE IS DISABLED${C.x}  ${C.d}(#75071)${C.x}`);
    for (const f of fatal) L.push(`    ${C.r}${f.file}${C.x}  ${f.where}  ${C.d}${f.what}${C.x}`);
    L.push(`  ${C.d}one schema-invalid entry disables ALL hooks — every event, no warning anywhere.${C.x}`);
    L.push(`  ${C.d}it looks exactly like "nothing to report". fix this before anything else here.${C.x}`);
    L.push('');
  }
  if (minor.length) {
    L.push(`  ${C.y}hooks that cannot run${C.x}`);
    for (const f of minor) L.push(`    ${f.where}  ${C.d}${f.what}${C.x}`);
    L.push('');
  }

  // THERE IS NO SAFE WAY TO DENY RIGHT NOW (#78527 + #79449). Deny ends the turn silently on
  // 2.1.210+; ask can fail to surface and fails OPEN. Both directions broken, differently. This
  // cannot be fixed from a config — it exists so the choice is made deliberately.
  if (diag.denyMech?.length) {
    const prompt = diag.denyMech.filter((f) => f.type === 'prompt');
    L.push(`  ${C.y}no safe deny mechanism exists right now${C.x}  ${C.d}(#78527 / #79449)${C.x}`);
    L.push(`    ${C.d}deny  → ends the turn on 2.1.210+, Stop chain skipped, stall is silent${C.x}`);
    L.push(`    ${C.d}ask   → can fail to surface, and fails OPEN — call proceeds, nobody asked${C.x}`);
    if (prompt.length) {
      L.push(`    ${C.r}${prompt.length} prompt-type hook(s)${C.x} ${C.d}— these also appear to fail open entirely in headless -p, which is where CI runs${C.x}`);
    }
    L.push(`  ${C.d}deny for the irreversible; never ask for the unrecoverable. if you run unattended,${C.x}`);
    L.push(`  ${C.d}assume a deny can hang the run and alarm on wall-clock somewhere outside the hook.${C.x}`);
    L.push('');
  }

  // HOOKS WHOSE ENTIRE PRODUCT IS STDOUT, ON VERSIONS WHERE STDOUT GOES NOWHERE (#79299).
  // The nastiest of the three shapes: the hook is correct, it IS invoked, it does its work, and
  // the work is discarded in transit. The canary reads healthy because the stamp lands. Only
  // knowing what the hook was FOR tells you it stopped doing it.
  if (diag.injectAudit?.length) {
    L.push(`  ${C.y}context-injecting hooks — verify the model actually receives this${C.x}  ${C.d}(#79299)${C.x}`);
    for (const f of diag.injectAudit) L.push(`    ${f.event.padEnd(18)} ${C.d}${f.command}${C.x}`);
    L.push(`  ${C.d}stdout injection broke between 2.1.209 and 2.1.215 — hook runs, output non-empty,${C.x}`);
    L.push(`  ${C.d}model receives nothing. the canary cannot see it: the hook fires, so liveness is green.${C.x}`);
    L.push('');
  }

  // POSTTOOLUSE HOOKS THAT NEVER RUN ON MCP (#73586). MCP is where the database and deploy
  // servers live, so a post-hoc guard written for that surface has zero coverage on the most
  // consequential calls in the setup — while every part of the config says it is covered.
  if (diag.mcpAudit?.length) {
    L.push(`  ${C.r}PostToolUse hooks that never run${C.x}  ${C.d}(#73586)${C.x}`);
    for (const f of diag.mcpAudit) {
      L.push(`    ${C.d}matcher: ${JSON.stringify(f.matcher)}${C.x}${f.explicit ? `  ${C.r}← targets MCP explicitly${C.x}` : `  ${C.y}← catch-all, reads as covering MCP${C.x}`}`);
      for (const c of f.commands) L.push(`      ${C.d}${c}${C.x}`);
    }
    L.push(`  ${C.d}PostToolUse does not fire for MCP tool calls at all. native tools are covered;${C.x}`);
    L.push(`  ${C.d}every mcp__ call is not — and the matcher is correct, which is why nobody notices.${C.x}`);
    L.push('');
  }

  // DENY RULES THAT DO NOT DENY (#78752). A deny list is written once and trusted forever, which
  // is exactly why a bypass in one is worth finding. Nothing else reports these: the rule is
  // valid, the file is valid, and the protection simply is not there.
  if (diag.denyAudit?.length) {
    L.push(`  ${C.r}deny rules that can be bypassed${C.x}  ${C.d}(#78752)${C.x}`);
    for (const f of diag.denyAudit) {
      L.push(`    ${C.d}${f.rule}${C.x}`);
      L.push(`      ${f.kind === '8.3-alias' ? C.r + '8.3 alias' + C.x : C.y + 'Glob ignores it' + C.x}  ${C.d}${f.why}${C.x}`);
    }
    L.push('');
  }

  // UNSOUND SCOPING (#80140). An `if` condition naming only a command fires on commands that do
  // not match it at all, the moment `$()` or a backtick appears. So a hook gated this way has
  // coverage you cannot state — and `if` is exactly what people reach for to keep an expensive
  // guard off the hot path. No linter reports it; the settings file is entirely valid.
  if (diag.ifAudit?.length) {
    L.push(`  ${C.b}unsound scoping${C.x}  ${C.y}${diag.ifAudit.length} hook(s) gated by an \`if\` condition${C.x}`);
    for (const f of diag.ifAudit) {
      L.push(`    ${f.event}  ${C.d}if: ${f.if}${C.x}${f.commandOnly ? `  ${C.r}← command-only, the misfiring shape${C.x}` : ''}`);
    }
    L.push(`  ${C.d}#80140: scoping is unreliable when the command contains $() or backticks.${C.x}`);
    L.push(`  ${C.d}re-check tool_input.command inside the hook — never let \`if\` decide what it sees.${C.x}`);
    L.push('');
  }

  // WHAT THIS CANNOT CATCH. Printed on purpose, and printed last so it is the thing left in
  // your head. Every one of these is a runtime failure — the hook is never invoked at all — and
  // a harness that spawns hooks itself will report every one of them healthy forever. Naming
  // your own blind spots is the only thing that makes the green trustworthy; a verifier that
  // implies total coverage is selling the exact false confidence it claims to cure.
  if (diag.canary && !opts.quiet) {
    const { UNTESTABLE } = require('./corpus');
    L.push(`  ${C.d}not detectable by fixtures — the hook is never called at all:${C.x}`);
    for (const u of UNTESTABLE.slice(0, 3)) L.push(`    ${C.d}#${u.issue}  ${u.what}${C.x}`);
    L.push(`    ${C.d}… ${UNTESTABLE.length - 3} more. this is what the canary above is for.${C.x}`);
    L.push('');
  }

  const c = diag.counts;
  const parts = [];
  if (c.pass) parts.push(`${c.pass} pass`);
  if (c.MISS) parts.push(`${C.r}${c.MISS} missed${C.x}`);
  if (c.NOISE) parts.push(`${C.y}${c.NOISE} noisy${C.x}`);
  if (c.absent) parts.push(`${c.absent} uncovered`);
  L.push(`  ${parts.join('  ·  ') || 'nothing to check'}`);
  L.push(diag.ok ? `  ${C.g}spine healthy${C.x}` : `  ${C.r}spine has gaps${C.x}  ${C.d}run: claude-spine init${C.x}`);
  L.push('');
  return L.join('\n');
}

module.exports = { print };
