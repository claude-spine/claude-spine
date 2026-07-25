#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const { install } = require('../lib/init');
const { diagnose } = require('../lib/doctor');
const report = require('../lib/report');
const license = require('../lib/license');
const custom = require('../lib/custom');
const { REPORTERS } = require('../lib/reporters');

const pkg = require('../package.json');
const C_B = process.stdout.isTTY && !process.env.NO_COLOR ? '\x1b[1m' : '';
const C_X = process.stdout.isTTY && !process.env.NO_COLOR ? '\x1b[0m' : '';
const argv = process.argv.slice(2);
const cmd = argv[0];
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  if (i === -1) return d;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : d;
};
const root = process.cwd();

const USAGE = `
claude-spine ${pkg.version}

  claude-spine init [--force]           lay the spine into this repo, then verify it
  claude-spine doctor                   run every known-bad payload at your installed hooks
    --reporter junit|github|tap         machine-readable output for CI
    --json                              full diagnosis as JSON
    --fixtures <dir>                    also run your own fixtures            [pro]
  claude-spine adopt [--dry-run|--undo] wrap YOUR existing hooks so the canary can time them
  claude-spine corpus                   every check, its upstream issue, the date it was filed
  claude-spine buy [--seats N --annual] licence request block (no checkout — you email it)
  claude-spine fixtures init            write a starter fixture file           [pro]
  claude-spine list                     show the checks and what each is for
  claude-spine license                  show licence status

The seven patterns are documented free in the README. This installs them and proves they
fire, which is the part a copied config cannot tell you.
`;

// ONE place for the purchase path. It is deliberately not a URL yet, because the domain is
// not registered and shipping a link that 404s in the buy path is worse than shipping no
// link — it reads as abandoned software. When the page exists this is a one-line edit.
const BUY_URL = process.env.CLAUDE_SPINE_BUY_URL || null;

const PRO_PITCH = `
  Custom fixtures are part of claude-spine pro.

  The checks that ship free are the hazards everyone hits. The command that will actually
  take your system down is yours — your deploy script, your prod database, the internal
  flag that skips migrations. Pro lets you write fixtures for those, commit them beside
  the code, and fail CI the day a guard stops catching one.

  Every incident becomes a fixture. The file turns into a record of everything that has
  ever gone wrong, still being enforced.

  ${BUY_URL ? BUY_URL : 'See the "pro" section of the README for how to get a key.'}
`;

