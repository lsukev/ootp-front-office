import { useState } from 'react';
import { apiPost } from './api';

/**
 * A model was swapped for one that works, and the way to stop that is here.
 *
 * The first version of this said "pick a model that works in Settings", which
 * is a chore handed to the reader rather than an answer. Since the swap
 * already knows both model ids, the page can simply offer to make it
 * permanent — one press and the notice never comes back.
 */
export interface FallbackNoticeData {
  message: string;
  from: string;
  to: string;
  provider: string;
}

export function FallbackNotice({ notice, onSwitched }: {
  notice: FallbackNoticeData;
  onSwitched?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const keep = async () => {
    setBusy(true);
    try {
      await apiPost('/api/settings', { provider: notice.provider, model: notice.to });
      setDone(true);
      onSwitched?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="banner notice">
      <span>{notice.message}</span>{' '}
      {done ? (
        <strong>{notice.to} is now your model for this service.</strong>
      ) : (
        <button className="link-button" onClick={() => void keep()} disabled={busy}>
          {busy ? 'Saving…' : `Use ${notice.to} from now on`}
        </button>
      )}
    </div>
  );
}
