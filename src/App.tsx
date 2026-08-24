import { useCallback, useEffect, useState } from 'react';
import { setRatingRounding, setRatingScaleMax } from './ratingScale';
import {
  getOrgs, getSaves, getStatus, isStaticSite, setConfig, setStaticSite, triggerImport,
  type Org, type SaveInfo, type Status,
} from './api';
import { RosterPage } from './pages/Roster';
import { DepthChart } from './pages/DepthChart';
import { Prospects } from './pages/Prospects';
import { Contracts } from './pages/Contracts';
import { Payroll } from './pages/Payroll';
import { FreeAgents } from './pages/FreeAgents';
import { Lineup } from './pages/Lineup';
import { Pitching } from './pages/Pitching';
import { Schedule } from './pages/Schedule';
import { Trends } from './pages/Trends';
import { Storylines } from './pages/Storylines';
import { LeagueRecap } from './pages/LeagueRecap';
import { Dashboard } from './pages/Dashboard';
import { Development } from './pages/Development';
import { TradeCenter } from './pages/TradeCenter';
import { RosterCrunch } from './pages/RosterCrunch';
import { Injuries } from './pages/Injuries';
import { Leaderboards } from './pages/Leaderboards';
import { Staff } from './pages/Staff';
import { Watchlist } from './pages/Watchlist';
import { Draft } from './pages/Draft';
import { Franchise } from './pages/Franchise';
import { OrgComparison } from './pages/OrgComparison';
import { Players } from './pages/Players';
import { Standings } from './pages/Standings';
import { PlayerModal } from './playerModal';
import { Nav, type NavEntry } from './Nav';
import { applyTeamTheme, type ThemeMode } from './theme';
import { TeamLogo , setLogoToken } from './TeamLogo';
import { FolderPicker } from './FolderPicker';
import { Settings, type AppSettings } from './pages/Settings';
import { UpdateBadge } from './Updater';
import { Chat } from './Chat';
import { apiGet, apiPost } from './api';

type Page =
  | 'dashboard' | 'storylines' | 'recap' | 'rosters' | 'depth' | 'prospects' | 'development' | 'draft' | 'franchise' | 'orgcompare'
  | 'contracts' | 'crunch' | 'injuries' | 'freeagents' | 'trades' | 'lineup' | 'leaders'
  | 'staff' | 'watchlist' | 'players' | 'standings' | 'pitching' | 'schedule' | 'payroll' | 'trends' | 'settings';

/**
 * Grouped by front-office function: what you do daily (Dashboard, Storylines),
 * running the big-league club (Clubhouse), your own pipeline (Farm System),
 * transactions (Front Office), and everything league-wide, including the
 * amateur draft class, which belongs to nobody until it is drafted (League).
 */
