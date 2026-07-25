# The seven patterns

*The operational playbook behind [claude-spine](./README.md). Free, all of it — the tool
installs these and then proves they fire, which is the part a copied config cannot tell you.*


These are free. All of them, in full. The tool installs them and verifies them; the
thinking below is yours either way.

## 1. The session spine

`CLAUDE.md` is not documentation. It is boot firmware — the only thing deciding whether the
agent starts as a collaborator on *your* repo or a generic assistant that must be re-taught
every morning.

Three layers, and the order is load-bearing:

| layer | changes | contents |
|---|---|---|
| **Identity** | monthly | who the agent is here, what it owns, what it doesn't touch |
| **Rules** | when the stack changes | the inviolable few — deploy steps, security boundaries |
| **Context** | weekly | what's true right now: in progress, known broken, don't-touch-yet |

**The mistake:** one flat file with sprint notes at the top and deploy rules at the bottom.
The deploy rules fall past the attention window and the agent invents a deploy process.
Stable first, volatile last, and short enough that the bottom still gets read.

## 2. The heartbeat

An agent has no clock and no inbox. Between turns it isn't waiting — it isn't running. It
cannot know the build finished, that forty minutes passed, or that someone replied.

The `Stop` hook is the seam: whatever it prints becomes context for the next turn. Print the
time. Print how stale your session state is. Drain a `signals.jsonl` that *any* external
process can append to — CI, deploy scripts, webhooks, a chat bridge.

```bash
echo '{"text":"CI green on main"}' >> .claude/hooks/signals.jsonl
```

**The mistake:** consuming that queue by rewriting the file. It's read by byte offset; rewrite
it and you redeliver the entire backlog. Track the offset, never rewrite in place. (Ask me how
I know.)

## 3. The metachar guard

Shells interpret characters. When an agent builds a string containing `$`, backticks, `!` or
nested quotes and passes it to Bash as an argument, the shell rewrites the content *before*
the command sees it. Best case the message arrives mangled. With backticks, the embedded text
**executes**.

```
WRONG   send-message "the tier is $49 and here's the `config`"
        → $4 expands to nothing, `config` runs as a command
        → arrives as: "the tier is 9 and here's the "

RIGHT   write(content, "/tmp/msg.txt")
        send-message --file /tmp/msg.txt
        → the shell only ever sees a filename
```

**The mistake, and it's subtle:** writing the guard to skip commands that mention `--file`,
then testing that against the raw command string. A *payload* containing the text `--file`
now silences the guard for its own command. The hook stays installed, reports nothing, and
protects nothing. Test against the command's structure with quoted bodies stripped out.

**The second mistake:** matching `\$[A-Za-z_]`. `$4` is a positional parameter, so every
price in every string — `$49`, `$1200` — walks straight through a letters-only pattern. That
is the most common real case there is.

## 4. The memory bridge

A session ends and everything in the agent's head is gone. `.claude/state.md` is the bridge:
what's half-built, what's decided, what's blocked, what's next. Written for someone who knows
nothing and has five seconds.

**The mistake:** appending. A handoff note that grows becomes long, then stale, then unread.
Overwrite it. The heartbeat nags when it goes stale.

## 5. MCP wiring that survives load

Custom tool servers fail in ways that look like the agent being stupid. Rules that hold up:
one responsibility per server; timeouts on every call; return structured errors instead of
throwing; never block the event loop on a subprocess; make every tool idempotent, because it
*will* be called twice.

**The mistake:** a tool that returns prose on failure. `"Something went wrong"` gives the
agent nothing to route on. Return the code, the input that failed, and what to try instead.

## 6. The permission ratchet

Allowlists solve half the problem — they stop prompts for safe reads. Then the prompting
gets exhausting and people widen the list until it means nothing. The ratchet is the other
jaw: a short, explicit **deny** list of the genuinely irreversible, which no amount of
allowlist widening can open.

`rm -rf` · `git push --force` · `git reset --hard` · `DROP`/`TRUNCATE` · `git branch -D` ·
`chmod 777` · `curl | sh`

Note the split: the metachar guard **warns**, because judgment applies. The ratchet **denies**,
because by the time a warning is read, the delete has happened.

**How it denies, and the honest floor.** There are two documented ways to deny a `PreToolUse`
call and they are mutually exclusive — exit 2 makes Claude Code read stderr and *discard
stdout*, so you cannot do both:

| | |
|---|---|
| `exit 2` + stderr | legacy. Confirmed **not to block on Windows** ([#80039](https://github.com/anthropics/claude-code/issues/80039)) |
| `exit 0` + JSON on stdout | documented preferred path — `hookSpecificOutput.permissionDecision: "deny"` |

The shipped ratchet uses the JSON form, because a guard built on exit 2 reports itself
installed and green on Windows while every `rm -rf` sails through. On a runtime old enough not
to parse the JSON, it degrades to the normal permission prompt rather than a hard stop — a
weaker floor, stated here rather than papered over. A guard whose limits are undocumented is
how people end up trusting one that isn't there.

`doctor` grades both forms as a block, so it won't mark a correctly-written modern hook as a
mere warning. (Mine did, for about an hour this morning.)

**The mistake:** a long deny list. Add merely-annoying commands and the whole thing gets
bypassed within a week. Every entry should be something you cannot undo from inside the repo.

## 7. Verify before ship

The dominant failure of a coding agent is not writing bad code. It's asserting something it
didn't check: *all tests pass* (never ran them), *updated five files* (opened two), *the
endpoint returns 200* (inferred from the handler). The assertion is fluent and confident,
which is exactly why it survives review.

Catch the moment a claim becomes permanent — a commit message, a PR body, a release note —
and name it out loud. The hook can't know whether you verified. It doesn't need to. Either
you have the receipt or you notice you don't.

**The mistake:** blocking on it. A false positive that stops a commit is worse than a prompt
answered in one line.

---

