export interface SaveInfo {
  name: string;
  lgPath: string;
  csvDir: string;
  csvCount: number;
  csvLastModified: string | null;
}

export interface Status {
  csvExportedAt: string | null;
  /** True when running as a static export rather than against a live server. */
  exportedSite?: boolean;
  exportedAt?: string;
  configured: boolean;
  saveName: string | null;
  csvDir: string | null;
  csvDirExists: boolean;
  importing: boolean;
  /**
   * Where a running import has got to. Null when nothing is importing — and
   * briefly null while a very large file is being read, since that stretch is
   * one synchronous parse the server cannot interrupt.
   */
  importProgress?: {
    table: string;
    fileIndex: number;
    files: number;
    rows: number;
    phase: 'reading' | 'writing' | 'indexing';
  } | null;
  lastImport: { tables: number; rows: number; finishedAt: string } | null;
  lastError: string | null;
  hasData: boolean;
  /** ISO time a fresh export was spotted on disk but not yet imported. */
  exportPending: string | null;
  /**
   * Changes with the save. Rides on every logo URL so switching saves does not
   * keep showing the previous one's art for team ids the new save reuses.
   */
  logoToken?: string;
  /** Top of the rating scale this save uses: 80, 20, 10, 8 or 5. */
  ratingScaleMax?: number;
}

export interface Team {
  team_id: number;
  name: string;
  nickname: string | null;
  abbr: string | null;
  level: number | null;
  parent_team_id: number | null;
  league_id: number | null;
}

export interface RosterPlayer {
  player_id: number;
  first_name: string | null;
  last_name: string | null;
  age: number | null;
  position: number | null;
  positionName: string;
  batsName: string;
  throwsName: string;
  uniform_number: number | null;
  ratings: Record<string, number>;
  /** Season fielding, summed across positions. Null when he has not fielded. */
  fielding: Record<string, number | null> | null;
  oaRating: number | null;
  potRating: number | null;
  batting: Record<string, number | null> | null;
  pitching: Record<string, number | null> | null;
  /** Batted-ball quality. Null for pitchers and anyone yet to put one in play. */
  contact: Record<string, number | null> | null;
  /** DFA, waivers, injured list or plain active — and whether he can be used. */
  standing: { label: string; daysLeft: number | null; available: boolean } | null;
}

export interface RosterResponse {
  players: RosterPlayer[];
  ratingMax: number;
  ratingKeys: string[];
}