async function main() {
  if (!cmd || has('--help') || has('-h')) return void console.log(USAGE);
  if (has('--version') || has('-v') || cmd === 'version') return void console.log(pkg.version);

  const lic = license.check(root);

  if (cmd === 'license') {
    console.log('');
    if (lic.licensed) {
      console.log(`  plan:  ${lic.plan}`);
      console.log(`  for:   ${lic.sub}`);
      console.log(`  seats: ${lic.seats}`);
    } else {
      console.log(`  plan:  free`);
      console.log(`  ${lic.reason}`);
      console.log(`\n  Core checks and all seven patterns are free and always will be.`);
      console.log(`  Custom fixtures + CI reporters: https://claude-spine.dev/pro`);
    }
    console.log('');
    return;
  }

  if (cmd === 'fixtures') {
    if (argv[1] !== 'init') {
      console.error('  usage: claude-spine fixtures init');
      process.exit(1);
    }
    if (!lic.licensed) return void console.log(PRO_PITCH);
    const dir = path.join(root, 'spine-fixtures');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'example.json');
    if (fs.existsSync(file) && !has('--force')) {
      console.log(`  ${path.relative(root, file)} already exists (--force to overwrite)`);
      return;
    }
    fs.writeFileSync(file, custom.EXAMPLE);
    console.log(`\n  + ${path.relative(root, file)}`);
    console.log(`\n  Edit it, then: claude-spine doctor --fixtures spine-fixtures\n`);
    return;
  }

  if (cmd === 'init') {
    const { written, skipped } = install(root, { force: has('--force') });
    console.log('');
    for (const f of written) console.log(`  + ${f}`);
    for (const f of skipped) console.log(`  = ${f}  (exists, left alone)`);
    if (skipped.length && !has('--force')) {
      console.log(`\n  ${skipped.length} file(s) already present. --force overwrites them.`);
    }
    console.log('\n  verifying...');
    const diag = await diagnose(root);
    console.log(report.print(diag));
    process.exit(diag.ok ? 0 : 1);
  }

  if (cmd === 'doctor') {
    let extra = [];
    const fixturesDir = val('--fixtures');

    if (fixturesDir) {
      if (!lic.licensed) {
        console.log(PRO_PITCH);
        process.exit(1);
      }
      const loaded = custom.load(path.resolve(root, fixturesDir));
      // Bad fixtures are a hard stop. Running a subset while reporting success is exactly
      // the failure this tool exists to prevent — the report would say everything passed.
      if (loaded.errors.length) {
        console.error(`\n  ${loaded.errors.length} problem(s) in ${fixturesDir}:`);
        for (const e of loaded.errors) console.error(`    · ${e}`);
        console.error('');
        process.exit(1);
      }
      extra = loaded.fixtures;
    }

    const diag = await diagnose(root, { extra });
    const reporter = val('--reporter');

    if (has('--json')) {
      console.log(JSON.stringify(diag, null, 2));
    } else if (reporter) {
      if (!REPORTERS[reporter]) {
        console.error(`  unknown reporter: ${reporter} (junit, github, tap)`);
        process.exit(1);
      }
      process.stdout.write(REPORTERS[reporter](diag));
    } else {
      console.log(report.print(diag));
      // Never upsell custom fixtures to someone who has no guards at all — they need `init`,
      // and a paid pitch as the closing line of their first ever run is pure noise.
      if (!lic.licensed && !fixturesDir && !diag.bare) {
        console.log(`  ${diag.results.length} core checks. Your own hazards aren't in here —`);
        console.log(`  claude-spine fixtures init\n`);
      }
    }
    process.exit(diag.ok ? 0 : 1);
  }

  if (cmd === 'corpus') {
    // The subscription promises "new failure modes become checks as they get filed." A promise
    // with no mechanism behind it is the same species as a buy link that 404s, so here is the
    // mechanism: every check, its upstream issue, the date it was filed, in one place. If a
    // month goes by with nothing new in this list, a subscriber can see that and cancel.
    const { FIXTURES } = require('../lib/fixtures');
    const { UPSTREAM, UNTESTABLE } = require('../lib/corpus');
    console.log('');
    console.log(`  ${C_B}corpus${C_X}  ${FIXTURES.length + UPSTREAM.length} checks · ${UPSTREAM.length} traced to filed issues`);
    console.log('');
    console.log('  FROM UPSTREAM BUG REPORTS — issue, date filed, what it catches');
    for (const f of [...UPSTREAM].sort((a, b) => (a.filed < b.filed ? 1 : -1))) {
      console.log(`    ${C_B}#${f.issue}${C_X}  ${f.filed}  ${f.id}`);
      console.log(`      ${f.why.split('.')[0]}.`);
    }
    console.log('');
    console.log('  AUDITS — config faults nothing else reports');
    console.log(`    ${C_B}#75071${C_X}  2026-07-07  one invalid matcher silently disables EVERY hook in the file`);
    console.log(`    ${C_B}#80140${C_X}  2026-07-22  \`if\` scoping fails open on $()/backticks`);
    console.log(`    ${C_B}#78752${C_X}  2026-07-18  deny rules bypassable via 8.3 aliases; Glob ignores wildcards`);
    console.log('');
    console.log('  KNOWN BLIND SPOTS — runtime failures no fixture can catch');
    for (const u of UNTESTABLE) console.log(`    ${C_B}#${u.issue}${C_X}  ${u.what}`);
    console.log(`    the canary exists for these — it times invocation instead of behaviour.`);
    console.log('');
    return;
  }

  if (cmd === 'buy') {
    // THE PAID PATH, WITH NO PAYMENT PROCESSOR.
    //
    // There is no Stripe account yet, and waiting for one would mean shipping a product whose
    // paid tier is a dead end — a README line pointing at nothing. So the request itself is the
    // rail: this prints a complete, machine-readable licence request the buyer can paste into an
    // email, and keys get minted by hand in one command. It scales badly and it works today,
    // which beats scaling well and not existing.
    const seats = parseInt(val('--seats', '1'), 10);
    const org = val('--org', '');
    const annual = has('--annual');
    const price = annual ? seats * 390 : seats * 39;

    console.log('');
    console.log(`  claude-spine pro — ${seats} seat${seats > 1 ? 's' : ''}, ${annual ? 'annual' : 'monthly'}`);
    console.log(`  $${price}${annual ? '/year' : '/month'}${annual ? `  (2 months free vs monthly)` : ''}`);
    console.log('');
    // "There is no checkout page yet" printed here until now — a sentence a stranger reads on
    // the way to closing the tab. The email rail is real and stays, but it is the fallback, and
    // it gets described as what it is (direct billing) instead of as a missing feature.
    const { payUrl, hasCheckout } = require('../lib/pay');
    if (hasCheckout()) {
      console.log(`  ${payUrl(annual ? 'annual' : 'monthly')}`);
      console.log('');
      console.log('  Signed key lands in your inbox on payment. Keys verify offline: no licence');
      console.log('  server, no phone-home, works on air-gapped CI.');
      console.log('');
      return;
    }
    console.log('  Billing is direct — no processor in the middle, no subscription portal that');
    console.log('  forgets to cancel. Send the block below and a signed key comes back within');
    console.log('  24 hours, or I tell you why not.');
    console.log('  Keys verify offline: no licence server, no phone-home, works on air-gapped CI.');
    console.log('  Nothing is charged until the key works in your CI — reply and tell me it did.');
    console.log('');
    console.log('  ── to: cece@siliroid.ai ─────────────────────────────');
    console.log(`  subject: claude-spine pro — ${seats} seat${seats > 1 ? 's' : ''}`);
    console.log('');
    console.log(`  SPINE-REQUEST v1`);
    console.log(`  seats:   ${seats}`);
    console.log(`  term:    ${annual ? 'annual' : 'monthly'}`);
    console.log(`  price:   $${price}`);
    if (org) console.log(`  org:     ${org}`);
    console.log(`  version: ${pkg.version}`);
    console.log('  ─────────────────────────────────────────────────────');
    console.log('');
    console.log(`  Tell me what your guards actually protect and I'll write you fixtures for it.`);
    console.log('');
    return;
  }

  if (cmd === 'adopt') {
    const adopt = require('../lib/adopt');
    const undo = has('--undo');
    const p = adopt.plan(root, { undo });

    if (p.error) {
      console.error(`\n  ${p.error}\n`);
      process.exit(1);
    }
    if (!p.changes.length) {
      console.log(
        undo
          ? '\n  nothing to undo — no wrapped hooks found\n'
          : '\n  nothing to adopt. either your hooks are already wrapped, or the only hooks here are ours (they stamp themselves).\n'
      );
      return;
    }

    console.log(`\n  ${undo ? 'unwrap' : 'adopt'} ${p.changes.length} hook(s) in ${path.basename(p.file)}:\n`);
    for (const c of p.changes) {
      console.log(`    ${c.event}  ${C_B}${c.name}${C_X}`);
      console.log(`      - ${c.from}`);
      console.log(`      + ${c.to}`);
    }

    if (has('--dry-run')) {
      console.log(`\n  dry run — nothing written. drop --dry-run to apply.\n`);
      return;
    }

    const res = adopt.apply(root, { undo });
    console.log(`\n  ${res.applied} rewritten`);
    if (res.backup) console.log(`  backup: ${path.basename(res.backup)}`);
    console.log(
      undo
        ? `\n  your hooks run unwrapped again.\n`
        : `\n  your hooks now stamp the canary. they still run exactly as before —\n` +
            `  stdin, stdout, stderr and exit code all pass straight through.\n` +
            `  reverse any time: claude-spine adopt --undo\n`
    );
    return;
  }

  if (cmd === 'list') {
    const { FIXTURES } = require('../lib/fixtures');
    console.log('');
    for (const f of FIXTURES) {
      console.log(`  [p${f.pattern}] ${f.id}`);
      console.log(`        expect ${f.expect} — ${f.why}`);
    }
    console.log('');
    return;
  }

  console.error(`unknown command: ${cmd}`);
  console.log(USAGE);
  process.exit(1);
}

main().catch((e) => {
  console.error(`  ${e.message}`);
  process.exit(1);
});
