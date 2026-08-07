# OOTP Front Office

A local web app that turns an **Out of the Park Baseball 27** save into a front-office
command center: rosters, prospect promotion signals, contract decisions, trade fits,
development tracking, and AI-written beat coverage of your organization.

Everything runs on your own machine. Nothing is uploaded anywhere (the optional AI
features are the one exception — those send your league data to the Anthropic API).

```
OOTP CSV export  →  importer (SQLite)  →  local server  →  browser UI
```

---

## What it does

Pick your organization in the header and every page shows that club's world — the MLB
team and every affiliate down to the DSL. Switch orgs any time to scout another system.

**The app wears your team's colors.** Selecting a club re-themes the entire interface —
backgrounds, panels, borders, and accent — from that team's actual colors in your save,
and shows its logo. Team logos come from your own OOTP installation
(`<save>.lg/news/html/images/team_logos`), so they work offline and are correct for
custom and fictional leagues that have no logo anywhere on the internet.

Every generated palette is checked against WCAG AA contrast so the interface stays
readable no matter how bright or washed-out a club's colors are — a pure-white primary
(the White Sox) falls back to a neutral slate, and a low-luminance accent gets brightened
until it's legible. Run `npm run check:theme` to verify all 30 clubs.

The navigation is grouped by front-office function:

**🏟 Dashboard** — the morning check-in. Pending-decision chips that click through to
the page that resolves them, division standings, last 5 results, upcoming games with
probable starters, hot/cold hitters, the org injury list, and an AI GM briefing.

**📰 Storylines** — AI-written beat coverage of your organization, grounded in your
actual save data.

**⚾ Clubhouse** — running the big-league club

