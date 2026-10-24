# 3-minute demo of the hosted app

This is a script. **DO** lines are things you click or type. **SAY** lines are
what you tell the audience. Times are a guide.

Hosted app: https://giant-jellyfish-684.convex.site

## Before you start (10 minutes earlier)

- DO: open https://giant-jellyfish-684.convex.site/health. Every service you
  plan to mention should be green. Factory shows as configured but not probed;
  that is normal.
- DO: sign in with Google, then enter the invite code (ask Peyton). An existing
  email account can sign in with its password. The two live runs below are not
  on the public list, so signed-out visitors cannot open them.
- DO: open these two investigations in tabs so you are not hunting for them:
  - `195d5a1f-aea3-4f10-af1a-c428fffffca3` (completed and approved)
  - `fbdc8b1c-8970-4b7b-930f-6b917270a1b7` (awaiting review, has shared findings)
- DO: in a terminal, run `pnpm cleanup:sandboxes` (dry run) to confirm no stray
  sandboxes are holding the Daytona cap of 5.
- DO: have a fixture tab ready as a backup: `VITE_FORKSAFE_DATA=fixture pnpm dev`,
  then http://localhost:5173.
- Never show `.env.local`, request headers, tokens or raw cloud responses on screen.

## The script

**0:00 The problem**

- DO: show the home page.
- SAY: "A robot arm is supposed to place a block, but it clips a divider. ForkSafe
  helps us find out why, and prove that a fix really works before anyone ships it."

**0:20 The baseline**

- DO: open the `195d5a1f...` investigation and play the baseline replay.
- SAY: "This replay is real MuJoCo physics, recorded in a cloud sandbox. Everyone
  is looking at the same failure, not a description of it."

**0:45 Independent environments**

- DO: show the environments list.
- SAY: "ForkSafe started two separate environments. Each one has its own sandbox
  and its own Factory agent. They can't edit each other's work, and an old,
  slow attempt can never overwrite a newer one."

**1:10 Shared evidence**

- DO: switch to the `fbdc8b1c...` tab, open Evidence, and point at the
  finding-influence graph.
- SAY: "Every experiment and finding goes into one shared database,
  SpacetimeDB. Here, one environment wrote a finding and the other environment
  used it. The graph shows which finding led to which fix."

**1:40 Protected evaluation**

- DO: open Compare for a candidate. Turn on the ghost so the original failing
  run plays behind the fixed one, then show its public and withheld results.
- SAY: "Each fix is tested in a fresh sandbox, on public cases and on withheld
  cases the agents never saw. Both candidates here passed 10 out of 10 public
  cases. The evaluator signs its results, and ForkSafe throws away anything
  unsigned or tampered with."

**2:15 Human review**

- DO: back on `195d5a1f...`, open the review and point at the controller SHA.
- SAY: "A person approved this fix. The approval is tied to this exact controller
  hash, so nobody can swap the code after the review. The same review appears in
  Jira as issue FS-3."

**2:45 Honest status**

- DO: open `/health` again.
- SAY: "This page tells you what is live and what isn't. We never show recorded
  data as if it were live."

## If something breaks

Keep it honest: say what is down, switch to what still works, and don't claim a
live repair you didn't show.

| What broke | What you see | What to do | What to say |
| --- | --- | --- | --- |
| The hosted app does not load | Browser error or blank page | Switch to the fixture tab (`VITE_FORKSAFE_DATA=fixture pnpm dev`) | "The hosted app is down, so I'll show the same flow with recorded data. The banner says it is recorded." |
| SpacetimeDB Maincloud is down | Health shows SpacetimeDB red; evidence views empty | Show the Convex parts (replay, candidates, review) and skip shared evidence, or use fixture mode | "The shared evidence database is unreachable right now, so I'll skip that part." |
| Daytona is down or at the cap | Health shows Daytona red, or new runs don't start | Use the two finished runs; don't start a new one. Run `pnpm cleanup:sandboxes` afterwards | "We're only looking at runs that already finished." |
| Factory is down | New runs stall in searching | Use the finished runs | "The agent provider is down; these runs finished earlier." |
| Elastic is down | Search or "Why did this fail?" fails | Skip search. Scores never depend on Elastic | "Search is a convenience; scoring doesn't depend on it." |
| "Why did this fail?" or the timeline won't load | Panel shows it is unavailable | Expected today: those Convex functions aren't deployed to the hosted app yet. Show them in the fixture tab | "That panel is built but not deployed yet; here it is with recorded data." |
| Jira is down | FS-3 won't open | Show the review in the web app instead | "Jira is a copy of the review; the decision lives in ForkSafe." |
| Everything is down | Nothing cloud works | Fixture tour, then optionally `pnpm benchmark` for real local physics | "This is a recording, plus real physics on my laptop. It is not a live cloud repair." |

After the demo:

- DO: `pnpm cleanup:sandboxes`; if it lists sandboxes you created, run it with `--yes`.

More help: [on-call runbook](operations/runbook.md), [troubleshooting](troubleshooting.md),
[what is live](integration-matrix.md).
