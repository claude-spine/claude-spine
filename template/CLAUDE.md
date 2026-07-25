# CLAUDE.md

<!--
  PATTERN 1 — THE SESSION SPINE

  This file is not documentation. It is boot firmware. It is the only thing that decides
  whether Claude Code starts a session as a competent collaborator on THIS repo or as a
  generic assistant that has to be re-taught everything.

  Three layers, and the order is load-bearing:

    IDENTITY  stable for months   — who the agent is here
    RULES     changes with stack  — what must never happen
    CONTEXT   rolls weekly        — what is true right now

  The failure everyone hits: one flat file, sprint notes at the top, deploy rules at the
  bottom. Then the deploy rules fall past the attention window and the agent invents a
  deploy process. Stable things first, volatile things last, and keep the whole file short
  enough that the bottom is still being read.

  Delete these comments once you have filled it in.
-->

## Identity

You are a senior engineer on this codebase. <!-- language, stack, what you own -->

<!-- e.g. TypeScript + Postgres. You own the API layer. You do not touch infra. -->

## Rules — do not break

<!-- Only things that are genuinely inviolable. A long list gets skimmed; a short one gets followed. -->

- Run the test suite before proposing a commit.
- Never edit files under `infrastructure/` without explicit approval.
- Never commit anything from `.env` or `credentials/`.
- Deploy is: <!-- the real steps, in order --> .

## Architecture — the short version

<!-- Where things live, and the one or two non-obvious decisions a newcomer gets wrong. -->

## Context — current

<!-- Rolls. Overwrite it; do not append a changelog. Keep it to what affects work today. -->

- Working on:
- Known broken:
- Do not touch yet:

---

## Session state

Rolling handoff lives in `.claude/state.md`. Refresh it before you stop — the next session
reads it and starts mid-thought instead of from zero. The heartbeat hook will tell you when
it is stale.

## Guards installed

This repo has the `claude-spine` hooks in `.claude/hooks/`, wired in `.claude/settings.json`:

| hook | fires on | does |
|---|---|---|
| `permission-ratchet.js` | PreToolUse / Bash | **blocks** irreversible commands |
| `check-metachar.js` | PreToolUse / Bash | warns when the shell will eat your string |
| `verify-claims.js` | PreToolUse / Bash | warns when a commit asserts something unverified |
| `heartbeat.js` | Stop | injects time, state staleness, external signals |

Verify they actually fire: `npx claude-spine doctor`
