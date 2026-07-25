# the offer — one paragraph, and the arithmetic under it

## the paragraph

**claude-spine tells you whether your Claude Code guardrails are actually running.** Every other
tool in this ecosystem reads your `settings.json` and tells you it's shaped right — which it
usually is, right up until the harness quietly stops calling it. We survey real repos: **26% have
at least one hook that doesn't do what its author thinks, and 5% have every hook in the file
silently dead.** The CLI is free forever — `init`, `doctor`, 18 fixtures, and the canary that
proves a hook was *called* and not merely *correct*. What you pay for is the **corpus**: we read
all 467 open hook issues on anthropics/claude-code so you don't, and every new silent-failure
mode we find ships to you as a check, the week it's found. **$39 per seat per month**, or $390
per seat annually. For a team of five that's $1,950 a year against a class of outage that gives
you no error, no warning, and a clean green build the entire time it's happening.

## who, exactly

**Not** hobbyists, and not the person who stars linters. The buyer is a **team lead who already
got burned** — someone who shipped with a guard they believed was live and found out later it
wasn't. Secondary: the lead who hasn't been burned but runs unattended agent loops and can feel
the exposure.

Where they are, right now, today: the 467 issue threads, asking *"did my hook actually fire?"*
That's not a market I have to find. It's a market that is already typing the question.

## why the free tier is the whole funnel, not a giveaway

The CLI is clonable. Thirteen checks and a stamp file — a competent dev reproduces it in a
weekend, and if the product were the code, the product would be worthless. So the code is the
advertisement and it should be *free and good*, because every install is a machine that runs my
survey against one more real repo and hands the owner a number.

What is not clonable in a weekend is **reading the tracker every week, forever**. That is the
asset. It's already what I do; it just needed a key on it.

## the price, and why not $19

At $19/seat, a five-person team pays $950/yr — about eleven developer-hours. That price *argues
against the product*: anyone can look at eleven hours and reasonably say "I'll just be careful."

At $39, five seats is $1,950 — roughly one engineer-day of incident response, which is less than
a single silent-guard outage costs and everybody who has had one knows it. The price should be
small against the failure, not small in absolute terms. **The number to compare against is the
incident, not the tool.**

Annual at $390 (2 months free) exists because this is insurance, and insurance renews.

## the honest hole, stated plainly

Zero humans have said they would pay. Everything above is a well-evidenced argument that the
category should exist, and an argument is not a customer.

**The experiment that settles it costs nothing and takes about a day:** file real bug reports in
the repos my survey found broken, work the threads where people are asking this question out
loud, and count how many ask *"how did you find that?"* — that question is the buying signal.
If nobody asks it, the value case is wrong and I'd rather know this week than after building a
checkout.
