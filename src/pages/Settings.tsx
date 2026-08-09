import { useEffect, useState } from 'react';
import { apiDelete, apiGet, apiPost, desktopBridge, triggerImport, type Org, type SaveInfo, type Status } from '../api';
import { FolderPicker } from '../FolderPicker';
import { UpdatePanel } from '../Updater';

interface ApiKeyStatus {
  configured: boolean;
  source: 'env' | 'stored' | null;
  hint: string | null;
  encrypted: boolean;
  storageLabel: string;
}
export interface AppSettings {
  autoImport: boolean;
  useTeamColors: boolean;
  defaultOrgId: number | null;
  theme: 'system' | 'dark' | 'light';
  model: string;
}
interface SettingsResponse {
  settings: AppSettings;
  apiKey: ApiKeyStatus;
  dataDir: string;
}
interface ModelChoice {
  id: string;
  name: string;
  contextTokens: number | null;
  adaptiveThinking: boolean | null;
}
interface ModelsResponse {
  models: ModelChoice[];
  /** False when the API could not be reached and this is the built-in short list. */
  live: boolean;
}

export function Settings({
  status, orgs, onSettingsChanged, onSaveChanged,
}: {
  status: Status;
  orgs: Org[];
  onSettingsChanged: (s: AppSettings) => void;
  onSaveChanged: (save: SaveInfo) => void;
}) {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyMessage, setKeyMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [changingSave, setChangingSave] = useState(false);
  const [reimporting, setReimporting] = useState(false);
  const desktop = desktopBridge();

  const loadModels = () => {
    apiGet<ModelsResponse>('/api/models').then(setModels).catch(() => {});
  };

  useEffect(() => {
    apiGet<SettingsResponse>('/api/settings').then(setData).catch(() => {});
    loadModels();
  }, []);

  const update = async (patch: Partial<AppSettings>) => {
    if (!data) return;
    const next = { ...data.settings, ...patch };
    setData({ ...data, settings: next });
    onSettingsChanged(next);
    await apiPost('/api/settings', patch);
  };

  const saveKey = async () => {
    setKeyBusy(true);
    setKeyMessage(null);
    try {
      const r = await apiPost<{ ok: boolean; apiKey: ApiKeyStatus }>('/api/settings/api-key', { key: keyInput });
      setKeyInput('');
      setKeyMessage({ ok: true, text: 'Key verified and saved. The AI features are ready to use.' });
      if (data) setData({ ...data, apiKey: r.apiKey });
      // The real model list needs a working key, so fetch it again now there is one
      loadModels();
    } catch (e) {
      setKeyMessage({ ok: false, text: (e as Error).message });
    } finally {
      setKeyBusy(false);
    }
  };

  const removeKey = async () => {
    setKeyBusy(true);
    try {
      const r = await apiDelete<{ apiKey: ApiKeyStatus }>('/api/settings/api-key');
      if (data) setData({ ...data, apiKey: r.apiKey });
      setKeyMessage({ ok: true, text: 'Key removed.' });
      loadModels();
    } finally {
      setKeyBusy(false);
    }
  };

  const reimport = async () => {
    setReimporting(true);
    try {
      await triggerImport();
      window.location.reload();
    } finally {
      setReimporting(false);
    }
  };

  if (!data) return <p className="muted">Loading settings…</p>;
  const { settings, apiKey } = data;

  return (
    <div className="settings">
      <section className="settings-block">
        <h2>AI Features</h2>
        <p className="muted hint-line">
          Storylines, the GM Briefing, and AI trade verdicts call the Anthropic API with your own key. Everything
          else in the app works without one. Generations cost a few cents each.
        </p>

        {apiKey.configured ? (
          <div className="key-state">
            <span className="badge promote">Key saved</span>
            <span className="muted">
              ending in <code>…{apiKey.hint}</code>
              {apiKey.source === 'env'
                ? ' — coming from an ANTHROPIC_API_KEY environment variable, which takes priority over anything set here.'
                : apiKey.encrypted
                  ? ` — encrypted with ${apiKey.storageLabel}.`
                  : ` — stored in ${apiKey.storageLabel}.`}
            </span>
            {apiKey.source !== 'env' && (
              <button onClick={removeKey} disabled={keyBusy}>Remove key</button>
            )}
          </div>
        ) : (
          <p className="muted">No key set — the AI features will explain this instead of failing.</p>
        )}

        {apiKey.source !== 'env' && (
          <div className="folder-row">
            <input
              className="trade-search folder-input"
              type="password"
              placeholder="sk-ant-…"
              value={keyInput}
              autoComplete="off"
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && keyInput.trim() && void saveKey()}
            />
            <button className="btn-feature" onClick={saveKey} disabled={keyBusy || !keyInput.trim()}>
              {keyBusy ? 'Verifying…' : apiKey.configured ? 'Replace key' : 'Verify and save'}
            </button>
          </div>
        )}
        {keyMessage && (
          <div className={`banner ${keyMessage.ok ? 'success' : 'error'}`}>{keyMessage.text}</div>
        )}
        <p className="muted hint-line">
          Get a key at{' '}
          <a href="https://console.claude.com" target="_blank" rel="noreferrer">console.claude.com</a>. It is
          checked against the API before saving, so a typo is caught here rather than later.
        </p>

        <div className="settings-row">
          <div>
            <strong>Model</strong>
            <div className="muted">
              Used by Peter, Storylines, the GM Briefing, and trade verdicts. Larger models reason
              better and cost more per generation; smaller ones are quicker and cheaper.
            </div>
            {models && !models.live && (
              <div className="muted">
                Showing a short built-in list — add a key to read the current one from the API.
              </div>
            )}
          </div>
          <select
            value={settings.model}
            onChange={(e) => void update({ model: e.target.value })}
          >
            {/* A model saved earlier may no longer be listed; keep it selectable
                rather than silently snapping the user onto a different one */}
            {models && !models.models.some((m) => m.id === settings.model) && (
              <option value={settings.model}>{settings.model}</option>
            )}
            {(models?.models ?? []).map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </div>
      </section>

      <section className="settings-block">
        <h2>Data</h2>
        <div className="settings-row">
          <div>
            <strong>Current save</strong>
            <div className="muted">{status.saveName ?? 'None selected'}</div>
            <div className="muted small-path">{status.csvDir ?? ''}</div>
          </div>
          <button onClick={() => setChangingSave((v) => !v)}>
            {changingSave ? 'Cancel' : 'Change save…'}
          </button>
        </div>

        {changingSave && (
          <FolderPicker
            onResolved={(save) => {
              setChangingSave(false);
              onSaveChanged(save);
            }}
          />
        )}

        <div className="settings-row">
          <div>
            <strong>Watch for new exports</strong>
            <div className="muted">
              Notice when OOTP writes a fresh export and offer to load it. Importing a full league
              takes a while, so the app asks rather than interrupting you.
            </div>
          </div>
          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.autoImport}
              onChange={(e) => void update({ autoImport: e.target.checked })}
            />
            <span>{settings.autoImport ? 'On' : 'Off'}</span>
          </label>
        </div>

        <div className="settings-row">
          <div>
            <strong>Data folder</strong>
            <div className="muted small-path">{data.dataDir}</div>
            <div className="muted">Holds the imported database, rating history, watchlist, and caches.</div>
          </div>
          <div className="settings-actions">
            {desktop && (
              <button onClick={() => void desktop.openPath(data.dataDir)}>Open folder</button>
            )}
            <button onClick={reimport} disabled={reimporting}>
              {reimporting ? 'Importing…' : 'Re-import now'}
            </button>
          </div>
        </div>
      </section>

      <section className="settings-block">
        <h2>Display</h2>
        <div className="settings-row">
          <div>
            <strong>Use team colors</strong>
            <div className="muted">
              Theme the interface with the selected club's colors. Turn off for a neutral look.
            </div>
          </div>
          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.useTeamColors}
              onChange={(e) => void update({ useTeamColors: e.target.checked })}
            />
            <span>{settings.useTeamColors ? 'On' : 'Off'}</span>
          </label>
        </div>

        <div className="settings-row">
          <div>
            <strong>Appearance</strong>
            <div className="muted">
              System follows your computer's setting and changes with it.
            </div>
          </div>
          <div className="tabs">
            {(['system', 'light', 'dark'] as const).map((m) => (
              <button
                key={m}
                className={settings.theme === m ? 'active' : ''}
                onClick={() => void update({ theme: m })}
              >
                {m[0].toUpperCase() + m.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-row">
          <div>
            <strong>Organization to open with</strong>
            <div className="muted">Defaults to the club you manage in the save.</div>
          </div>
          <select
            value={settings.defaultOrgId ?? ''}
            onChange={(e) => void update({ defaultOrgId: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">Your club (automatic)</option>
            {orgs.map((o) => (
              <option key={o.team_id} value={o.team_id}>{o.label}</option>
            ))}
          </select>
        </div>
      </section>

      <UpdatePanel />
    </div>
  );
}
