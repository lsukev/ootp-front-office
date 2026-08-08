# Forum post draft — OOTP Developments forums (Utilities / Tools section)

**Suggested thread title:**
`[UTILITY] OOTP Front Office v0.4 — desktop front-office dashboard for your save (Mac & Windows, free, open source)`

The body below uses BBCode. Paste it with the editor in **source / plain-text mode**
(the "A" toggle) so the tags render instead of showing literally.

If you already posted the earlier version of this thread, post the "What's new in 0.4"
section as a reply instead of starting over.

---

[B]OOTP Front Office[/B] — a free desktop app that turns your OOTP 27 save into the front-office screens I always wanted

I kept doing the same thing every session: bouncing between six or seven screens to work out who was ready for a call-up, whose contract was about to become a problem, and whether the guy hitting .310 in Double-A was actually good or just old for the level. Eventually it seemed easier to build the thing than keep clicking around, so here it is.

It runs on your machine, reads OOTP's own CSV export, and never touches your save files. No account, no server, nothing uploaded.

[B]Download (Mac and Windows):[/B]
[URL="https://github.com/lsukev/ootp-front-office/releases"]https://github.com/lsukev/ootp-front-office/releases[/URL]

[B]Source (MIT):[/B]
[URL="https://github.com/lsukev/ootp-front-office"]https://github.com/lsukev/ootp-front-office[/URL]

[SIZE="3"][B]What's new in 0.4[/B][/SIZE]

Most of this came out of playing with the earlier build and getting annoyed at what was still missing.

[B]Pitching Staff.[/B] The one I use most. It answers a question the roster page structurally can't: who can actually throw tonight. Availability is worked out from game-by-game pitch counts, not season totals, because a reliever with a tidy 2.40 ERA is still no use to you if he threw 38 pitches yesterday. So instead of a stat line you get "back-to-back days," "47 pitches in three days," or "available." The rotation follows your save's own projected starters, with days rest and when each man is next up. Injured arms drop into a separate depth section rather than sitting in the rotation as if they were pitching, which is what an earlier build did and it drove me up the wall.

[B]Schedule.[/B] The season as series rather than a wall of games, with results behind you and probable starters ahead. It opens on the series you're in the middle of. OOTP doesn't store a series ID anywhere, so these get stitched together from runs of consecutive games against the same opponent at the same park.

[B]Payroll and Budget.[/B] Committed money by season out six years, plotted against your budget, plus what comes off the books after this year and who's opted or optioned into what. It also tracks dead money, which is what tripped me up building it: my first version came out about six million light against the game's own payroll number, and the missing piece was three players I'd traded away whose salary the Yankees are still eating. That's in there now, and the totals match the save exactly.

[B]Season Trends.[/B] Cumulative run differential across the year, rolling ten-game scoring and run prevention, and win percentage. Mostly useful for the gap between record and differential. My Yankees sat 9-9 with a plus-one differential, which is about as honest a .500 team as you'll find, and the curve makes that obvious in a way the standings row doesn't.

[B]Standings and player search.[/B] Full league standings with run differential and streaks, and a search across every player in the league, majors and minors, filterable by level or free agency.

[B]Tooltips on everything.[/B] Hover any column header anywhere in the app and it tells you what the number means and, more to the point, why you'd care. Not just "OPS+ is on-base plus slugging, adjusted" but why run differential predicts better than record does, or what happens when a player runs out of options. If you've been nodding along at wRC+ without being totally sure, this is for you.

[B]An Ask panel.[/B] There's an "Ask" button in the header now that opens a chat panel. You can ask things like "who should I call up," "which contracts should I worry about," or "can Bednar pitch tonight," and it answers from your save. It works by calling the app's own screens rather than making things up, so it can't tell you something different from what the Standings page says, and it shows you which lookups it ran. This one needs an Anthropic API key, same as the other AI bits.

[B]Automatic updates.[/B] The app checks for a new version on startup and offers it. Nothing downloads until you click and nothing installs until you restart. Worth noting: if you're on 0.2 or earlier you'll need to grab this one by hand, since those builds shipped before the updater existed.

[SIZE="3"][B]The rest of it[/B][/SIZE]

Pick your organization and every page shows that club's world, big-league team down through every affiliate. The interface takes on your team's colors and logo out of your own save, so custom and fictional leagues work fine.

[B]Dashboard[/B] — standings, last five, upcoming games with probables, hot and cold bats, the injury list, and chips for whatever decisions are pending.

[B]Farm system[/B] — prospects ranked by promotion signal, measured against that level's own averages in your league rather than hardcoded numbers, so a Double-A bat is judged against Double-A. Development tracking snapshots every player's scout ratings on each export, so after a couple of exports you can see exactly which ratings moved and on whom. As far as I know the game doesn't surface that anywhere. There's a draft board too.

[B]Front office[/B] — contracts sorted by urgency with re-sign, extend, or walk recommendations that understand service time, so a deal that "expires" without six years is correctly read as team control rather than free agency. Plus a trade analyzer with a league-wide fit finder, the free agent market including everyone actually reaching free agency this offseason, and 40-man tracking for options, Rule 5, and DFA clocks.

[B]Clubhouse[/B] — lineup builder, sabermetric per The Book or traditional, platoon-aware and built against tonight's actual probable starter. Rosters, depth chart, injuries, coaching staff.

[B]Stats[/B] — OPS+, wRC+, ERA+, FIP, wOBA, BABIP and the rest. OOTP doesn't export these, so they're computed from league baselines drawn from your own save and park factors from your own ballparks. Pick which of the 24 batting and 23 pitching columns you want to see.

Click any player name anywhere for the full card: bio, ratings with potential, pitch arsenal and velocity, contract schedule, career history by level, recent game logs, injuries.

[SIZE="3"][B]Getting started[/B][/SIZE]

[LIST=1]
[*]Download and install, .dmg for Mac or .exe for Windows.
[*]In OOTP, open your save and go to Database Tools, then Global Actions, then Export data to CSV files.
[*]Open the app and pick your save. It finds them on its own, or you can browse if your install is somewhere unusual.
[/LIST]

Re-export whenever you want fresh numbers and the app picks it up within a few seconds. A full league runs about 2.5 million rows and imports in roughly 40 seconds.

[SIZE="3"][B]Fair warnings[/B][/SIZE]

[LIST]
[*]Windows will throw a SmartScreen warning. Click More info, then Run anyway. The build isn't code-signed; a certificate runs a few hundred a year and I'd like to know people actually want this first. The Mac build is signed and notarized, so it just opens.
[*]The bullpen availability thresholds are my judgment, not gospel. Two straight days or 50-plus pitches in three days reads as unavailable. If your manager runs a pen differently, tell me and I'll make it configurable.
[*]Ratings are your scouts' opinions, bias included, exactly as in-game.
[*]Development tracking needs two exports before it has anything to compare.
[*]April samples are noisy. There are minimums in place, 60 PA and 15 IP, but a hot April is still a hot April.
[*]Built and tested against OOTP 27. The importer tolerates schema drift on purpose, but I can't promise anything about other versions.
[*]Not affiliated with OOTP Developments. Just a fan project.
[/LIST]

[SIZE="3"][B]What I'd like to hear[/B][/SIZE]

[LIST]
[*]Does it find your save? If not, what's your setup: custom path, cloud sync, older install?
[*]Do the contract and prospect calls match your own read of your roster, and where do they feel wrong?
[*]What do you check every single session that this still doesn't help with?
[/LIST]

Reply here or open an issue on GitHub. MIT licensed, so fork it and do what you like with it.
