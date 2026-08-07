import { useEffect, useState } from 'react';
import { desktopBridge, type UpdateState } from './api';

/**
 * Subscribes to the desktop shell's update state. Returns null in the browser
 * build and in desktop builds packaged before auto-update existed, so callers
 * can render nothing rather than an update panel that cannot work.
 */
export function useUpdateState(): {
  state: UpdateState | null;
  check: () => void;
  download: () => void;
  install: () => void;
  openReleases: () => void;
} {
  const bridge = desktopBridge()?.update ?? null;
  const [state, setState] = useState<UpdateState | null>(null);

  useEffect(() => {
    if (!bridge) return;
    let live = true;
    void bridge.state().then((s) => {
      if (live) setState(s);
    });
    const off = bridge.onState((s) => setState(s));
    return () => {
      live = false;
      off();
    };
  }, [bridge]);

  return {
    state,
    check: () => void bridge?.check(),
    download: () => void bridge?.download(),
    install: () => void bridge?.install(),
    openReleases: () => void bridge?.openReleases(),
  };
}

/** The full control, for the Settings page. */
export function UpdatePanel() {
  const { state, check, download, install, openReleases } = useUpdateState();
  if (!state) return null;

  const busy = state.status === 'checking' || state.status === 'downloading';

  return (
    <section className="settings-block">
      <h2>Updates</h2>
      <div className="settings-row">
        <div>
          <strong>Version {state.version}</strong>
          <p className="muted">
            {state.status === 'unsupported' && state.reason}
            {state.status === 'idle' && 'Checks automatically each time the app starts.'}
            {state.status === 'checking' && 'Checking for a new version…'}
            {state.status === 'current' && 'You are on the latest version.'}
            {state.status === 'available' && (
              <>
                Version <strong>{state.newVersion}</strong> is available.
              </>
            )}
            {state.status === 'downloading' && `Downloading ${state.newVersion}… ${state.percent}%`}
            {state.status === 'ready' && (
              <>
                Version <strong>{state.newVersion}</strong> is downloaded and installs on restart.
              </>
            )}
            {state.status === 'error' && state.message}
          </p>
        </div>
        <div className="settings-actions">
          {state.status === 'available' && (
            <button className="cta" onClick={download}>
              Download update
            </button>
          )}
          {state.status === 'ready' && (
            <button className="cta" onClick={install}>
              Restart and install
            </button>
          )}
          {state.status !== 'unsupported' && state.status !== 'ready' && (
            <button disabled={busy} onClick={check}>
              {state.status === 'checking' ? 'Checking…' : 'Check now'}
            </button>
          )}
          <button onClick={openReleases}>Release notes</button>
        </div>
      </div>

      {state.status === 'downloading' && (
        <div className="progress-track" role="progressbar" aria-valuenow={state.percent} aria-valuemin={0} aria-valuemax={100}>
          <div className="progress-fill" style={{ width: `${state.percent}%` }} />
        </div>
      )}

      {state.status === 'available' && state.notes && (
        <details className="release-notes">
          <summary>What&rsquo;s new in {state.newVersion}</summary>
          <pre>{state.notes}</pre>
        </details>
      )}

      {state.status === 'ready' && (
        <p className="muted hint-line">
          Your imported data, watchlist, and settings live outside the app and are not touched by an
          update.
        </p>
      )}
    </section>
  );
}

/**
 * A one-line nudge for the header. Only appears once there is something to act
 * on, so the normal case is invisible.
 */
export function UpdateBadge({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { state, install } = useUpdateState();
  if (!state) return null;
  if (state.status === 'available') {
    return (
      <button className="update-badge" onClick={onOpenSettings} title={`Version ${state.newVersion} is available`}>
        ↑ Update
      </button>
    );
  }
  if (state.status === 'ready') {
    return (
      <button className="update-badge ready" onClick={install} title={`Restart to install ${state.newVersion}`}>
        ↑ Restart to update
      </button>
    );
  }
  return null;
}
