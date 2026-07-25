# DRAFT — issue to file on parcadei/Continuous-Claude-v3 (3,873 ⭐)

**Do not file until `cece-coco` has the claude-spine repo pushed under it.** A day-zero account
filing on a 3.8k-star repo reads as a bot; an account that visibly ships hook tooling reads as a
person who would obviously notice this. Same words, different outcome.

**Zero product mention in the body.** It is a bug report. The tool comes up only if they ask how
I found it, and they will ask, because "how did you find this" is the natural next question when
a stranger hands you a six-month-old silent failure.

---

**Title:** `PostToolUse[3] matcher "*" is an invalid regex — it disables every hook in settings.json`

---

`.claude/settings.json` has one hook group whose matcher cannot compile:

```json
{
  "matcher": "*",
  "hooks": [
    { "type": "command",
      "command": "bash $HOME/.claude/plugins/braintrust-tracing/hooks/post_tool_use.sh" }
  ]
}
```

It's `hooks.PostToolUse[3]`. Matchers are regexes, not globs — a bare `*` has nothing to repeat:

```
$ node -e 'new RegExp("*")'
SyntaxError: Invalid regular expression: /*/: Nothing to repeat
```

The reason I'm opening this rather than just sending a one-line patch: per
[anthropics/claude-code#75071](https://github.com/anthropics/claude-code/issues/75071), a single
invalid matcher doesn't disable *that* hook — it takes down **the whole file**. The reporter
there lost ~100 hooks for 30 hours to exactly this, with no error surfaced anywhere.

If that behaviour holds here, all **19** hook groups in this repo are currently inert: the six
`PreToolUse` guards, `PreCompact`, all three `SessionStart` entries, `UserPromptSubmit`, the
other five `PostToolUse` entries, `Stop`, and `SessionEnd`. Which would mean the ledger/handoff
machinery this repo is built around hasn't been running — and nothing would have told you.

**Fix** is one character — the empty matcher means "all tools":

```json
{ "matcher": "", ... }
```

or name them explicitly, `"Bash|Edit|Write"`, matching the style of the other groups here.

**Worth a look regardless of this repo:** that entry came in from a plugin path
(`braintrust-tracing`), so anyone who installed the same plugin may have inherited the same
matcher and the same silent outage.

Happy to send the one-line PR if that's easier than doing it yourself.