const NAV: Array<NavEntry<Page>> = [
  { kind: 'link', page: 'dashboard', label: 'Dashboard', hint: '🏟' },
  { kind: 'link', page: 'storylines', label: 'Storylines', hint: '📰' },
  {
    kind: 'group', label: 'Clubhouse', icon: '⚾',
    items: [
      { page: 'schedule', label: 'Schedule', hint: 'Series by series, with probables' },
      { page: 'lineup', label: 'Lineup', hint: "Tonight's card, platoon-aware" },
      { page: 'pitching', label: 'Pitching Staff', hint: 'Rotation, bullpen, who can throw tonight' },
      { page: 'rosters', label: 'Rosters', hint: 'Any team in the org' },
      { page: 'depth', label: 'Depth Chart', hint: 'Positions across every level' },
      { page: 'injuries', label: 'Injury Report', hint: 'Who is out and for how long' },
      { page: 'staff', label: 'Coaching Staff', hint: 'Coaches, scouts, farm managers' },
    ],
  },
  {
    kind: 'group', label: 'Farm System', icon: '🌾',
    items: [
      { page: 'prospects', label: 'Prospects', hint: 'Promotion signals by level' },
      { page: 'development', label: 'Development', hint: 'Rating changes over time' },
    ],
  },
  {
    kind: 'group', label: 'Front Office', icon: '💼',
    items: [
      { page: 'payroll', label: 'Payroll & Budget', hint: 'Committed money by season' },
      { page: 'contracts', label: 'Contracts', hint: 'Re-sign, extend, or walk' },
      { page: 'freeagents', label: 'Free Agents', hint: 'Now and after this season' },
      { page: 'trades', label: 'Trade Center', hint: 'Analyzer and league-wide fits' },
      { page: 'crunch', label: '40-Man Roster', hint: 'Options, Rule 5, DFA clocks' },
    ],
  },
  {
    kind: 'group', label: 'League', icon: '📊',
    items: [
      { page: 'recap', label: 'Daily Recap', hint: "Yesterday's games, written up" },
      { page: 'standings', label: 'Standings', hint: 'Every division, run differential' },
      { page: 'franchise', label: 'Franchise History', hint: 'Every season the club has played' },
      { page: 'orgcompare', label: 'Org Comparison', hint: 'Your system against the other 29' },
      { page: 'trends', label: 'Season Trends', hint: 'Run differential and scoring curves' },
      { page: 'players', label: 'Player Search', hint: 'Search anyone in the league' },
      { page: 'draft', label: 'Draft Board', hint: 'The class, once OOTP publishes it' },
      { page: 'leaders', label: 'Leaderboards', hint: 'League top tens' },
      { page: 'watchlist', label: 'My Watchlist', hint: 'Starred players and notes' },
    ],
  },
];

/**
 * What the import is doing, while it does it.
 *
 * Pressing Refresh used to freeze the window for half a minute and then simply
 * work, with nothing to say whether it was busy or broken — a reader reported
 * exactly that. The bar is only possible because the import now yields between
 * chunks, so the request asking about it is answered rather than queued behind
 * it.
 *
 * The count of files carries the bar rather than the row count: seventy files
 * is a number that means something to somebody watching, and rows arrive in
 * bursts of very different sizes. The rows are shown as a total because they
 * are the reassuring part — it is plainly getting somewhere.
 */
