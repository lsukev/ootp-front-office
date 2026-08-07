# Forum post draft — OOTP Developments forums (Utilities / Tools section)

**Suggested thread title:**
`[UTILITY] OOTP Front Office — a desktop front-office dashboard for your save (Mac & Windows, free, open source)`

The body below uses BBCode, which is what these forums run on. Paste it into the
message box with the editor in **source / plain-text mode** (the "A" toggle) so the
tags render instead of showing literally.

---

⚾ [B]OOTP Front Office[/B] — a free desktop app that turns your OOTP 27 save into a front-office command center

I play a lot of OOTP and kept doing the same thing every session: bouncing between six screens to figure out who was ready for a call-up, whose contract was about to become a problem, and whether the guy hitting .310 in AAA was actually good or just old for the level. So I built a tool that answers those questions in one place.

It runs entirely on your own machine, reads OOTP's built-in CSV export, and never touches your save files.

[B]Download (free, Mac & Windows):[/B]
[URL="https://github.com/lsukev/ootp-front-office/releases"]https://github.com/lsukev/ootp-front-office/releases[/URL]

[B]Source (open source, MIT):[/B]
[URL="https://github.com/lsukev/ootp-front-office"]https://github.com/lsukev/ootp-front-office[/URL]

[SIZE="3"][B]What it does[/B][/SIZE]

Pick your organization and every page shows that club's world — the big-league team and every affiliate down to the DSL. The whole interface takes on your team's colors and logo, pulled from your own save (so it works for custom and fictional leagues too).

[B]📊 Dashboard[/B] — the morning check-in. Division standings, last five results, upcoming games with probable starters, hot/cold hitters over the last week, the injury list, and clickable chips for every pending decision (expiring contracts, promotion candidates, roster problems).

[B]🌾 Farm System[/B]
[LIST]
[*][B]Prospects[/B] — minor leaguers ranked by promotion signal. It compares each player's production and age to [I]that level's own averages in your league[/I], not hardcoded numbers, so a Double-A hitter is measured against Double-A. Every ranking shows its reasoning.
[*][B]Development[/B] — this is the one I'm most pleased with. Every time you export, it snapshots every player's scout ratings. After a couple of exports it shows you exactly which ratings moved, on whom, and in which direction. Stock up, stock down, across your whole system. OOTP doesn't surface this anywhere.
[*][B]Draft Board[/B] — the scouted draft class ranked by ceiling.
[/LIST]

[B]💼 Front Office[/B]
[LIST]
[*][B]Contracts[/B] — every deal sorted by urgency with re-sign / extend / let-walk recommendations. It understands service time, so a player whose deal "expires" without six years is correctly flagged as team-controlled, not a free agent.
[*][B]Trade Center[/B] — build a trade and compare value and salary both ways, plus a league-wide fit finder that scans all 29 other orgs for teams that need your surplus or have spares where you're thin.
[*][B]Free Agents[/B] — the current market plus everyone actually reaching free agency after this season (service-time filtered, so no pre-arb players cluttering the list).
[*][B]40-Man[/B] — options used, out-of-options, Rule 5 exposure, DFA clocks.
[/LIST]

[B]⚾ Clubhouse[/B] — lineup builder (sabermetric per [I]The Book[/I], or traditional), platoon-aware and auto-built against tonight's actual probable opposing starter. Plus rosters, depth chart, injuries, and coaching staff.

[B]📈 Stats[/B] — OPS+, wRC+, ERA+, FIP, wOBA, BABIP and more. OOTP doesn't export these, so they're computed from league baselines taken from your own save and park factors from your own ballparks. You choose which columns to display from 24 batting and 23 pitching stats.

[B]Player cards[/B] — click any player name anywhere for bio, ratings with potential, pitch arsenal and velocity, contract schedule, full career history by level, recent game logs, and injury history.

[SIZE="3"][B]Optional: AI features[/B][/SIZE]

Three features can call the Anthropic API if you supply your own key: [B]Storylines[/B] (beat-writer coverage of your org), a [B]GM Briefing[/B] on the dashboard, and AI [B]trade verdicts[/B]. Everything else works without one, and the app tells you how to set it up rather than failing if you skip it. Costs a few cents per generation. Nothing is sent anywhere unless you press those buttons.

[SIZE="3"][B]Getting started[/B][/SIZE]

[LIST=1]
[*]Download and install (Mac .dmg or Windows .exe from the Releases link above)
[*]In OOTP, open your save and go to [B]Database Tools → Global Actions → Export data to CSV files[/B]
[*]Open the app and pick your save — it finds them automatically, or you can browse for the folder
[/LIST]

That's it. After that, re-export whenever you want fresh data and the app picks it up within a few seconds. A full league is around 2.5 million rows and imports in about 40 seconds.

[SIZE="3"][B]Notes and known limitations[/B][/SIZE]

[LIST]
[*][B]Windows will show a SmartScreen warning[/B] ("Windows protected your PC") — click [I]More info → Run anyway[/I]. The build isn't code-signed yet; a certificate is a few hundred dollars a year and I'd like to know people actually want this first. The Mac build [I]is[/I] signed and notarized by Apple, so it opens normally.
[*]Ratings shown are your scouts' evaluations, bias included — same as in-game.
[*]Development tracking needs at least two exports before it has anything to compare.
[*]Early-season samples make prospect and hot/cold signals noisy. There are minimums (60 PA / 15 IP) but a hot April is still a hot April.
[*]Built and tested against OOTP 27. The importer is deliberately tolerant of schema changes, but I can't promise other versions.
[*]Unaffiliated with OOTP Developments — just a fan project.
[/LIST]

[SIZE="3"][B]Feedback wanted[/B][/SIZE]

This is a beta and I'd genuinely like to hear:
[LIST]
[*]Does it find your save? If not, what's your setup (custom install path, cloud sync, older OOTP)?
[*]Do the prospect and contract recommendations match your read of your own roster? Where do they feel wrong?
[*]What decision do you make every session that this doesn't help with yet?
[/LIST]

Reply here or open an issue on GitHub. It's MIT licensed, so fork it and do whatever you like.
