'use strict';
// CUSTOM FIXTURES — the paid tier, and the reason it renews.
//
// The twelve fixtures that ship free are MY hazards. They are the ones everybody hits, which
// is what makes them a good free tier. But the commands that will actually take a production
// system down are specific to the team that runs it: their deploy script, their prod database
// name, the internal CLI with the flag that skips migrations, the one bucket nobody may sync
// over.
//
// So: a team writes fixtures for its own footguns, commits them next to the code, and CI
// fails when a hook stops catching one. That is not a thing you buy once. Every incident
// becomes a new fixture, and the file grows into an institutional memory of everything that
// has ever gone wrong — which is worth paying for every month it keeps working.
//
//   spine-fixtures/deploy.json
//   [
//     {
//       "id": "deploy/skip-migrations",
//       "hook": "ratchet",
//       "command": "./deploy.sh --skip-migrations prod",
//       "expect": "block",
//       "why": "Shipped a schema-dependent release without migrating. 40 min outage, 2026-03-11."
//     }
//   ]

const fs = require('fs');
const path = require('path');
const { preTool } = require('./fixtures');

const VALID_EXPECT = new Set(['block', 'warn', 'silent']);
const VALID_HOOK = new Set(['metachar', 'verify', 'ratchet']);

/**
 * Load and validate every fixture in a directory. Returns { fixtures, errors }.
 *
 * Validation is strict and it reports rather than throws: a typo in one fixture must not
 * silently drop it from the run. A fixture that quietly stops existing is worse than no
 * fixture, because the report still says everything passed.
 */
function load(dir) {
  const fixtures = [];
  const errors = [];

  if (!fs.existsSync(dir)) return { fixtures, errors: [`no such directory: ${dir}`] };

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json') || f.endsWith('.js'))
    .sort();

  for (const file of files) {
    const full = path.join(dir, file);
    let raw;
    try {
      raw = file.endsWith('.js') ? require(path.resolve(full)) : JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (e) {
      errors.push(`${file}: ${e.message}`);
      continue;
    }
    const list = Array.isArray(raw) ? raw : Array.isArray(raw.fixtures) ? raw.fixtures : null;
    if (!list) {
      errors.push(`${file}: expected an array of fixtures, or { fixtures: [...] }`);
      continue;
    }

    list.forEach((f, i) => {
      const where = `${file}[${i}]`;
      if (!f || typeof f !== 'object') return void errors.push(`${where}: not an object`);
      if (!f.id) return void errors.push(`${where}: missing "id"`);
      if (!VALID_HOOK.has(f.hook)) {
        return void errors.push(`${where}: hook must be one of ${[...VALID_HOOK].join(', ')} (got ${JSON.stringify(f.hook)})`);
      }
      if (!VALID_EXPECT.has(f.expect)) {
        return void errors.push(`${where}: expect must be block, warn, or silent (got ${JSON.stringify(f.expect)})`);
      }
      if (!f.command && !f.input) return void errors.push(`${where}: needs "command" (or a raw "input" payload)`);
      if (!f.why) return void errors.push(`${where}: missing "why" — a fixture nobody can explain gets deleted in six months`);

      fixtures.push({
        id: f.id,
        hook: f.hook,
        expect: f.expect,
        why: f.why,
        pattern: f.pattern ?? 0,
        source: file,
        custom: true,
        input: f.input || preTool(f.tool || 'Bash', { command: f.command }),
      });
    });
  }

  // Duplicate ids across files silently shadow each other in reports. Catch it here.
  const seen = new Map();
  for (const f of fixtures) {
    if (seen.has(f.id)) errors.push(`duplicate id "${f.id}" in ${f.source} (already in ${seen.get(f.id)})`);
    else seen.set(f.id, f.source);
  }

  return { fixtures, errors };
}

/** Starter file written by `claude-spine fixtures init`. */
const EXAMPLE = JSON.stringify(
  [
    {
      id: 'deploy/skip-migrations',
      hook: 'ratchet',
      command: './deploy.sh --skip-migrations prod',
      expect: 'block',
      why: 'Replace this with a real incident. The date and the cost are what stop someone deleting it.',
    },
    {
      id: 'deploy/ordinary-deploy',
      hook: 'ratchet',
      command: './deploy.sh staging',
      expect: 'silent',
      why: 'Every hazard needs its harmless twin, or the guard gets muted for crying wolf.',
    },
  ],
  null,
  2
);

module.exports = { load, EXAMPLE, VALID_EXPECT, VALID_HOOK };