function ImportBar({ progress }: { progress: Status['importProgress'] }) {
  const pct = progress ? Math.round((progress.fileIndex / progress.files) * 100) : null;
  const what = !progress
    ? 'Starting…'
    : progress.phase === 'indexing'
      ? 'Building indexes'
      : `${progress.phase === 'reading' ? 'Reading' : 'Importing'} ${progress.table}`;
  return (
    <div className="import-bar" role="status" aria-live="polite">
      <div className="import-bar-track">
        <div
          className={`import-bar-fill${pct === null ? ' indeterminate' : ''}`}
          style={pct === null ? undefined : { width: `${pct}%` }}
        />
      </div>
      <div className="import-bar-text">
        <strong>{what}</strong>
        {progress && (
          <span className="muted">
            {' '}file {progress.fileIndex} of {progress.files} · {progress.rows.toLocaleString()} rows
          </span>
        )}
      </div>
    </div>
  );
}

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [saves, setSaves] = useState<SaveInfo[]>([]);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [orgId, setOrgId] = useState<number | null>(null);
  const [page, setPage] = useState<Page>('dashboard');
  const [switching, setSwitching] = useState(false);
  /** Live import progress, so a thirty-second wait is not a blank screen. */
  const [importing, setImporting] = useState<Status['importProgress']>(null);
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  // Set during render rather than in an effect: the player card and hover card
  // read it as they draw, and an effect would land a paint too late
  setRatingRounding(appSettings?.roundRatingsToFive === true);
  const [chatOpen, setChatOpen] = useState(false);
  // Once opened, the panel stays mounted for the rest of the session
  const [chatUsed, setChatUsed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    const s = await getStatus();
    // A static export has no server behind it: reads become file lookups and
    // every write-backed feature is hidden rather than left to fail on click
    if (s.exportedSite) setStaticSite(true);
    // Logos are keyed by save; without this a new save shows the old one's art
    setLogoToken(s.logoToken);
    // The scale is the user's OOTP setting and travels with the save
    setRatingScaleMax(s.ratingScaleMax);
    setStatus(s);
    if (s.hasData) {
      const os = await getOrgs();
      setOrgs(os);
      const prefs = await apiGet<{ settings: AppSettings }>('/api/settings')
        .then((r) => r.settings)
        .catch(() => null);
      if (prefs) setAppSettings(prefs);
      const preferred = prefs?.defaultOrgId != null
        ? os.find((o) => o.team_id === prefs.defaultOrgId)
        : undefined;
      setOrgId((prev) => prev ?? (preferred ?? os.find((o) => o.isHuman) ?? os[0])?.team_id ?? null);
    }
    return s;
  }, []);

  useEffect(() => {
    refreshStatus().catch((e) => setError(e.message));
    getSaves().then(setSaves).catch(() => {});
  }, [refreshStatus]);

  // Poll for a fresh export. Cheap, and the alternative is the user staring at
  // stale numbers with no idea the game has moved on.
  useEffect(() => {
    if (!status?.hasData || isStaticSite()) return;
    const id = setInterval(() => {
      getStatus()
        .then((s) => setStatus((prev) => (prev?.exportPending === s.exportPending ? prev : s)))
        .catch(() => {});
    }, 8000);
    return () => clearInterval(id);
  }, [status?.hasData]);

  const org = orgs.find((o) => o.team_id === orgId) ?? null;

  // Resolve the appearance preference; 'system' tracks the OS and updates live
  const preference = appSettings?.theme ?? 'system';
  const [systemMode, setSystemMode] = useState<ThemeMode>(() =>
    window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  );
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: light)');
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => setSystemMode(e.matches ? 'light' : 'dark');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const mode: ThemeMode = preference === 'system' ? systemMode : preference;

  // Re-theme the whole app around the selected organization's colors
  useEffect(() => {
    applyTeamTheme(appSettings?.useTeamColors === false ? null : org?.colors ?? null, mode);
  }, [org, appSettings?.useTeamColors, mode]);

  /*
   * Polls until the import is done, keeping the last progress it saw.
   *
   * Every half second rather than every one and a half, now that there is
   * something to show for it: the import yields between chunks, so these
   * requests are actually answered while it runs. A failed poll is kept rather
   * than treated as an error — the largest files are read in one synchronous
   * parse the server cannot break up, so a request landing in one of those
   * stretches times out, and blanking the bar for it would make the thing
   * flicker exactly when the reader most wants to know it is alive.
   */
  const waitForImport = useCallback(async () => {
    for (let i = 0; i < 360; i++) {
      try {
        const s = await getStatus();
        if (s.importProgress) setImporting(s.importProgress);
        if (!s.importing && (s.hasData || s.lastError)) {
          setImporting(null);
          return s;
        }
      } catch {
        // Mid-parse on a big file; the last progress stands
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    setImporting(null);
    return null;
  }, []);

  const switchSave = async (save: SaveInfo) => {
    setError(null);
    setSwitching(true);
    try {
      await setConfig(save.csvDir, save.name);
      await waitForImport();
      window.location.reload();
    } catch (e) {
      setError((e as Error).message);
      setSwitching(false);
    }
  };

  const hardRefresh = async () => {
    setError(null);
    setSwitching(true);
    try {
      await triggerImport();
      await waitForImport();
      window.location.reload();
    } catch (e) {
      setError((e as Error).message);
      setSwitching(false);
    }
  };

  if (!status) return <div className="shell"><p className="muted">Loading…</p></div>;

  const busy = switching || status.importing;
  // A snapshot has no query endpoint behind Player Search and nowhere to save a
  // watchlist, so those two entries come out of the menu entirely
  const navEntries = isStaticSite()
    ? NAV.map((e) =>
        e.kind === 'group'
          ? { ...e, items: e.items.filter((i) => i.page !== 'players' && i.page !== 'watchlist') }
          : e
      )
    : NAV;

  return (
    <div className="shell">
      <PlayerModal />
      {/* Only while something is actually running; the rest of the app stays
          usable behind it, since the import no longer blocks every request */}
      {(busy || importing) && <ImportBar progress={importing} />}
      <header className="masthead-bar">
        <div className="wordmark">
          <span className="wordmark-ball">⚾</span>
          <div>
            <span className="wordmark-title">Front Office</span>
            <span className="wordmark-sub">OOTP Companion</span>
          </div>
        </div>

        {status.hasData && orgs.length > 0 && (
          <div className="org-plate" title="Your organization view">
            {orgId !== null && <TeamLogo teamId={orgId} className="org-logo" />}
            <select
              className="org-select"
              value={orgId ?? ''}
              onChange={(e) => setOrgId(Number(e.target.value))}
            >
              {orgs.map((o) => (
                <option key={o.team_id} value={o.team_id}>
                  {o.isHuman ? '★ ' : ''}{o.label}
                </option>
              ))}
            </select>
            {org?.isHuman && <span className="org-owner-tag">Your Club</span>}
          </div>
        )}

        <div className="header-right">
          {!isStaticSite() && (
          <select
            value={status.saveName ?? ''}
            disabled={busy}
            onChange={(e) => {
              const save = saves.find((s) => s.name === e.target.value);
              if (save) void switchSave(save);
            }}
            title="Game save"
          >
            {!status.saveName && <option value="">Select a save…</option>}
            {saves.map((s) => (
              <option key={s.lgPath} value={s.name} disabled={s.csvCount === 0}>
                {s.name}
                {s.csvCount === 0 ? ' (no export)' : ''}
              </option>
            ))}
          </select>
          )}
          <span
            className="muted freshness"
            title={`OOTP export: ${fmtTime(status.csvExportedAt)} · imported: ${fmtTime(
              status.lastImport?.finishedAt ?? null
            )}`}
          >
            {busy
              ? 'Importing…'
              : status.csvExportedAt
                ? `data exported ${relativeTime(status.csvExportedAt)}`
                : status.lastImport
                  ? `imported ${relativeTime(status.lastImport.finishedAt)}`
                  : 'no data yet'}
          </span>
          {!isStaticSite() && (
            <button onClick={hardRefresh} disabled={busy || !status.configured}>
              {busy ? 'Working…' : '↻ Refresh'}
            </button>
          )}
          <UpdateBadge onOpenSettings={() => setPage('settings')} />
          {status.hasData && (
            <button
              className="theme-toggle"
              title={`Switch to ${mode === 'dark' ? 'light' : 'dark'} mode`}
              aria-label={`Switch to ${mode === 'dark' ? 'light' : 'dark'} mode`}
              onClick={() => {
                const next: ThemeMode = mode === 'dark' ? 'light' : 'dark';
                setAppSettings((prev) => (prev ? { ...prev, theme: next } : prev));
                void apiPost('/api/settings', { theme: next });
              }}
            >
              {mode === 'dark' ? '☀' : '☾'}
            </button>
          )}
          {status.hasData && !isStaticSite() && (
            <button
              className={`ask-button ${chatOpen ? 'active' : ''}`}
              onClick={() => {
                setChatUsed(true);
                setChatOpen((v) => !v);
              }}
              title="Message your front office"
            >
              ✦ Ask
            </button>
          )}
          {status.hasData && !isStaticSite() && (
            <button
              className={`gear ${page === 'settings' ? 'active' : ''}`}
              onClick={() => setPage('settings')}
              title="Settings"
            >
              ⚙
            </button>
          )}
        </div>
      </header>

      {error && <div className="banner error">{error}</div>}
      {status.lastError && <div className="banner error">Import failed: {status.lastError}</div>}
      {status.exportPending && !busy && (
        <div className="banner refresh-prompt">
          <span>
            <strong>A newer export is ready.</strong> OOTP wrote fresh data{' '}
            {relativeTime(status.exportPending)} — refresh to load it.
          </span>
          <button className="cta" onClick={hardRefresh}>
            Refresh now
          </button>
        </div>
      )}

      {!status.hasData ? (
        <SavePicker saves={saves} onPick={switchSave} busy={busy} />
      ) : (
        <>
          <Nav entries={navEntries} current={page} onNavigate={setPage} />
          <main>
            {orgId !== null && org && (
              <>
                {page === 'dashboard' && <Dashboard orgId={orgId} onNavigate={(p) => setPage(p as Page)} />}
                {page === 'storylines' && <Storylines orgId={orgId} orgLabel={org.label} />}
                {page === 'recap' && <LeagueRecap orgId={orgId} />}
                {page === 'rosters' && <RosterPage orgId={orgId} />}
                {page === 'depth' && <DepthChart orgId={orgId} />}
                {page === 'prospects' && <Prospects orgId={orgId} />}
                {page === 'development' && <Development orgId={orgId} />}
                {page === 'draft' && <Draft orgId={orgId} />}
                {page === 'franchise' && <Franchise orgId={orgId} />}
                {page === 'orgcompare' && <OrgComparison orgId={orgId} />}
                {page === 'contracts' && <Contracts orgId={orgId} />}
                {page === 'payroll' && <Payroll orgId={orgId} />}
                {page === 'crunch' && <RosterCrunch orgId={orgId} />}
                {page === 'injuries' && <Injuries orgId={orgId} />}
                {page === 'trades' && <TradeCenter orgId={orgId} orgLabel={org.label} />}
                {page === 'freeagents' && <FreeAgents orgId={orgId} />}
                {page === 'lineup' && <Lineup teamId={orgId} />}
                {page === 'pitching' && <Pitching teamId={orgId} />}
                {page === 'schedule' && <Schedule teamId={orgId} />}
                {page === 'standings' && <Standings orgId={orgId} />}
                {page === 'trends' && <Trends teamId={orgId} />}
                {page === 'players' && <Players orgs={orgs} orgId={orgId} />}
                {page === 'leaders' && <Leaderboards orgId={orgId} />}
                {page === 'staff' && <Staff orgId={orgId} />}
                {page === 'watchlist' && <Watchlist />}
                {page === 'settings' && (
                  <Settings
                    status={status}
                    orgs={orgs}
                    orgId={orgId}
                    onSettingsChanged={setAppSettings}
                    onSaveChanged={switchSave}
                  />
                )}
              </>
            )}
          </main>

          {/* The panel stays mounted once opened. Unmounting it would discard the
              conversation and abort any answer still streaming, so closing it
              only hides it. */}
          {orgId !== null && org && (chatOpen || chatUsed) && (
            <>
              {chatOpen && <div className="chat-scrim" onClick={() => setChatOpen(false)} />}
              <aside
                className={`chat-drawer ${chatOpen ? '' : 'chat-hidden'}`}
                aria-label="Message your front office"
                aria-hidden={!chatOpen}
                {...(chatOpen ? {} : { inert: '' })}
              >
                <header className="chat-head">
                  <strong>Front Office</strong>
                  <button className="chat-close" onClick={() => setChatOpen(false)} title="Close">
                    ✕
                  </button>
                </header>
                <Chat orgId={orgId} orgLabel={org.label} />
              </aside>
            </>
          )}
        </>
      )}
    </div>
  );
}

function SavePicker({ saves, onPick, busy }: { saves: SaveInfo[]; onPick: (s: SaveInfo) => void; busy: boolean }) {
  return (
    <main>
      <h2>Pick a save</h2>
      {saves.length === 0 && <p className="muted">No OOTP 27 saves detected on this machine.</p>}
      <div className="save-list">
        {saves.map((s) => (
          <button key={s.lgPath} className="save-card" disabled={s.csvCount === 0 || busy} onClick={() => onPick(s)}>
            <strong>{s.name}</strong>
            {s.csvCount > 0 ? (
              <span className="ok">
                {s.csvCount} CSV files · exported{' '}
                {s.csvLastModified ? new Date(s.csvLastModified).toLocaleString() : '?'}
              </span>
            ) : (
              <span className="warn">No CSV export found</span>
            )}
          </button>
        ))}
      </div>
      <div className="hint">
        <h3>No export yet?</h3>
        <p>
          In OOTP: open your save, then <strong>Database Tools → Global Actions → Export data to CSV files</strong>.
          Come back here and the save card will light up. After that, re-export any time you sim — this app picks up
          changes automatically.
        </p>
      </div>

      <FolderPicker onResolved={onPick} />
    </main>
  );
}

const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never');

function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleString();
}
