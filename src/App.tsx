import { useCallback, useEffect, useState } from 'react';
import {
  getOrgs, getSaves, getStatus, setConfig, triggerImport,
  type Org, type SaveInfo, type Status,
} from './api';
import { RosterPage } from './pages/Roster';
import { DepthChart } from './pages/DepthChart';
import { Prospects } from './pages/Prospects';
import { Contracts } from './pages/Contracts';
import { FreeAgents } from './pages/FreeAgents';
import { Lineup } from './pages/Lineup';
import { Storylines } from './pages/Storylines';
import { Dashboard } from './pages/Dashboard';
import { Development } from './pages/Development';
import { TradeCenter } from './pages/TradeCenter';
import { RosterCrunch } from './pages/RosterCrunch';
import { Injuries } from './pages/Injuries';
import { Leaderboards } from './pages/Leaderboards';
import { Staff } from './pages/Staff';
import { Watchlist } from './pages/Watchlist';
import { Draft } from './pages/Draft';
import { PlayerModal } from './playerModal';

type Page =
  | 'dashboard' | 'storylines' | 'rosters' | 'depth' | 'prospects' | 'development' | 'draft'
  | 'contracts' | 'crunch' | 'injuries' | 'freeagents' | 'trades' | 'lineup' | 'leaders'
  | 'staff' | 'watchlist';

const PAGES: Array<[Page, string]> = [
  ['dashboard', 'Dashboard'],
  ['storylines', 'Storylines'],
  ['lineup', 'Lineup'],
  ['rosters', 'Rosters'],
  ['depth', 'Depth Chart'],
  ['prospects', 'Prospects'],
  ['development', 'Development'],
  ['contracts', 'Contracts'],
  ['crunch', '40-Man'],
  ['injuries', 'Injuries'],
  ['trades', 'Trade Center'],
  ['freeagents', 'Free Agents'],
  ['draft', 'Draft'],
  ['leaders', 'Leaders'],
  ['staff', 'Staff'],
  ['watchlist', 'Watchlist'],
];

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [saves, setSaves] = useState<SaveInfo[]>([]);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [orgId, setOrgId] = useState<number | null>(null);
  const [page, setPage] = useState<Page>('dashboard');
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    const s = await getStatus();
    setStatus(s);
    if (s.hasData) {
      const os = await getOrgs();
      setOrgs(os);
      setOrgId((prev) => prev ?? (os.find((o) => o.isHuman) ?? os[0])?.team_id ?? null);
    }
    return s;
  }, []);

  useEffect(() => {
    refreshStatus().catch((e) => setError(e.message));
    getSaves().then(setSaves).catch(() => {});
  }, [refreshStatus]);

  const org = orgs.find((o) => o.team_id === orgId) ?? null;

  // Theme the app with the selected organization's colors
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--team', org?.colors.bg || '#1a4a2e');
    root.style.setProperty('--team-fg', org?.colors.fg || '#f5ead6');
  }, [org]);

  const waitForImport = useCallback(async () => {
    for (let i = 0; i < 120; i++) {
      try {
        const s = await getStatus();
        if (!s.importing && (s.hasData || s.lastError)) return s;
      } catch {
        // server busy with a synchronous import — keep polling
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
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

  return (
    <div className="shell">
      <PlayerModal />
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
          <button onClick={hardRefresh} disabled={busy || !status.configured}>
            {busy ? 'Working…' : '↻ Refresh'}
          </button>
        </div>
      </header>

      {error && <div className="banner error">{error}</div>}
      {status.lastError && <div className="banner error">Import failed: {status.lastError}</div>}

      {!status.hasData ? (
        <SavePicker saves={saves} onPick={switchSave} busy={busy} />
      ) : (
        <>
          <nav className="nav">
            {PAGES.map(([key, label]) => (
              <button key={key} className={page === key ? 'active' : ''} onClick={() => setPage(key)}>
                {label}
              </button>
            ))}
          </nav>
          <main>
            {orgId !== null && org && (
              <>
                {page === 'dashboard' && <Dashboard orgId={orgId} onNavigate={(p) => setPage(p as Page)} />}
                {page === 'storylines' && <Storylines orgId={orgId} orgLabel={org.label} />}
                {page === 'rosters' && <RosterPage orgId={orgId} />}
                {page === 'depth' && <DepthChart orgId={orgId} />}
                {page === 'prospects' && <Prospects orgId={orgId} />}
                {page === 'development' && <Development orgId={orgId} />}
                {page === 'draft' && <Draft />}
                {page === 'contracts' && <Contracts orgId={orgId} />}
                {page === 'crunch' && <RosterCrunch orgId={orgId} />}
                {page === 'injuries' && <Injuries orgId={orgId} />}
                {page === 'trades' && <TradeCenter orgId={orgId} orgLabel={org.label} />}
                {page === 'freeagents' && <FreeAgents orgId={orgId} />}
                {page === 'lineup' && <Lineup teamId={orgId} />}
                {page === 'leaders' && <Leaderboards orgId={orgId} />}
                {page === 'staff' && <Staff orgId={orgId} />}
                {page === 'watchlist' && <Watchlist />}
              </>
            )}
          </main>
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
