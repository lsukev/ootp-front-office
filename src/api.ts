export interface SaveInfo {
  name: string;
  lgPath: string;
  csvDir: string;
  csvCount: number;
  csvLastModified: string | null;
}

export interface Status {
  csvExportedAt: string | null;
  configured: boolean;
  saveName: string | null;
  csvDir: string | null;
  csvDirExists: boolean;
  importing: boolean;
  lastImport: { tables: number; rows: number; finishedAt: string } | null;
  lastError: string | null;
  hasData: boolean;
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
  batting: Record<string, number | null> | null;
  pitching: Record<string, number | null> | null;
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
export async function apiDelete<T>(url: string): Promise<T> {
  return json<T>(url, { method: 'DELETE' });
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
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

/** Present only inside the desktop app; the browser build falls back to typing a path. */
export const desktopBridge = (): { isDesktop: true; selectFolder: (d?: string) => Promise<string | null> } | null =>
  (window as unknown as { desktop?: { isDesktop: true; selectFolder: (d?: string) => Promise<string | null> } })
    .desktop ?? null;

export const getSaves = () => json<SaveInfo[]>('/api/saves');
export const getStatus = () => json<Status>('/api/status');
export const getTeams = () => json<Team[]>('/api/teams');
export const getRoster = (teamId: number) => json<RosterResponse>(`/api/roster/${teamId}`);
export interface Org {
  team_id: number;
  label: string;
  isHuman: boolean;
  colors: { bg: string | null; fg: string | null; secondary: string | null; cap: string | null };
}

export interface Storyline {
  category: string;
  headline: string;
  body: string;
}

export interface StorylineCache {
  generatedAt: string;
  gameDate: string | null;
  orgLabel: string;
  storylines: Storyline[];
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
  isPitcher: boolean;
  battingRatings: Record<string, [number, number]> | null;
  pitchingRatings: Record<string, [number, number]> | null;
  velocity: string | null;
  pitches: Array<{ name: string; rating: number; talent: number }>;
  fieldingRatings: Record<string, number> | null;
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
  injuryHistory: Array<Record<string, number | string | null>>;
  currentInjury: { status: string; daysLeft: number | null } | null;
}

export const getPlayer = (id: number) => json<PlayerDossier>(`/api/player/${id}`);
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
  signal: 'promote' | 'watch' | null;
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
  bats: string;
  off: number;
  why: string;
}

export interface LineupResponse {
  vs: 'r' | 'l';
  style: 'saber' | 'trad';
  lineup: LineupSlot[];
  bench: Array<{ player_id: number; name: string; positionName: string; off: number }>;
}

export const getContracts = (orgId: number) => json<ContractsResponse>(`/api/contracts/${orgId}`);
export const getFreeAgents = (orgId: number) => json<FreeAgentsResponse>(`/api/free-agents/${orgId}`);
export const getLineup = (teamId: number, vs: 'r' | 'l', style: 'saber' | 'trad') =>
  json<LineupResponse>(`/api/lineup/${teamId}?vs=${vs}&style=${style}`);
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
