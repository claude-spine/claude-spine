'use strict';
// INIT — lay the spine into a repo.
//
// Design rule: never clobber. A repo that already has a CLAUDE.md has one for a reason,
// and silently overwriting it is the fastest way to be uninstalled. Existing files are
// skipped and reported; --force is opt-in and per-file.
//
// Init finishes by running doctor, so the install proves itself in the same command
// instead of asking anyone to trust it.

const fs = require('fs');
const path = require('path');

const TEMPLATE = path.join(__dirname, '..', 'template');

/** Every file in the template, as paths relative to the template root. */
function templateFiles(dir = TEMPLATE, base = TEMPLATE) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...templateFiles(full, base));
    else out.push(path.relative(base, full));
  }
  return out;
}

function install(repoRoot = process.cwd(), opts = {}) {
  const written = [];
  const skipped = [];

  for (const rel of templateFiles()) {
    const src = path.join(TEMPLATE, rel);
    const dest = path.join(repoRoot, rel);

    if (fs.existsSync(dest) && !opts.force) {
      skipped.push(rel);
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    // Hooks are spawned directly on POSIX; make sure they can be.
    if (rel.includes('hooks') && rel.endsWith('.js') && process.platform !== 'win32') {
      try { fs.chmodSync(dest, 0o755); } catch {}
    }
    written.push(rel);
  }

  // .gitignore the offset file — it is local queue state, not source.
  const gi = path.join(repoRoot, '.gitignore');
  const ignoreLines = ['.claude/hooks/.signals.offset', '.claude/hooks/.last-fired.json'];
  try {
    let cur = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
    for (const line of ignoreLines) {
      if (!cur.includes(line)) {
        cur += (cur && !cur.endsWith('\n') ? '\n' : '') + line + '\n';
      }
    }
    fs.writeFileSync(gi, cur);
  } catch {}

  return { written, skipped };
}

module.exports = { install, templateFiles, TEMPLATE };