export async function apiGet<T>(url: string): Promise<T> {
  return json<T>(url);
}
export async function apiPost<T>(url: string, body?: unknown): Promise<T> {
  return json<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
export async function apiPut<T>(url: string, body?: unknown): Promise<T> {
  return json<T>(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
export async function apiDelete<T>(url: string): Promise<T> {
  return json<T>(url, { method: 'DELETE' });
}

/**
 * A static export is a folder of files, so an API path has to become a filename.
 * Must stay identical to exportPath in server/exporter.ts — the two agree on
 * where every file lives, and a query string is folded into the name because a
 * static host ignores it.
 */
const exportPath = (url: string): string =>
  '/api/' + url.replace(/^\/?api\//, '').replace(/[?&=]/g, '_');

/**
 * Set once at boot from /api/status. A static export has no server behind it,
 * so reads are redirected to files and writes are hidden from the UI entirely.
 */
let staticSite = false;
export const isStaticSite = (): boolean => staticSite;
export const setStaticSite = (value: boolean): void => {
  staticSite = value;
};

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(staticSite && url.startsWith('/api/') ? exportPath(url) : url, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export interface SearchLocation {
  label: string;
  path: string;
  exists: boolean;
}
export interface ResolveResult {
  ok: boolean;
  csvDir?: string;
  saveName?: string;
  csvCount?: number;
  saves?: SaveInfo[];
  error?: string;
}

export const getSearchLocations = () =>
  json<{ platform: string; locations: SearchLocation[] }>('/api/search-locations');
export const resolveFolder = (path: string) => apiPost<ResolveResult>('/api/resolve-folder', { path });

/** Mirrors UpdateState in electron/updater.ts. */
export type UpdateState =
  | { status: 'unsupported'; version: string; reason: string }
  | { status: 'idle'; version: string }
  | { status: 'checking'; version: string }
  | { status: 'current'; version: string; checkedAt: string }
  | { status: 'available'; version: string; newVersion: string; notes: string | null; releaseUrl: string }
  | { status: 'downloading'; version: string; newVersion: string; percent: number }
  | { status: 'ready'; version: string; newVersion: string }
  | { status: 'error'; version: string; message: string };

export interface UpdateBridge {
  state: () => Promise<UpdateState>;
  check: () => Promise<UpdateState>;
  download: () => Promise<UpdateState>;
  install: () => Promise<void>;
  openReleases: () => Promise<void>;
  onState: (handler: (state: UpdateState) => void) => () => void;
}

export interface DesktopBridge {
  isDesktop: true;
  selectFolder: (defaultPath?: string) => Promise<string | null>;
  openPath: (target: string) => Promise<void>;
  /** Absent in builds packaged before auto-update shipped. */
  update?: UpdateBridge;
}
/** Present only inside the desktop app; the browser build falls back to typing a path. */
export const desktopBridge = (): DesktopBridge | null =>
  (window as unknown as { desktop?: DesktopBridge }).desktop ?? null;

export const getSaves = () => json<SaveInfo[]>('/api/saves');
export const getStatus = () => json<Status>('/api/status');
export const getTeams = () => json<Team[]>('/api/teams');
export const getRoster = (teamId: number) => json<RosterResponse>(`/api/roster/${teamId}`);
export interface Org {
  team_id: number;
  label: string;
  /**
   * Set only where the picker holds clubs from more than one level, which
   * happens in a save whose lower leagues are not affiliated to the top one.
   * Null on an ordinary save, where saying "MLB" against all thirty says
   * nothing.
   */
  levelName: string | null;
  isHuman: boolean;
  colors: { bg: string | null; fg: string | null; secondary: string | null; cap: string | null };
}

export interface Storyline {
  category: string;
  headline: string;
  body: string;
}

export interface StorylineCache {
  generatedAt?: string;
  gameDate?: string | null;
  orgLabel?: string;
  /** Null before any set has been written for this club. */
  storylines: Storyline[] | null;
  /** Set when the chosen model could not be used and another answered. */
  notice?: { message: string; from: string; to: string; provider: string } | null;
  /** How a background generation is getting on, when one is or was running. */
  job?: { state: 'idle' | 'running' | 'done' | 'error'; startedAt: string | null; finishedAt: string | null; error: string | null };
}

export interface PlayerDossier {
  player_id: number;
  name: string;
  nickname: string | null;
  age: number;
  dob: string;
  heightWeight: string | null;
  bats: string;
  throws: string;
  positionName: string;
  roleName: string | null;
  uniform: number | null;
  team: string | null;
  serviceYears: number | null;
  overallPct: number | null;
  talentPct: number | null;
  /** OOTP's own Overall / Potential on the 20-80 scale, for cross-reference. */
  oaRating: number | null;
  potRating: number | null;
  isPitcher: boolean;
  battingRatings: Record<string, [number, number]> | null;
  pitchingRatings: Record<string, [number, number]> | null;
  velocity: string | null;
  pitches: Array<{ name: string; rating: number; talent: number }>;
  fieldingRatings: Record<string, number> | null;
  /** His grade at each position he can play, on the 20-80 scale. */
  positionRatings?: Array<{
    position: number;
    code: string;
    current: number;
    potential: number;
    experience: number;
    isPrimary: boolean;
  }>;
  contract: {
    salaryNow: number;
    totalYears: number;
    yearsAfterThis: number;
    endYear: number;
    noTrade: boolean;
    salarySchedule: Array<{ year: number; salary: number }>;
  } | null;
  battingYears: Array<Record<string, number | string | null>>;
  pitchingYears: Array<Record<string, number | string | null>>;
  gameLogs: Array<Record<string, number | string | null>>;
  pitchingGameLogs: Array<Record<string, number | string | null>>;
  /** Batted-ball quality, and the league's for scale. Null for pitchers. */
  contact: Record<string, number | null> | null;
  contactLeague: { avgExitVelo: number; hardHitPct: number; barrelPct: number; sprintSpeed: number } | null;
  /** Base-out and count splits. Small samples — each carries its own PA count. */
  splits: Array<{ label: string; pa: number; ba: number | null; ops: number | null }>;
  careerEarnings: number | null;
  injuryHistory: Array<Record<string, number | string | null>>;
  currentInjury: { status: string; daysLeft: number | null } | null;
  awards?: Array<{ year: number; award: string; positionName: string | null; rank: number }>;
  /** Composed from his own ratings — the export carries no scouting prose. */
  scouting?: {
    tools: Array<{ label: string; rank: number; grade: number; good: boolean }>;
    makeup: string[];
    peers: string | null;
    empty: boolean;
  };
  transactions?: Array<{
    date: string | null;
    kind: 'trade' | 'signing' | 'waiver';
    summary: Array<{ text: string; kind?: 'player' | 'team'; id?: number }>;
    plain: string;
  }>;
  fieldingYears?: Array<{
    year: number; level_id: number; levelName: string; positionName: string;
    g: number; gs: number; innings: number; po: number; a: number; e: number; dp: number;
    fpct: number | null; rf9: number | null;
  }>;
  leagueLeader?: Array<{ year: number; category: string; place: number; amount: number }>;
}

export const getPlayer = (id: number) => json<PlayerDossier>(`/api/player/${id}`);
export interface IssueCache {
  generatedAt?: string;
  gameDate?: string | null;
  leagueName?: string;
  /** Null before an edition has been set for this club. */
  issue: {
    masthead: string;
    lead: { headline: string; standfirst?: string; body: string };
    sections: Array<{ title: string; stories: Array<{ headline: string; body: string }> }>;
    briefs: string[];
  } | null;
  notice?: { message: string; from: string; to: string; provider: string } | null;
  job?: { state: 'idle' | 'running' | 'done' | 'error'; startedAt: string | null; finishedAt: string | null; error: string | null };
}

export interface RecapCache {
  generatedAt?: string;
  /** The day the recap covers — the last one the league played, not the save's today. */
  gameDate?: string | null;
  leagueName?: string;
  /** Null before one has been written for this club. */
  recap: {
    summary: string;
    divisions: Array<{ division: string; body: string }>;
    notes: string[];
  } | null;
  /** The last day the league played, so a recap the save has moved past can say so. */
  latestPlayed?: string | null;
  stale?: boolean;
  notice?: { message: string; from: string; to: string; provider: string } | null;
  job?: { state: 'idle' | 'running' | 'done' | 'error'; startedAt: string | null; finishedAt: string | null; error: string | null };
}

export const getStorylines = (orgId: number) => json<StorylineCache | null>(`/api/storylines/${orgId}`);
export const generateStorylines = (orgId: number) =>
  json<StorylineCache>(`/api/storylines/${orgId}`, { method: 'POST' });

export interface DepthTeam {
  team_id: number;
  label: string;
  level: number;
  levelName: string;
}

export interface DepthPlayer {
  player_id: number;
  team_id: number;
  name: string;
  age: number;
  position: number;
  role: number;
  cur: number | null;
  pot: number | null;
}

export interface Prospect {
  player_id: number;
  name: string;
  age: number;
  team: string;
  level: number;
  levelName: string;
  cur: number | null;
  pot: number | null;
  ageDiff: number | null;
  score: number;
  reasons: string[];
  positionName: string;
  signal: 'promote' | 'blocked' | 'watch' | 'demote' | null;
  /** Who he would displace on the big club, and whether that is an upgrade. */
  move: {
    replaces: { player_id: number; name: string; cur: number | null } | null;
    ahead: number;
    bestAhead: { player_id: number; name: string; cur: number | null } | null;
    blocked: boolean;
    note: string;
  } | null;
  war: number;
  // batters
  pa?: number;
  opsVal?: number;
  hr?: number;
  sb?: number;
  // pitchers
  role?: number;
  ip?: number;
  era?: number;
  kpct?: number;
}

export interface ProspectsResponse {
  batters: Prospect[];
  pitchers: Prospect[];
}

export interface TeamFinances {
  budget: number;
  payroll: number;
  payrollNextSeason: number;
  cash: number;
  market: number;
  fanInterest: number;
}

export interface ContractRow {
  player_id: number;
  name: string;
  age: number;
  positionName: string;
  salaryNow: number;
  totalYears: number;
  yearsAfterThis: number;
  endYear: number;
  serviceYears: number | null;
  overallPct: number | null;
  talentPct: number | null;
  flags: string[];
  /** Present only when a signed extension starts after the current deal. */
  extension: { years: number; startYear: number; endYear: number; firstSalary: number } | null;
  recommendation: { action: string; reasons: string[] } | null;
}

export interface ContractsResponse {
  seasonYear: number;
  gameDate: string | null;
  finances: TeamFinances | null;
  players: ContractRow[];
}

export interface FreeAgentRow {
  player_id: number;
  name: string;
  age: number;
  positionName: string;
  team: string | null;
  overallPct: number | null;
  talentPct: number | null;
  lastSalary: number | null;
}

export interface FreeAgentsResponse {
  finances: TeamFinances | null;
  holes: Array<{ position: number; positionName: string; bestValue: number | null }>;
  currentFAs: FreeAgentRow[];
  upcomingFAs: FreeAgentRow[];
}

export interface LineupSlot {
  slot: number;
  player_id: number;
  name: string;
  positionName: string;
  /** OOTP's 20-80 fielding rating at the position he is assigned. */
  defRating?: number | null;
  bats: string;
  /** Playable but carrying something, so the card flags him rather than deciding. */
  dayToDay?: boolean;
  off: number;
  why: string;
  pa: number | null;
  ops: number | null;
  opsPlus: number | null;
  wrcPlus: number | null;
  war: number | null;
}

export interface LineupResponse {
  vs: 'r' | 'l';
  style: 'saber' | 'trad';
  /** Whether this card was built with a DH — the league rule unless overridden. */
  usesDH?: boolean;
  /** What the league itself says, regardless of the override. */
  leagueUsesDH?: boolean;
  dhOverridden?: boolean;
  /**
   * What the pairwise search did to the card the slot rule wrote. Null when it
   * was skipped — too little season played — or moved nobody worth moving.
   */
  runSearch?: {
    seededRuns: number; optimisedRuns: number; gain: number;
    evaluations: number; moved: boolean;
  } | null;
  lineup: LineupSlot[];
  bench: Array<{ player_id: number; name: string; positionName: string; off: number }>;
  /** On the roster but out tonight — named so a missing star reads as injured
   *  rather than as a broken card. */
  unavailable: Array<{
    player_id: number;
    name: string;
    positionName: string;
    status: string;
    daysLeft: number | null;
  }>;
}

export const getContracts = (orgId: number) => json<ContractsResponse>(`/api/contracts/${orgId}`);
export const getFreeAgents = (orgId: number) => json<FreeAgentsResponse>(`/api/free-agents/${orgId}`);
export const getLineup = (
  teamId: number,
  vs: 'r' | 'l',
  style: 'saber' | 'trad',
  dh: 'auto' | 'on' | 'off' = 'auto',
  sort: 'talent' | 'production' = 'talent'
) => json<LineupResponse>(`/api/lineup/${teamId}?vs=${vs}&style=${style}&dh=${dh}&sort=${sort}`);
export const getOrgs = () => json<Org[]>('/api/orgs');
export const getDepthChart = (orgId: number) =>
  json<{ teams: DepthTeam[]; players: DepthPlayer[] }>(`/api/depth-chart/${orgId}`);
export const getProspects = (orgId: number) => json<ProspectsResponse>(`/api/prospects/${orgId}`);
export const setConfig = (csvDir: string, saveName: string) =>
  json<{ ok: boolean }>('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ csvDir, saveName }),
  });
export const triggerImport = () => json<{ ok: boolean }>('/api/import', { method: 'POST' });

export interface SiteExportResult {
  outDir: string;
  files: number;
  bytes: number;
  players: number;
  warnings: string[];
}
export const exportStaticSite = (orgId: number) =>
  apiPost<SiteExportResult>(`/api/export-site/${orgId}`);

export interface ExportProgress {
  running: boolean;
  phase: string;
  done: number;
  total: number;
}
export const getExportProgress = () => apiGet<ExportProgress>('/api/export-site/progress');
