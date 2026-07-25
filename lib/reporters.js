'use strict';
// REPORTERS — machine-readable output, so this runs as a gate instead of a thing someone
// remembers to look at.
//
// A guard suite nobody reads is decoration. The value shows up the day a hook silently
// stops firing and CI is the thing that notices, which means the output has to land where
// people already look: the JUnit panel, the annotation on the diff.

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

/**
 * JUnit XML. Every CI system on earth can read this, which is the only reason to use it.
 * A MISS is a failure. NOISE is a failure too — a guard people mute is a guard that's gone.
 * `absent` is skipped, not failed: a repo that hasn't installed a hook hasn't broken one.
 */
function junit(diag) {
  const rows = diag.results;
  const failures = rows.filter((r) => r.verdict === 'MISS' || r.verdict === 'NOISE');
  const skipped = rows.filter((r) => r.verdict === 'absent');

  const cases = rows
    .map((r) => {
      const name = escapeXml(r.id);
      const cls = escapeXml(`claude-spine.${r.hook}`);
      if (r.verdict === 'pass') return `    <testcase classname="${cls}" name="${name}"/>`;
      if (r.verdict === 'absent') {
        return `    <testcase classname="${cls}" name="${name}"><skipped message="hook not installed"/></testcase>`;
      }
      const msg = escapeXml(`expected ${r.expect}, got ${r.actual}`);
      return (
        `    <testcase classname="${cls}" name="${name}">\n` +
        `      <failure type="${r.verdict}" message="${msg}">${escapeXml(r.why)}</failure>\n` +
        `    </testcase>`
      );
    })
    .join('\n');

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuites name="claude-spine" tests="${rows.length}" failures="${failures.length}" skipped="${skipped.length}">\n` +
    `  <testsuite name="guards" tests="${rows.length}" failures="${failures.length}" skipped="${skipped.length}">\n` +
    `${cases}\n` +
    `  </testsuite>\n` +
    `</testsuites>\n`
  );
}

/**
 * GitHub Actions workflow commands — puts the finding on the diff where it gets read,
 * rather than in a log nobody opens.
 */
function github(diag) {
  const lines = [];
  for (const r of diag.results) {
    if (r.verdict === 'MISS') {
      lines.push(`::error title=claude-spine MISS (${r.id})::Guard stayed silent on a hazard. ${r.why}`);
    } else if (r.verdict === 'NOISE') {
      lines.push(`::warning title=claude-spine NOISE (${r.id})::Guard fired on a harmless command — this is how guards get disabled. ${r.why}`);
    }
  }
  const w = diag.wiring;
  if (w.settingsFound && w.unregistered?.length) {
    lines.push(`::error title=claude-spine wiring::These hooks exist on disk but nothing invokes them: ${w.unregistered.join(', ')}`);
  }
  if (!lines.length) lines.push(`::notice title=claude-spine::All ${diag.counts.pass || 0} guard checks pass.`);
  return lines.join('\n') + '\n';
}

/** Terse one-line-per-failure, for anything that just greps logs. */
function tap(diag) {
  const rows = diag.results;
  const out = [`TAP version 13`, `1..${rows.length}`];
  rows.forEach((r, i) => {
    const n = i + 1;
    if (r.verdict === 'pass') out.push(`ok ${n} - ${r.id}`);
    else if (r.verdict === 'absent') out.push(`ok ${n} - ${r.id} # SKIP hook not installed`);
    else out.push(`not ok ${n} - ${r.id}\n  ---\n  expected: ${r.expect}\n  actual: ${r.actual}\n  why: ${r.why}\n  ...`);
  });
  return out.join('\n') + '\n';
}

const REPORTERS = { junit, github, tap };

module.exports = { REPORTERS, junit, github, tap };
