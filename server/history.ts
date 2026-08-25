import Database from 'better-sqlite3';
import { Router } from 'express';
import path from 'node:path';
import { db as leagueDb, tableExists } from './db.js';
import { DATA_DIR, loadConfig } from './config.js';

/**
 * Persistent store that SURVIVES reimports (league.db is rebuilt on every
 * import). Holds rating snapshots for development tracking and the watchlist.
 */
export const historyDb = new Database(path.join(DATA_DIR, 'history.db'));
historyDb.pragma('journal_mode = WAL');
historyDb.exec(`
  CREATE TABLE IF NOT EXISTS rating_snapshots (
    save_name TEXT NOT NULL,
    game_date TEXT NOT NULL,
    player_id INTEGER NOT NULL,
    name TEXT,
    team_id INTEGER,
    org_id INTEGER,
    level INTEGER,
    position INTEGER,
    age INTEGER,
    con REAL, gap REAL, pow REAL, eye REAL, avk REAL, spd REAL,
    conP REAL, gapP REAL, powP REAL, eyeP REAL, avkP REAL,
    stu REAL, mov REAL, ctl REAL,
    stuP REAL, movP REAL, ctlP REAL,
    cur REAL, pot REAL,
    PRIMARY KEY (save_name, game_date, player_id)
  );
  CREATE INDEX IF NOT EXISTS idx_snap_player ON rating_snapshots (save_name, player_id, game_date);
  CREATE TABLE IF NOT EXISTS watchlist (
    save_name TEXT NOT NULL,
    player_id INTEGER NOT NULL,
    name TEXT,
    note TEXT DEFAULT '',
    added_at TEXT,
    updated_at TEXT,
    PRIMARY KEY (save_name, player_id)
  );
  /*
   * Notes kept on a player, one row each rather than one field overwritten.
   *
   * The watchlist already had a note, but it holds a single string tied to
   * watching the man — no good for the thing this is actually for, which is
   * keeping what a member of staff told you. A pitch-count plan for a starter
   * coming off the injured list is worth nothing in a chat thread you will
   * have scrolled past by the time he is throwing again; it belongs on his
   * page, with who said it and the date of the game when they did.
   *
   * Lives in history.db so it survives re-importing the save, which wipes and
   * rebuilds the league database entirely.
   */
  CREATE TABLE IF NOT EXISTS player_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    save_name TEXT NOT NULL,
    player_id INTEGER NOT NULL,
    player_name TEXT,
    source TEXT,
    body TEXT NOT NULL,
    game_date TEXT,
    created_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_notes_player ON player_notes (save_name, player_id);
`);

function currentSaveName(): string {
  return loadConfig().saveName ?? 'unknown';
}

function leagueGameDate(): string | null {
  try {
    const row = leagueDb
      .prepare(
        `SELECT "current_date" AS d FROM leagues WHERE league_id IN
         (SELECT DISTINCT league_id FROM teams WHERE level = 1) LIMIT 1`
      )
      .get() as { d: string } | undefined;
    return row?.d ?? null;
  } catch {
    return null;
  }
}

/**
 * A date OOTP wrote as text, as a number that sorts. `2006-6-9` becomes
 * 20060609, so June the ninth stops outranking June the twenty-third.
 */
const SNAPSHOT_KEY = `(
  CAST(substr(game_date, 1, 4) AS INTEGER) * 10000 +
  CAST(substr(game_date, 6, CASE WHEN substr(game_date, 7, 1) = '-' THEN 1 ELSE 2 END) AS INTEGER) * 100 +
  CAST(substr(game_date, 6 + CASE WHEN substr(game_date, 7, 1) = '-' THEN 2 ELSE 3 END) AS INTEGER)
)`;

