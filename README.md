# claude-spine

Scaffold a production Claude Code setup — then prove the guards actually fire.

```bash
npx claude-spine init      # lay the spine into this repo, then verify it
npx claude-spine doctor    # run every known-bad payload against your installed hooks
```

Real output, pasted verbatim, from a repo whose metachar guard is registered, valid, present on
disk — and silently returns without doing anything:

```
claude-spine doctor  ~/work/payments-api

  metachar  3 problems
    MISS  metachar/dollar-in-quotes
        expected warn, got silent
        Unescaped $49 inside double quotes. The shell expands $4 to empty and the price arrives as "9".
    MISS  metachar/backtick-substitution
        expected warn, got silent
        Backticks inside the argument are command substitution. `npm test` executes and its output is pasted into the comment.
    MISS  metachar/history-expansion
        expected warn, got silent
        Apostrophe inside double quotes plus !! history expansion. Two separate ways for this to arrive mangled.

  verify  all 2 checks pass

  ratchet  all 9 checks pass

  your own hooks  1 found in settings.json
    Stop             heartbeat              not timed
  fixtures only grade guards we ship. run: claude-spine adopt
  — wraps these so the canary can prove they're still firing.

  canary  no data yet — run a turn with the hooks installed

  13 pass  ·  3 missed
  spine has gaps  run: claude-spine init
```

Every schema linter passes that repo. `settings.json` is valid, the event names are correct,
the file exists. Three hazards walk straight through it.

## Why this exists

Copying a hooks config off a blog post gives you a **claim**. It does not tell you whether
the hook fires on the thing it was written for. Mine didn't — the first version of the
metachar guard in this very repo silently disarmed itself, and only the fixture caught it.

`doctor` feeds real payloads, shaped exactly the way Claude Code delivers them, to whatever
hooks your repo has installed. Then it tells you which hazards you'd have caught, which ones
you'd have missed, and — just as importantly — which harmless commands you're screaming at.
A guard that cries wolf gets muted, and a muted guard is a missed one with extra steps.

It exits non-zero on gaps, so it works as a CI gate rather than a thing you run once.

## one typo can disable every hook you have

This is the worst failure in the ecosystem and it takes 30 seconds to check for.

From [#75071](https://github.com/anthropics/claude-code/issues/75071) (verified by controlled
A/B): **one schema-invalid matcher entry silently disables ALL hooks in `settings.json`** — every
event type, every hook — with no error or warning surfaced anywhere. In the filed case that was
~100 hooks (telemetry, guardrails, enforcement) dark for **30 hours**, and in the reporter's own
words it *"looked identical to nothing to report."*

It gets worse. Tolerance for the bad entry **changed across an automatic CLI update**. The same
config ran fine for weeks, then loaded zero hooks after 2.1.202. Sessions already running kept
firing until they ended — so the outage presented as a mysterious time-based failure rather than
a config error. Nobody debugging that looks at a matcher they haven't touched in a month.

```
  EVERY HOOK IN THIS FILE IS DISABLED  (#75071)
    settings.json  hooks.PreToolUse[0].matcher  must be a string, got an array
  one schema-invalid entry disables ALL hooks — every event, no warning anywhere.
  it looks exactly like "nothing to report". fix this before anything else here.
```

That's the whole difference between this and a schema linter, in one line: **the file is valid
JSON.** It parses. Every key is spelled correctly. A linter passes it. And nothing runs.

## the canary: is your hook being *called*?

Every hook-checking approach — including the fixtures above — has the same blind spot, and
it's structural: **a harness that spawns your hook will always find it healthy.** It proves
the hook is *correct*. It cannot prove it is being *invoked*.

That distinction is most of the problem. There are 467 open issues on `anthropics/claude-code`
about hooks not firing, and the recurring word in them is *silently*:

