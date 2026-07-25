# Corpus changelog

Every check, the upstream issue it came from, and the date that issue was filed.

This file exists because the paid tier is a promise about *ongoing* work — new failure modes
become checks as they get filed — and a promise with no visible record behind it is just a
sentence on a sales page. If a month goes by with nothing new here, that is visible, and you
should cancel.

The code is MIT and clonable in a minute. This list is the part that only stays current if
somebody keeps reading, and there are **467 open issues** about hooks not firing.

---

## 2026-07-25 — initial corpus

Nine checks, six of them traceable to a filed issue by a named reporter.

### Executable fixtures

| check | issue | filed | reporter |
|---|---|---|---|
| `upstream/exit2-does-not-block-on-windows` | [#80039](https://github.com/anthropics/claude-code/issues/80039) | 2026-07-22 | AngelLCJ |
| `upstream/deny-reason-must-stand-alone` | [#80919](https://github.com/anthropics/claude-code/issues/80919) | 2026-07-24 | jdk415 |
| `upstream/if-condition-fails-open-on-substitution` | [#80140](https://github.com/anthropics/claude-code/issues/80140) | 2026-07-22 | dorcon000-ship-it |
| `upstream/ask-decision-silently-dropped` | [#79449](https://github.com/anthropics/claude-code/issues/79449) | 2026-07-20 | oibrio-build |
| `upstream/exit2-stderr-never-reaches-the-model` | [#78393](https://github.com/anthropics/claude-code/issues/78393) | 2026-07-17 | Fayeeka |
| `upstream/subagent-bash-not-matched` | [#76322](https://github.com/anthropics/claude-code/issues/76322) | 2026-07-10 | sourcesmith |

### Config audits

| audit | issue | filed | what it catches |
|---|---|---|---|
| schema | [#75071](https://github.com/anthropics/claude-code/issues/75071) | 2026-07-07 | one invalid matcher silently disables **every hook in the file** — ~100 hooks dark for 30h |
| `if`-scoping | [#80140](https://github.com/anthropics/claude-code/issues/80140) | 2026-07-22 | `if` conditions fail open on `$()`/backticks, so gated guards have coverage you cannot state |
| deny rules | [#78752](https://github.com/anthropics/claude-code/issues/78752) | 2026-07-18 | 8.3 short-name aliasing on Windows; wildcards Glob does not honour |
| MCP PostToolUse | [#73586](https://github.com/anthropics/claude-code/issues/73586) | 2026-07-02 | **PostToolUse never fires for MCP tool calls** — the matcher is correct, which is why nobody notices |

**On the MCP one.** Reported by Chulf58 over a three-week window with hook dispatch otherwise
healthy, and corroborated independently as the third finding in #75071. It matters more than it
reads: MCP is where the database server, the deploy server and the ticketing integration live.
Anyone who wrote a `PostToolUse` hook to audit or log that surface has **zero coverage on the
highest-consequence calls in their setup**, and every part of the config says otherwise. #77341
reports the same event not firing in daemon/background-job sessions.

### Known blind spots — runtime failures no fixture can catch

These are why the canary exists. A harness that spawns your hook will always find it healthy;
none of these are about the hook being *wrong*, they are about it never being *called*.

| issue | failure |
|---|---|
| [#76322](https://github.com/anthropics/claude-code/issues/76322) | PreToolUse Bash hooks silently stop firing partway through a session |
| [#76897](https://github.com/anthropics/claude-code/issues/76897) | hooks stop firing after `EnterWorktree` switches to a linked worktree |
| [#76413](https://github.com/anthropics/claude-code/issues/76413) | PreToolUse hooks intermittently not invoked at all (VSCode extension host, Windows) |
| [#77480](https://github.com/anthropics/claude-code/issues/77480) | Stop hook does not fire reliably in the VSCode extension (works via CLI) |
| [#79702](https://github.com/anthropics/claude-code/issues/79702) | SessionEnd hooks do not fire on `claude -p` print-mode exit |
| [#80697](https://github.com/anthropics/claude-code/issues/80697) | a hook that fails to *launch* is treated as a deliberate deny — exit-code collision |

---

## How a check gets in here

1. It has to come from a **filed issue by someone who is not me**, with a repro. Not a thing I
   imagined might go wrong.
2. It has to be **testable from config or from a payload**. Runtime failures go in the blind
   spots table instead, honestly, rather than being dressed up as covered.
3. It has to have a **harmless twin** — a case that must *not* fire. A check that only ever
   triggers gets muted within a week, and a muted check is a missed one with extra steps.
4. The `why` has to name the real consequence, with the issue number. A finding nobody can
   explain gets deleted in six months.

`claude-spine corpus` prints this from the source, so it cannot drift from what actually runs.
