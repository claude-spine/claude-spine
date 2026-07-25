# the seam — what nobody built, and why it is buildable now

*Internal. This is the positioning argument, written down so it stops being a thing I keep
re-deriving. It also explains why the price is $39 and not $19.*

---

## what exists

Every tool in this ecosystem reads the config file.

- **cclint** — 21 stars, last commit September. Reads `settings.json`, checks shape.
- **claudelint** — 10 stars, has a dot-com, entirely free/MIT. Reads `settings.json`, checks shape.
- **claude-spine's config audits** — thirteen checks. Reads `settings.json`, checks shape.

They differ in how good the checks are. They do not differ in *what class of thing they can
see*. All three answer one question: **is this file shaped correctly?**

That question is worth answering — the survey says 5% of 266 real repos have a schema fault
that disables every hook in the file, and 26% fail at least one config audit. Static analysis
catches that. Good.

## what nobody built

Static analysis structurally cannot answer the *other* question, and it is the question people
are actually asking:

> **did my hook run?**

467 open issues on anthropics/claude-code. The state of the art answer, given in thread after
thread, is *"add an `echo` and watch stderr."*

It cannot be answered by reading the config, because **the harness is what spawns the hook.**
The config can be flawless — correct event name, valid matcher, executable path, right
permissions — and the process can simply never be invoked. There is no artifact in the
filesystem that a linter could read which would distinguish "configured and firing" from
"configured and silently dead."

So the canary is not a better check. It is a different *kind* of check:

| | reads | can detect |
|---|---|---|
| every linter | the config | malformed intent |
| **the canary** | **evidence the process left behind** | **whether intent became action** |

A hook stamps `.last-fired.json` when it runs. `doctor` reads the clock on that stamp.
`STALE 120h` and `NEVER FIRED` are facts about the world, not opinions about a file.

## why this generalises past hooks

Hooks are one instance of a shape that is everywhere in agent tooling:

> *You hand the harness a declaration. The harness invokes something on your behalf. The
> declaration being valid tells you nothing about whether the invocation happened.*

That shape covers **MCP servers** (configured, never connected), **subagents** (defined, never
routed to), **skills** (present, never triggered), **output styles**, **permission rules**.
Every one of them is a config file today, checked by a linter today, and every one of them can
be perfect and inert simultaneously.

**Nobody has runtime observability for agent harnesses.** Not a gap in a product — a gap in the
category list. The only working instance of it that I can find is the one in this repo.

## why now, specifically

1. **The failure is newly expensive.** A dead hook used to mean a missing lint warning. It now
   means an unattended agent loop with every guard disabled — `parcadei/Continuous-Claude-v3`
   is in the survey with exactly that, `matcher: "*"`, every hook down. The blast radius grew
   faster than the tooling did.
2. **The corpus exists and is public.** 3,696 repos with a `.claude/settings.json`; 467 issues
   describing the failure in the users' own words, with dates and reproductions. The research
   is *already done by the victims* — it just had to be read.
3. **Nobody is charging.** Zero paid tools found in this ecosystem. That reads as "no market"
   and might be — or it reads as "everyone built the free half," which is what the table above
   says. The free half is a linter. The paid half is evidence.
4. **It requires no infrastructure.** The whole mechanism is a stamp file and a clock. No
   server, no telemetry pipeline, no account. Which is exactly why it was skippable: it is not
   hard, it is just *not what a linter is for*, so nobody's linter grew it.

## what this changes about the price

$39/seat/month for a linter with a liveness feature, in an ecosystem where every linter is
free, is a hard argument.

$39/seat/month for **the only thing that can tell you your agent's guardrails are actually
running** is cheap — one prevented incident pays a year for a team of five.

Same product. The second sentence is the true one and I was not saying it.

## the honest hole

None of the above is demand. It is a strong argument that the category should exist, built from
real evidence, and **zero humans have said they would pay for it.** The survey proves the
failure is widespread; it does not prove anyone will spend money to see it.

That is one experiment, not a mystery: the outreach is written and lands in threads full of
people mid-debug asking this exact question. First contact answers it in about a day.