| Page | What you get |
|------|--------------|
| Lineup | Sabermetric (Tango's *The Book*) or traditional ordering, platoon-aware, auto-built against tonight's probable opposing starter |
| Rosters | Any team in your org with scout ratings and sortable stat lines. **Pick your own columns** — 24 batting and 23 pitching stats to choose from, including OPS+, wRC+, ERA+, FIP, wOBA, and BABIP |
| Depth Chart | Positions × affiliates grid, each player with age and current→potential |
| Injury Report | Org-wide trainer's report with estimated return dates |
| Coaching Staff | Coaches, scouts, and farm managers with role-relevant ratings |

**🌾 Farm System** — the pipeline

| Page | What you get |
|------|--------------|
| Prospects | Minor leaguers ranked by promotion signal, self-calibrated to your league's own level averages |
| Development | Scout-rating changes over time — who's improving, who's declining, whose ceiling moved |
| Draft Board | The scouted draft class ranked by ceiling |

**💼 Front Office** — transactions and money

| Page | What you get |
|------|--------------|
| Contracts | Every deal sorted by urgency with re-sign / extend / let-walk recommendations |
| Free Agents | Current market plus everyone hitting free agency after this season |
| Trade Center | Trade analyzer with value/salary swings, AI verdict, plus league-wide fit finder |
| 40-Man Roster | Roster counts, options used, out-of-options, Rule 5 exposure, DFA countdowns |

**📊 League** — reference

| Page | What you get |
|------|--------------|
| Leaderboards | League top-10s with your players highlighted |
| My Watchlist | Star any player and keep your own scouting notes |

Click any player name anywhere for a full dossier: bio, ratings with potential markers,
pitch arsenal and velocity, contract schedule, career history by level, recent game logs,
and injury history.

---

## Requirements

- **OOTP Baseball 27** with at least one save
- **Node.js 20 or newer** — check with `node --version`
  ([download](https://nodejs.org) if you don't have it; the LTS build is fine)
- macOS or Windows
- *(Optional)* An [Anthropic API key](https://console.claude.com) for the AI features

---

## Installation

### 1. Get the code

```bash
git clone https://github.com/lsukev/ootp-front-office.git
cd ootp-front-office
```

### 2. Install dependencies

```bash
npm install
```

This takes a minute or two. It compiles a native SQLite module, so if it fails, see
[Troubleshooting](#troubleshooting).

### 3. Export your league from OOTP

**This is the step people miss.** The app never touches OOTP's binary save files — it
reads the game's own CSV database export, which you generate from inside OOTP:

1. Launch OOTP 27 and load your save
2. Open the **Database Tools** menu (top of the screen)
3. Choose **Global Actions → Export data to CSV files**
4. Let it finish — it writes ~70 files and takes 10-30 seconds

The export lands inside your save folder at `<your save>.lg/import_export/csv/`. You
don't need to remember that path; the app finds it automatically.

### 4. Start the app

```bash
npm run dev
```

Then open **http://localhost:5173** in your browser.

The app scans the standard OOTP 27 save locations and lists what it finds. Click your
save and it imports everything (a full league is ~2.5 million rows and takes about 40
seconds). Saves without a CSV export are shown greyed out.

To stop the app, press `Ctrl+C` in the terminal.

---

## Daily workflow

1. Sim in OOTP as usual
2. When you want fresh data: **Database Tools → Global Actions → Export data to CSV files**
3. The app notices within a few seconds and re-imports automatically

The header always shows when the data was last exported, and the **↻ Refresh** button
forces a re-import on demand.

Each import also snapshots every player's scout ratings into a separate database that
survives re-imports — that's what powers the **Development** page. The more often you
export, the richer your development history gets.

---

## Optional: enable the AI features

Three features call the Anthropic API: **Storylines**, the **GM Briefing** on the
dashboard, and **AI trade verdicts** in the Trade Center. Everything else works without
a key.

1. Get an API key at [console.claude.com](https://console.claude.com) (you'll need to add
   a small amount of credit — each storyline generation costs a few cents)
2. Create a file named `.env` in the project folder:

   ```
   ANTHROPIC_API_KEY=sk-ant-your-key-here
   ```

3. Restart the app (`Ctrl+C`, then `npm run dev`)

`.env` is gitignored and never leaves your machine. If no key is present, the AI buttons
simply explain how to set one up instead of failing.

**What gets sent to Anthropic when you use these features:** your team's standings,
recent results, stat leaders, prospect and contract summaries, and finances — all
fictional game data. Nothing personal, and nothing at all if you never press those
buttons.

---

## Where saves are found

The app auto-detects OOTP 27 saves in these locations:

| Platform | Path |
|----------|------|
| macOS (Mac App Store) | `~/Library/Containers/com.ootpdevelopments.ootp27macqlm/Data/Application Support/Out of the Park Developments/OOTP Baseball 27/saved_games/` |
| macOS (direct download) | `~/Library/Application Support/Out of the Park Developments/OOTP Baseball 27/saved_games/` |
| Windows | `Documents\Out of the Park Developments\OOTP Baseball 27\saved_games\` |
| OneDrive-synced | `~/OneDrive/Documents/Out of the Park Developments/OOTP Baseball 27/saved_games/` |

If your saves live somewhere else, add the path to `saveGameRoots()` in
[`server/paths.ts`](server/paths.ts).

---

## Troubleshooting

**"No OOTP 27 saves detected"**
The app looks in the paths above. Confirm your save is in one of them, or add your
location to `server/paths.ts`.

**Save shows "(no export)" and can't be selected**
You haven't run the CSV export yet, or it went to a different save. Redo step 3 with the
correct save loaded.

**`npm install` fails building `better-sqlite3`**
It needs build tools for the native module.
On macOS: `xcode-select --install`.
On Windows: install the "Desktop development with C++" workload from
[Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/), then retry.

**Port 5173 or 5178 already in use**
Something else is on those ports. Change them in
[`vite.config.ts`](vite.config.ts) (UI) and [`server/index.ts`](server/index.ts) (API).

**A page is empty or a stat looks wrong**
Most likely the export is stale or partial. Re-export from OOTP and hit **↻ Refresh**.

**Development page says it's waiting**
It needs at least two snapshots from two different in-game dates. Sim a few days, export
again, and it'll populate.

---

## How it works

- **Importer** ([`server/importer.ts`](server/importer.ts)) — reads every CSV into SQLite,
  one table per file, columns taken from each file's header row. Deliberately
  schema-tolerant so it survives OOTP updates.
- **Watcher** ([`server/watcher.ts`](server/watcher.ts)) — debounced file watcher that
  re-imports when OOTP writes a fresh export.
- **API** (`server/*.ts`) — Express + better-sqlite3. All analysis happens in SQL and
  plain TypeScript; no external services.
- **UI** (`src/`) — React + Vite.
- **Persistent store** ([`server/history.ts`](server/history.ts)) — a second SQLite
  database for rating snapshots and your watchlist, kept separate so re-imports never
  wipe it.

Two OOTP data quirks worth knowing if you're extending this: dates are unpadded
(`2026-4-9`), so they must be parsed before sorting, and `players_contract.current_year`
counts *completed* contract years, so this season's salary is `salary{current_year}`
(0-indexed).

### Project layout

```
server/           Express API + import pipeline
  importer.ts     CSV → SQLite
  paths.ts        Save auto-detection
  history.ts      Rating snapshots + watchlist (persistent)
  dashboard.ts    Dashboard, injuries, schedule
  org.ts          Depth chart, prospect signals
  contracts.ts    Contract recommendations
  trade.ts        Trade analyzer + fit finder
  rosterops.ts    40-man, leaderboards, staff, draft
  storylines.ts   AI storylines
  ai.ts           AI briefing + trade evaluation
src/
  pages/          One file per page
  playerModal.tsx Player dossier + tooltips
data/             Created at runtime (gitignored)
```

---

## Configurable stat columns

On the Rosters page, **⚙ Columns** opens a picker with every available stat, grouped
into Counting, Rate, and Advanced, each with a plain-English description. Your selection
is saved per batting/pitching and persists across sessions. Hovering any column header
explains what the stat means.

### About OPS+, wRC+, and ERA+

OOTP computes these in-game but **does not include them in the CSV export**, so the app
derives them from the raw counting stats:

- **League baselines are computed from your save**, not hardcoded — per league *and* per
  level, so a Double-A hitter is measured against Double-A rather than the majors.
- **Park factors come from OOTP's own park ratings** (its AVG and HR ratings, blended),
  with the deviation halved because a player only plays half his games at home — the
  standard correction for park-adjusted rate stats.
- **wRC+** uses wOBA linear weights with the run conversion those same weights imply.
- **FIP** is scaled with a league constant so league FIP equals league ERA.

`npm run check:stats` validates the whole engine: it confirms every league's aggregate
line scores exactly 100, which is the definition these stats have to satisfy. A pitcher
with a 0.00 ERA shows **∞** for ERA+, which is what it mathematically is.

## Notes and limitations

- Ratings shown are **your scouts' evaluations**, including their bias — same as what
  you see in-game. They're exported on whatever scale your save uses (20-80 by default).
- Recommendations are decision *aids*, not gospel. Every ranked player shows the reasons
  behind their score so you can judge for yourself.
- Small samples early in a season make prospect and hot/cold signals noisy. Minimums are
  enforced (60 PA / 15 IP for prospects) but a hot April is still a hot April.
- This is an unofficial fan project, not affiliated with or endorsed by Out of the Park
  Developments.

---

## License

MIT — see [LICENSE](LICENSE). Do what you like with it.
