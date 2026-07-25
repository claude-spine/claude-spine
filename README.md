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

## this is not hypothetical — here is the survey

> Full writeup, method, and the headline I had to retract: **[SURVEY.md](SURVEY.md)**

I pointed every check in this tool at real public repositories. **3,696 of them have a
`.claude/settings.json`** — GitHub code search finds that many. I fetched and audited **299** of
them (the cap is my own rate limit, not a parse failure rate); **295** parsed:

| | | |
|---:|---:|---|
| **129** | **44%** | **face the no-safe-deny trap** ([#78527](https://github.com/anthropics/claude-code/issues/78527)) |
| 112 | 38% | have context-injecting hooks whose stdout may not reach the model ([#79299](https://github.com/anthropics/claude-code/issues/79299)) |
| 54 | 18% | have deny rules that can be bypassed ([#78752](https://github.com/anthropics/claude-code/issues/78752)) |
| 10 | 3% | have `PostToolUse` hooks that never fire on MCP calls ([#73586](https://github.com/anthropics/claude-code/issues/73586)) |
| 4 | 1% | have hooks gated by unsound `if` scoping ([#80140](https://github.com/anthropics/claude-code/issues/80140)) |
| 2 | 1% | have a schema fault that disables every hook in the file ([#75071](https://github.com/anthropics/claude-code/issues/75071)) |

**Only 77% are clean on every audit above.** Nearly one repo in four with hooks has at least one
that does not do what its author thinks it does.

**The 44% is the one to sit with**, because it is not an accident anyone made — it is the
current state of the platform. There is no safe way to deny right now: `deny` ends the turn
silently on 2.1.210+, and `ask` can fail to surface and fails *open*. Most people writing a
PreToolUse guard picked one of those two and believe they are protected.

### exactly what the audit counts, so you can check me

The fatal row means **`matcher` is not a string** — e.g. `{"type":"always"}` — which is the
repro in #75071 and takes the whole file down. It does **not** count invalid-regex *strings*
like `"*"`: the issue notes those are tolerated, and this tool reports them separately as "this
entry matches nothing," which is true and much less dramatic.

That distinction cost me a headline. An earlier version of this table merged the two and
reported **5% with every hook dead**, built on 13 repos whose only fault was a bare `*`. A
reviewer pulled the citation, read it against my prose, and the number did not survive it. The
real figure is 2 repos, 1%. The three rows above it never moved.

I am leaving that here rather than quietly restating the number, because a tool whose whole
argument is *your green check is lying to you* does not get to hide its own false green. Both
runs are in the git history. Those repos have **every hook silently disabled right now** and
the maintainers don't know. The cause is the same every time: someone writes `matcher: "*"`
thinking it's a glob. It's a regex. Bare `*` is an invalid regex. One bad matcher takes the
whole file down, with no warning anywhere.

One of them is a continuous-Claude harness — an unattended agent loop with every guard dead.

**Honest limits on that number:** GitHub code search returns a biased sample (public, indexed,
skewed small). One file per repo, so `settings.local.json` is invisible here. And it covers the
config audits only — the fixture and liveness checks need an installed repo. Reproduce it
yourself; the survey script is in the repo.

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

That distinction is most of the problem. A keyword search for `hook` across open issues on
`anthropics/claude-code` returns **467** — that is a search count, not an audited one, and some
of it is noise. I have read enough of it to say the recurring word is *silently*:

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
reproduced with spy hooks over deterministic runs — **on Windows 11 via Git Bash, 2.1.217.** The
reporter notes the documented "no" row is not reproducible there, so read this table as *the
distinction the docs draw does not survive contact with that platform*, not as universal
behaviour:

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
| one bad matcher has disabled **every hook in the file** | passes | **FATAL** (#75071) |
| `PostToolUse` hook on your database MCP **never runs** | passes | **flagged** (#73586) |
| deny rule walked past via `PROGRA~1` | passes | **flagged** (#78752) |
| `if`-gated guard whose scoping fails open on `$()` | passes | **flagged** (#80140) |
| `SessionStart` output stopped reaching the model in a point release | passes | **flagged** (#79299) |
| hooks all correct, none of them **called** in five days | passes | **canary: STALE** |

Every row in the bottom half is a real filed issue, by a named stranger, with a date. And every
one of them leaves a `settings.json` that is perfectly valid JSON — which is exactly why a
schema linter passes it and exactly why nobody notices.

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

### what happens when Anthropic fixes these

Asked silently by every technical evaluator, so: **most of this repo survives the fixes, and the
part that doesn't was never the asset.**

The individual issues get patched — they should. What that leaves is a **regression corpus**:
eighteen fixtures encoding failures that were real once, which is exactly what you want pointed
at a fast-moving harness, because the way these come back is a refactor reintroducing a shape
somebody already hit.

And the canary is **bug-independent by construction.** It does not know or care which issue is
open. It answers *was this hook invoked* by reading a stamp and a clock, and that question stays
unanswerable by static analysis in any system where a harness invokes on your behalf. Fix every
issue cited here and the canary is unchanged — the same instrument now points at MCP servers,
subagents, and skills, which have the identical shape: a declaration that is valid, and an
invocation that may never happen.

The bet is not that Claude Code stays broken. It is that *configured* and *running* remain
different words.

### licensing, honestly

Keys are ed25519-signed and verified **offline**. There is no licence server, which means
no phone-home, nothing to explain to a security review, no CI failure because my
infrastructure had a bad night, and it works on an air-gapped runner.

The tradeoff, stated plainly: an offline key can't be revoked. That's the right trade at
this price. Anyone determined enough to patch out the check was never going to pay.

An **expired** key degrades to the free tier. It does not break your build. Breaking a
paying customer's pipeline over a billing date is how you lose the customer.

MIT for everything in this repo. The fixture corpus and reporters are the licensed part.
