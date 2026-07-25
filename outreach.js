#!/usr/bin/env node
'use strict';
// OUTREACH — turn survey findings into individually-verified bug reports, one at a time.
//
// The survey found 15 public repos whose entire hooks file is dead. Each one is a real person
// with a real silent outage, and telling them is genuinely useful whether or not it ever sells
// anything. That is the whole basis on which this is allowed to exist: if the report weren't
// worth sending for free, sending it wouldn't be worth anything.
//
// THREE RULES, ENFORCED IN CODE RATHER THAN IN GOOD INTENTIONS:
//
//   1. RE-VERIFY BEFORE POSTING. The survey is a snapshot. Between then and now the maintainer
//      may have fixed it, moved the file, or deleted the repo. Posting a stale "your hooks are
//      broken" is worse than posting nothing — it is the exact failure this product sells
//      against, committed by the product's own outreach. So every post re-fetches the live file
//      and re-runs the audit, and aborts if the fault is gone.
//
//   2. ONE PER INVOCATION. Fifteen issues from a fresh account in an hour is a spam flag, and
//      the flag lands three weeks later when the name is on everything. Paced by default.
//
//   3. NO PRODUCT IN THE BODY. Not modesty — mechanics. A stranger's tracker is their space;
//      a bug report that sells is spam, and one that just helps is a permanent receipt. If they
//      ask how it was found, that is the conversation, and they ask more often than not.
//
//   node outreach.js              list what's pending, verified live
//   node outreach.js --show REPO  print the exact issue body that would be filed
//   node outreach.js --post       verify + file the next one (needs credentials/github-cececoco)

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HOME = path.join(__dirname, '..', '..');
const SENT = path.join(__dirname, '.outreach-sent.json');
const FINDINGS = path.join(__dirname, 'survey-findings.json');
const S = require('./lib/settings');

// cece-coco's own token. Deliberately NOT falling back to the siliroid token: posting as the
// company account is the one outcome the separate identity exists to prevent, and a silent
// fallback would produce exactly that while looking like it worked.
const TOKEN_PATH = path.join(HOME, 'credentials', 'github-cececoco');

function token() {
  if (!fs.existsSync(TOKEN_PATH)) return null;
  const t = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
  return t || null;
}

function gh(args, tok) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    shell: true,
    env: { ...process.env, GH_TOKEN: tok },
  });
}

function sent() {
  try { return JSON.parse(fs.readFileSync(SENT, 'utf8')); } catch { return {}; }
}

function markSent(repo, url) {
  const s = sent();
  s[repo] = { at: new Date().toISOString(), url };
  fs.writeFileSync(SENT, JSON.stringify(s, null, 2));
}

// Re-run the real audit against the repo's CURRENT settings.json. Returns the live fault list,
// or null if the file is gone / unparseable / fixed.
function verifyLive(repo, tok) {
  let raw;
  try {
    const b64 = gh(['api', `repos/${repo}/contents/.claude/settings.json`, '--jq', '.content'], tok).trim();
    raw = Buffer.from(b64, 'base64').toString('utf8');
  } catch { return null; }

  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'spine-verify-'));
  try {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), raw);
    const fatal = S.auditSchema(dir).filter((f) => f.fatal);
    return fatal.length ? fatal : null;
  } catch { return null; }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
}

function body(repo, fatal, hookCount) {
  const f = fatal[0];
  const many = fatal.length > 1;
  return `\`.claude/settings.json\` has ${many ? `${fatal.length} hook groups whose matchers cannot compile` : 'a hook group whose matcher cannot compile'}:

${fatal.map((x) => `- \`${x.where}\` — ${x.what}`).join('\n')}

Matchers are regexes, not globs, so a bare \`*\` has nothing to repeat:

\`\`\`
$ node -e 'new RegExp("*")'
SyntaxError: Invalid regular expression: /*/: Nothing to repeat
\`\`\`

The reason I'm opening an issue rather than sending a one-line patch: per
[anthropics/claude-code#75071](https://github.com/anthropics/claude-code/issues/75071), one
invalid matcher doesn't disable *that* hook — it takes down **the whole file**. The reporter
there lost ~100 hooks for 30 hours to this, with nothing surfaced anywhere.

If that holds here, ${hookCount ? `all **${hookCount}** hook groups in this repo are` : 'every hook in this file is'} currently inert, and nothing would have told you.

**Fix** is one character — an empty matcher means "all tools":

\`\`\`json
{ "matcher": "", ... }
\`\`\`

or name them explicitly, e.g. \`"Bash|Edit|Write"\`.

Happy to send the PR if that's easier.`;
}

function title(fatal) {
  const f = fatal[0];
  return f.what.includes('valid pattern')
    ? `${f.where.replace(/^hooks\./, '')} is an invalid regex — it disables every hook in settings.json`
    : `${f.where.replace(/^hooks\./, '')}: ${f.what} — disables every hook in settings.json`;
}

function main() {
  const argv = process.argv.slice(2);
  const findings = JSON.parse(fs.readFileSync(FINDINGS, 'utf8'));
  const fatalRepos = findings.hits.filter((h) => h.fatal.length);
  const done = sent();
  const pending = fatalRepos.filter((h) => !done[h.repo]);

  const tok = token();
  const showIdx = argv.indexOf('--show');

  if (showIdx !== -1) {
    const repo = argv[showIdx + 1];
    const hit = fatalRepos.find((h) => h.repo === repo) || fatalRepos[0];
    const fatal = hit.fatal.map((s) => {
      const i = s.indexOf(': ');
      return { where: s.slice(0, i), what: s.slice(i + 2) };
    });
    console.log(`\n=== ${hit.repo} ===\nTITLE: ${title(fatal)}\n\n${body(hit.repo, fatal, null)}\n`);
    return;
  }

  console.log(`\n  ${fatalRepos.length} repos with a fatal schema fault · ${Object.keys(done).length} contacted · ${pending.length} pending\n`);
  for (const h of pending) console.log(`    ${h.repo}  ${h.fatal.length} fault(s)`);

  if (!argv.includes('--post')) {
    console.log(`\n  --show <repo>   print the exact issue body`);
    console.log(`  --post          verify live, then file the next one${tok ? '' : '   (blocked: no cece-coco token)'}\n`);
    return;
  }

  if (!tok) {
    console.log(`\n  BLOCKED: ${TOKEN_PATH} does not exist.`);
    console.log(`  Not falling back to the siliroid token on purpose — posting as the company`);
    console.log(`  account is the exact outcome the separate identity exists to prevent.\n`);
    process.exit(1);
  }

  const next = pending[0];
  if (!next) { console.log('\n  nothing pending.\n'); return; }

  console.log(`\n  verifying ${next.repo} is still broken...`);
  const live = verifyLive(next.repo, tok);
  if (!live) {
    console.log(`  FIXED OR GONE — skipping, and marking so it is never posted.`);
    markSent(next.repo, 'skipped: fault no longer present at post time');
    return;
  }
  console.log(`  still broken: ${live.map((f) => f.where).join(', ')}`);

  const t = title(live);
  const b = body(next.repo, live, null);
  const tmp = path.join(require('os').tmpdir(), `spine-issue-${Date.now()}.md`);
  fs.writeFileSync(tmp, b);
  const url = gh(['issue', 'create', '--repo', next.repo, '--title', JSON.stringify(t), '--body-file', JSON.stringify(tmp)], tok).trim();
  fs.rmSync(tmp, { force: true });
  markSent(next.repo, url);
  console.log(`  filed: ${url}\n`);
}

main();