/** Capture a ratings snapshot of every rostered player. Idempotent per game date. */
export function takeSnapshot(): { gameDate: string; players: number } | null {
  if (!tableExists('players') || !tableExists('players_batting')) return null;
  const gameDate = leagueGameDate();
  if (!gameDate) return null;
  const saveName = currentSaveName();

  const rows = leagueDb
    .prepare(
      `SELECT p.player_id, p.first_name || ' ' || p.last_name AS name, p.team_id,
              p.organization_id AS org_id, t.level, p.position, p.age,
              b.batting_ratings_overall_contact AS con, b.batting_ratings_overall_gap AS gap,
              b.batting_ratings_overall_power AS pow, b.batting_ratings_overall_eye AS eye,
              b.batting_ratings_overall_strikeouts AS avk, b.running_ratings_speed AS spd,
              b.batting_ratings_talent_contact AS conP, b.batting_ratings_talent_gap AS gapP,
              b.batting_ratings_talent_power AS powP, b.batting_ratings_talent_eye AS eyeP,
              b.batting_ratings_talent_strikeouts AS avkP,
              pi.pitching_ratings_overall_stuff AS stu, pi.pitching_ratings_overall_movement AS mov,
              pi.pitching_ratings_overall_control AS ctl,
              pi.pitching_ratings_talent_stuff AS stuP, pi.pitching_ratings_talent_movement AS movP,
              pi.pitching_ratings_talent_control AS ctlP
       FROM players p
       JOIN teams t ON t.team_id = p.team_id
       LEFT JOIN players_batting b ON b.player_id = p.player_id
       LEFT JOIN players_pitching pi ON pi.player_id = p.player_id
       WHERE p.retired = 0 AND p.team_id > 0`
    )
    .all() as Array<Record<string, number | string | null>>;

  const insert = historyDb.prepare(
    `INSERT OR REPLACE INTO rating_snapshots
     (save_name, game_date, player_id, name, team_id, org_id, level, position, age,
      con, gap, pow, eye, avk, spd, conP, gapP, powP, eyeP, avkP,
      stu, mov, ctl, stuP, movP, ctlP, cur, pot)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const avg = (vals: Array<number | string | null>): number | null => {
    const nums = vals.filter((v): v is number => typeof v === 'number');
    return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
  };
  const insertAll = historyDb.transaction(() => {
    for (const r of rows) {
      const isPitcher = r.position === 1;
      const cur = isPitcher ? avg([r.stu, r.mov, r.ctl]) : avg([r.con, r.gap, r.pow, r.eye, r.avk]);
      const pot = isPitcher
        ? avg([r.stuP, r.movP, r.ctlP])
        : avg([r.conP, r.gapP, r.powP, r.eyeP, r.avkP]);
      insert.run(
        saveName, gameDate, r.player_id, r.name, r.team_id, r.org_id, r.level, r.position, r.age,
        r.con, r.gap, r.pow, r.eye, r.avk, r.spd, r.conP, r.gapP, r.powP, r.eyeP, r.avkP,
        r.stu, r.mov, r.ctl, r.stuP, r.movP, r.ctlP, cur, pot
      );
    }
  });
  insertAll();
  console.log(`[history] snapshot ${gameDate}: ${rows.length} players`);
  return { gameDate, players: rows.length };
}

/**
 * Every snapshot this save has kept, oldest first.
 *
 * Ordered on the date read as a number rather than as text, which is the whole
 * of a bug a reader reported and could not have been expected to diagnose.
 * OOTP writes dates without padding, so as text "2006-6-9" sorts after
 * "2006-6-23" — nine beats two on the first character. His newest snapshot was
 * the twenty-third and the page was certain it was the ninth: it compared
 * everything against the wrong end, offered seven of his eight snapshots in
 * the menu, and listed those seven in an order with no meaning. Three symptoms,
 * one `ORDER BY`.
 *
 * The stored strings are left exactly as they are. They are the key rows are
 * written under and the value the page hands back to ask for a comparison;
 * rewriting them to be tidy would be a migration of somebody's history to fix
 * a sort. The padding is done for display, where it belongs.
 */
export function snapshotDates(): string[] {
  return (
    historyDb
      .prepare(
        `SELECT DISTINCT game_date FROM rating_snapshots WHERE save_name = ?
         ORDER BY ${SNAPSHOT_KEY}`
      )
      .all(currentSaveName()) as Array<{ game_date: string }>
  ).map((r) => r.game_date);
}

// ── Development tracking ────────────────────────────────────────────────

export const historyRoutes = Router();

historyRoutes.get('/development/:orgId', (req, res) => {
  const orgId = Number(req.params.orgId);
  const saveName = currentSaveName();
  const dates = snapshotDates();
  if (dates.length < 2) {
    return res.json({ snapshots: dates.length, dates, changes: null });
  }
  const from = String(req.query.from ?? dates[dates.length - 2]);
  const to = String(req.query.to ?? dates[dates.length - 1]);

  const rows = historyDb
    .prepare(
      `SELECT a.player_id, b.name, b.age, b.position, b.level, b.team_id,
              a.cur AS cur_from, b.cur AS cur_to, a.pot AS pot_from, b.pot AS pot_to,
              a.con AS con_a, b.con AS con_b, a.gap AS gap_a, b.gap AS gap_b,
              a.pow AS pow_a, b.pow AS pow_b, a.eye AS eye_a, b.eye AS eye_b,
              a.avk AS avk_a, b.avk AS avk_b, a.spd AS spd_a, b.spd AS spd_b,
              a.stu AS stu_a, b.stu AS stu_b, a.mov AS mov_a, b.mov AS mov_b,
              a.ctl AS ctl_a, b.ctl AS ctl_b
       FROM rating_snapshots a
       JOIN rating_snapshots b
         ON b.save_name = a.save_name AND b.player_id = a.player_id AND b.game_date = ?
       WHERE a.save_name = ? AND a.game_date = ? AND b.org_id = ?`
    )
    .all(to, saveName, from, orgId) as Array<Record<string, number | string | null>>;

  const changes = rows
    .map((r) => {
      const details: Array<{ rating: string; from: number; to: number }> = [];
      const pairs: Array<[string, string, string]> = [
        ['Contact', 'con_a', 'con_b'], ['Gap', 'gap_a', 'gap_b'], ['Power', 'pow_a', 'pow_b'],
        ['Eye', 'eye_a', 'eye_b'], ['Avoid K', 'avk_a', 'avk_b'], ['Speed', 'spd_a', 'spd_b'],
        ['Stuff', 'stu_a', 'stu_b'], ['Movement', 'mov_a', 'mov_b'], ['Control', 'ctl_a', 'ctl_b'],
      ];
      for (const [label, ka, kb] of pairs) {
        const a = r[ka] as number | null;
        const b = r[kb] as number | null;
        if (a !== null && b !== null && a !== b) details.push({ rating: label, from: a, to: b });
      }
      const curDelta = (r.cur_to as number ?? 0) - (r.cur_from as number ?? 0);
      const potDelta = (r.pot_to as number ?? 0) - (r.pot_from as number ?? 0);
      return {
        player_id: r.player_id,
        name: r.name,
        age: r.age,
        position: r.position,
        level: r.level,
        cur: r.cur_to,
        pot: r.pot_to,
        curDelta: Number(curDelta.toFixed(1)),
        potDelta: Number(potDelta.toFixed(1)),
        details,
      };
    })
    .filter((c) => c.details.length > 0)
    .sort((a, b) => Math.abs(b.curDelta) + Math.abs(b.potDelta) - (Math.abs(a.curDelta) + Math.abs(a.potDelta)));

  res.json({ snapshots: dates.length, dates, from, to, changes });
});

// ── Watchlist ───────────────────────────────────────────────────────────

historyRoutes.get('/watchlist', (_req, res) => {
  const rows = historyDb
    .prepare(`SELECT * FROM watchlist WHERE save_name = ? ORDER BY updated_at DESC`)
    .all(currentSaveName()) as Array<{ player_id: number; name: string; note: string; added_at: string }>;
  // Enrich with live info from the current league DB
  const enriched = rows.map((w) => {
    const p = tableExists('players')
      ? (leagueDb
          .prepare(
            `SELECT p.age, p.position, p.free_agent, t.name AS team_name, t.nickname, t.level
             FROM players p LEFT JOIN teams t ON t.team_id = p.team_id WHERE p.player_id = ?`
          )
          .get(w.player_id) as Record<string, unknown> | undefined)
      : undefined;
    return {
      ...w,
      age: p?.age ?? null,
      position: p?.position ?? null,
      team: p?.team_name ? `${p.team_name} ${p.nickname}` : p?.free_agent === 1 ? 'Free Agent' : null,
      level: p?.level ?? null,
    };
  });
  res.json(enriched);
});

historyRoutes.post('/watchlist', (req, res) => {
  const { player_id, name, note } = req.body as { player_id: number; name?: string; note?: string };
  if (!player_id) return res.status(400).json({ error: 'player_id required' });
  const now = new Date().toISOString();
  historyDb
    .prepare(
      `INSERT INTO watchlist (save_name, player_id, name, note, added_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (save_name, player_id)
       DO UPDATE SET note = COALESCE(excluded.note, note), name = COALESCE(excluded.name, name), updated_at = excluded.updated_at`
    )
    .run(currentSaveName(), player_id, name ?? null, note ?? '', now, now);
  res.json({ ok: true });
});

historyRoutes.delete('/watchlist/:playerId', (req, res) => {
  historyDb
    .prepare(`DELETE FROM watchlist WHERE save_name = ? AND player_id = ?`)
    .run(currentSaveName(), Number(req.params.playerId));
  res.json({ ok: true });
});

historyRoutes.get('/watchlist/:playerId', (req, res) => {
  const row = historyDb
    .prepare(`SELECT note FROM watchlist WHERE save_name = ? AND player_id = ?`)
    .get(currentSaveName(), Number(req.params.playerId)) as { note: string } | undefined;
  res.json({ watched: !!row, note: row?.note ?? '' });
});

// ── Notes on a player ───────────────────────────────────────────────────

historyRoutes.get('/player-notes/:playerId', (req, res) => {
  const rows = historyDb
    .prepare(
      `SELECT id, player_id, player_name, source, body, game_date, created_at
       FROM player_notes WHERE save_name = ? AND player_id = ?
       ORDER BY id DESC`
    )
    .all(currentSaveName(), Number(req.params.playerId));
  res.json({ notes: rows });
});

historyRoutes.post('/player-notes', (req, res) => {
  const { player_id, player_name, source, body } = req.body as {
    player_id?: number;
    player_name?: string;
    source?: string;
    body?: string;
  };
  if (!Number.isFinite(Number(player_id)) || !body || !body.trim()) {
    return res.status(400).json({ error: 'A player and some text are required' });
  }
  const info = historyDb
    .prepare(
      `INSERT INTO player_notes (save_name, player_id, player_name, source, body, game_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      currentSaveName(),
      Number(player_id),
      player_name ?? null,
      source ?? 'You',
      body.trim(),
      // The in-game date, not today's: a plan made in May is judged against the
      // season, and the wall clock means nothing to a save being simmed
      leagueGameDate(),
      new Date().toISOString()
    );
  res.json({ ok: true, id: info.lastInsertRowid });
});

historyRoutes.delete('/player-notes/:id', (req, res) => {
  historyDb
    .prepare(`DELETE FROM player_notes WHERE save_name = ? AND id = ?`)
    .run(currentSaveName(), Number(req.params.id));
  res.json({ ok: true });
});
