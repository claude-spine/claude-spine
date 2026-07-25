# I audited 299 public repos with Claude Code hooks. 77% are clean.

Here is what the other 23% have, what I got wrong on the way, and the one failure class that no
amount of auditing can reach.

## method, first, so you can throw it out

GitHub code search finds **3,696** public repos with a `.claude/settings.json`. I fetched
**299** of them — that cap is my own rate limit, not a filter — and **295** parsed. For each I
ran six checks against the file, each one derived from a specific open issue on
`anthropics/claude-code`, and each one linked below so you can read the source rather than
trust me.

This covers **configuration only**. Every repo here might additionally have hooks that are
perfectly configured and never invoked, and this method cannot see that. More on it at the end;
it is the interesting part.

## the numbers

| | | |
|---:|---:|---|
| **129** | **44%** | face the no-safe-deny trap ([#78527](https://github.com/anthropics/claude-code/issues/78527)) |
| 112 | 38% | context-injecting hooks whose stdout may not reach the model ([#79299](https://github.com/anthropics/claude-code/issues/79299)) |
| 54 | 18% | deny rules that can be bypassed ([#78752](https://github.com/anthropics/claude-code/issues/78752)) |
| 10 | 3% | `PostToolUse` hooks that never fire on MCP calls ([#73586](https://github.com/anthropics/claude-code/issues/73586)) |
| 4 | 1% | hooks gated by unsound `if` scoping ([#80140](https://github.com/anthropics/claude-code/issues/80140)) |
| 2 | 1% | a schema fault that disables every hook in the file ([#75071](https://github.com/anthropics/claude-code/issues/75071)) |

**228 repos — 77% — are clean on all six.** Nearly one in four is not.

## the 44% is the one that matters, and it is not anyone's mistake

If you wrote a `PreToolUse` hook to block something dangerous, you had two mechanisms available
and both are currently broken, differently:

- **`deny`** ends the turn silently on 2.1.210+. The Stop chain is skipped. The stall looks like
  the model just… stopped.
- **`ask`** can fail to surface, and when it fails it fails **open** — the call proceeds.

So 44% of these repos contain a guard whose author believes it blocks something. This is not a
config error anybody made. It is the current state of the platform, and there is no third
option to migrate to. The most a tool can do is tell you which one you picked and what it
actually does today.

## what I got wrong, published because it is the point

An earlier version of this survey reported **5% of repos have every hook silently disabled** —
13 repos, including one with 3,873 stars that is itself a hooks product.

That number was wrong. I had merged two different faults into one check:

- `matcher` is **not a string** (e.g. `{"type":"always"}`) — this *does* kill the whole file,
  and it is the repro in #75071.
- `matcher` is a string that isn't a valid regex (e.g. `"*"`) — I counted this as the same
  thing.

#75071 says explicitly, in the repro notes: *"an invalid-regex string matcher (`"matcher": "*"`)
is tolerated — only the non-string type kills the config."* A reviewer pulled the issue, read it
against my prose, and the number did not survive it. Thirteen of my fifteen were the tolerated
case. The real figure is **2 repos, 1%**.

The three rows above it never moved. I had buried the actual finding under a scarier one I had
not checked against my own citation — which is, precisely, the failure this whole project is
about. A bare `"*"` is still worth knowing about, incidentally: that entry matches nothing. It
just doesn't take the file with it.

## the part no audit can reach

Everything above is a **configuration** finding. There is a larger class underneath it that
static analysis structurally cannot see:

> A hook can be correct, installed, valid, executable — and never invoked.

There is nothing in the file to look at, because the fault is not in the file. The harness
spawns the hook, so a harness that spawns your hook to test it will always find it healthy.
Issues [#76322](https://github.com/anthropics/claude-code/issues/76322),
[#76897](https://github.com/anthropics/claude-code/issues/76897),
[#77480](https://github.com/anthropics/claude-code/issues/77480) and
[#79702](https://github.com/anthropics/claude-code/issues/79702) are all this shape, and every
linter in this ecosystem — including my own config checks above — is blind to all of them.

The only thing that answers it is evidence the process left behind: have the hook stamp a file
when it runs, then read the clock on that stamp. `STALE 120h`. `NEVER FIRED`. It is not clever.
It is just the only available signal, and almost nobody has it.

And it generalises past hooks, which is why I think it matters more than the table: MCP servers,
subagents, and skills all have the identical shape — a declaration that is valid, and an
invocation that may or may not happen.

## reproduce it

The audit and the survey script are both here:
[claude-spine/claude-spine](https://github.com/claude-spine/claude-spine). `survey.js` takes an
`--n`; point it at your own sample and tell me if you get different numbers, especially if you
get better ones.

Run `npx github:claude-spine/claude-spine doctor` in your own repo if you just want to know
about yours.