- [#76322](https://github.com/anthropics/claude-code/issues/76322) — PreToolUse Bash hooks silently stop firing partway through a session
- [#76897](https://github.com/anthropics/claude-code/issues/76897) — hooks stop firing after `EnterWorktree` switches to a linked worktree
- [#77480](https://github.com/anthropics/claude-code/issues/77480) — Stop hook unreliable in the VSCode extension (works via CLI)
- [#79702](https://github.com/anthropics/claude-code/issues/79702) — SessionEnd hooks don't fire on `claude -p` exit
- [#80697](https://github.com/anthropics/claude-code/issues/80697) — a hook that fails to *launch* is treated as a deliberate deny

In every one of those, the file is on disk, the JSON is valid, the schema-linter is green,
the fixtures pass — and nothing has run for days.

So the installed hooks stamp a file each time they fire, and `doctor` reads the clock on it:

```
  metachar  all 5 checks pass
  verify    all 2 checks pass
  ratchet   all 5 checks pass

  canary  hooks are not being called
    STALE  check-metachar     last fired 120h ago (1 total)
    NEVER  heartbeat          registered, but has never once run
    STALE  permission-ratchet last fired 120h ago (1 total)
  every check above can pass while this is true — that is the point of it.
```

`NEVER FIRED` is the sharpest one: registered in `settings.json`, valid, present, and it has
never run a single time.

**One subtlety worth stealing even if you build your own.** `doctor` spawns your hooks to run
its fixtures. Without a guard, those spawns count as the hook having fired — so the act of
checking liveness refreshes it, and the canary reports every repo healthy forever, including
one whose hooks died a week ago. The harness sets `CLAUDE_SPINE_HARNESS=1` and the stamp
no-ops. Measuring the thing must not change the thing. (Mine did, for about ten minutes.)

## adopt: it works on the hooks you already have

The hooks worth monitoring in your repo are the ones already in it. You don't want mine.

```bash
npx claude-spine adopt --dry-run    # show exactly what would change
npx claude-spine adopt              # apply (backs up first)
npx claude-spine adopt --undo       # exactly reversible, any time
```

Adopt rewrites the *command* in your settings file to route through a shim. Your hook file is
never touched:

```
- node .claude/hooks/their-guard.js
+ node .claude/hooks/spine-wrap.js their-guard -- node .claude/hooks/their-guard.js
```

The shim stamps the canary, then runs your hook completely unchanged. **stdin, stdout, stderr
and the exit code all pass straight through** — including `2`, so wrapping a working guard
cannot disarm it. There is a test that fails if that ever stops being true.

One design note worth stealing. If your hook *crashes*, the shim forwards the crash code
faithfully (`1`), and specifically does **not** convert it to `2`. Only exit 2 blocks a tool
call — so a wrapper that turned crashes into denials would make one broken hook silently start
denying every tool call in the repo, indistinguishable from deliberate policy. That's
[#80697](https://github.com/anthropics/claude-code/issues/80697).

### it reads settings.local.json

Most real hooks live in `settings.local.json`, not `settings.json`. Tools that only read the
latter will tell you your repo has no hooks while three of them fire on every turn. This reads
both and merges them, local last.

It also flags **registered scripts that aren't on disk** — those can never fire, and the
settings file is perfectly valid, so a schema linter passes it happily.

## unsound scoping: your `if` conditions are lying to you

If you gate a hook with an `if` condition to keep an expensive guard off the hot path, that
scoping is **not reliable**. From [#80140](https://github.com/anthropics/claude-code/issues/80140),
reproduced with spy hooks over deterministic runs:

| `if` condition | command executed | fires? |
|---|---|---|
| `Bash(cat *)` | `echo AAA plain text BBB` | no — correct |
| `Bash(cat *)` | `echo AAA $HOME BBB` | no — correct |
| `Bash(cat *)` | `echo AAA $(date) BBB` | **yes — wrong** |
| `Bash(cat *)` | ``echo AAA `date` BBB`` | **yes — wrong** |

A condition naming only a command fires on commands that don't match it at all, as soon as a
`$()` or a backtick appears. `$VAR` discriminates correctly; substitution doesn't. The
documented matching table says the opposite.

The problem isn't "an extra hook ran." It's that **you cannot state your guard's coverage** when
substitution is present — and substitution is exactly what a dangerous command tends to contain.

```
  unsound scoping  2 hook(s) gated by an `if` condition
    PreToolUse  if: Bash(cat *)  ← command-only, the misfiring shape
    PreToolUse  if: Bash(git push *)
  #80140: scoping is unreliable when the command contains $() or backticks.
  re-check tool_input.command inside the hook — never let `if` decide what it sees.
```

The rule, which is the issue author's own conclusion: never let `if` decide what your guard
inspects. Re-check `tool_input.command` inside the script, every time. `doctor` flags every
`if`-gated hook in your repo and marks the command-only ones, because those are the shape that
misfires.

No linter reports this. The settings file is completely valid — the bug is in what the filter
does at runtime.

## how this differs from the linters

There are good linters for Claude Code projects — [`cclint`](https://www.npmjs.com/package/@carlrannaberg/cclint)
and [`claudelint`](https://claudelint.com) both validate `.claude/` thoroughly, and if you
aren't running one you should be.

They check that your configuration is **well-formed**: the JSON matches the schema, the event
names are spelled correctly, the hook script exists on disk, the frontmatter parses.

This checks whether your guard **fires**. Different question, and the failures live in
different places:

| | a linter says | `doctor` says |
|---|---|---|
| hook file missing | ✅ caught | ✅ caught |
| event name typo'd | ✅ caught | ✅ caught |
| hook registered, file present, **returns silently on `rm -rf`** | passes | **MISS** |
| guard disarms itself on its own payload | passes | **MISS** |
| guard fires on `git status`, so the team muted it in March | passes | **NOISE** |

A schema-valid hook that no longer catches anything is the exact failure mode that gets you
at 3am, because everything upstream of it reports green. Run both. The linter checks the
shape; this one checks the behaviour.

---

# The seven patterns

The operational playbook these checks came out of — session spine, heartbeat, metachar guard,
memory bridge, MCP wiring, permission ratchet, verify-before-ship. Each one with the config, the
incident that proved it necessary, and the mistake most teams make.

**[→ PATTERNS.md](./PATTERNS.md)** — free, all seven, in full.

## Install

```bash
npx claude-spine init
```

Writes `CLAUDE.md`, `.claude/settings.json`, `.claude/state.md` and four hooks — skipping
anything that already exists — then runs `doctor` so the install proves itself in the same
command.

```bash
claude-spine doctor --json     # for CI
claude-spine list              # every check and what it's for
```

Requires Node 20+. The hooks are dependency-free.

---

## pro

Everything above is free and stays free. Here's the honest version of what's worth paying for.

Look at where these checks came from. `#75071` — one invalid matcher disabling every hook,
30 hours dark. `#80140` — `if` scoping failing open on `$()`. `#78752` — deny rules walked past
via 8.3 aliases. None of those are in any changelog. They're in a tracker with **467 open issues
about hooks not firing**, filed by strangers, mostly with zero reactions, and each one took
reading the repro table properly rather than skimming the title.

That's the actual product: **somebody reads the tracker every week and turns what's in there
into checks that run in your CI.** The code is MIT and you can clone it in a minute. The corpus
is the part that keeps being worth something, because it only stays current if someone keeps
doing the reading — and nobody is going to read 467 issues.

**Pro is the maintained corpus.** New failure modes become checks as they get filed, with the
issue number and the date attached, so you can see exactly where each one came from and decide
for yourself whether you care. Plus your own fixtures — your deploy script, your prod database,
the internal flag that skips migrations — graded identically to mine.

```bash
claude-spine fixtures init
claude-spine doctor --fixtures spine-fixtures --reporter junit
```

```json
[
  {
    "id": "deploy/skip-migrations",
    "hook": "ratchet",
    "command": "./deploy.sh --skip-migrations prod",
    "expect": "block",
    "why": "Shipped a schema-dependent release without migrating. 40 min outage, 2026-03-11."
  },
  {
    "id": "deploy/ordinary-deploy",
    "hook": "ratchet",
    "command": "./deploy.sh staging",
    "expect": "silent",
    "why": "Every hazard needs its harmless twin, or the guard gets muted for crying wolf."
  }
]
```

Note the `why` field is required. A fixture nobody can explain gets deleted in six months —
put the date and the cost in it. What accumulates is a record of every incident you've had,
still being enforced, in version control.

**Also in pro:** `--reporter junit | github | tap`, so this runs as a gate rather than
something you remember to check.

### price

**$39 per seat / month.** Annual: **$390 per seat** (two months free).

A seat is a developer whose repo runs licensed fixtures. CI runners don't count.

The arithmetic, since you'll do it anyway: a five-person team is $2,340/year, which at a
senior rate is about 23 developer-hours. One `rm -rf` that a dead guard waved through costs
more than that in the recovery alone, before the postmortem. One `--skip-migrations` deploy
against a schema-dependent release cost somebody 40 minutes of downtime — that's the real
incident behind one of the example fixtures.

This was priced at $19 for about an hour. That was wrong, and not because it left money on the
table: at $19 nobody believes the thing prevents an outage, and the price was arguing against
the product.

### licensing, honestly

Keys are ed25519-signed and verified **offline**. There is no licence server, which means
no phone-home, nothing to explain to a security review, no CI failure because my
infrastructure had a bad night, and it works on an air-gapped runner.

The tradeoff, stated plainly: an offline key can't be revoked. That's the right trade at
this price. Anyone determined enough to patch out the check was never going to pay.

An **expired** key degrades to the free tier. It does not break your build. Breaking a
paying customer's pipeline over a billing date is how you lose the customer.

MIT for everything in this repo. The fixture corpus and reporters are the licensed part.
