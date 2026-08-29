import { useEffect, useMemo, useState } from 'react';
import { apiGet } from '../api';
import { PlayerLink } from '../playerModal';

interface Segment { text: string; kind?: 'player' | 'team'; id?: number }
interface Transaction {
  date: string | null;
  kind: 'trade' | 'signing' | 'waiver' | 'contract';
  seenBetween?: { from: string | null; to: string | null };
  summary: Segment[];
  plain: string;
  yours: boolean;
}
interface Feed { transactions: Transaction[]; yours: number; available: boolean }

const KIND_LABEL: Record<Transaction['kind'], string> = {
  trade: 'Trade',
  signing: 'Signing',
  waiver: 'Waivers',
  contract: 'Contract',
};

/**
 * OOTP writes its summaries with the names marked up, so every player in a deal
 * can be opened from the sentence describing it rather than looked up
 * afterwards.
 */
function Summary({ segments }: { segments: Segment[] }) {
  return (
    <>
      {segments.map((s, i) =>
        s.kind === 'player' && s.id ? (
          <PlayerLink key={i} id={s.id}>{s.text}</PlayerLink>
        ) : s.kind === 'team' ? (
          <strong key={i}>{s.text}</strong>
        ) : (
          <span key={i}>{s.text}</span>
        )
      )}
    </>
  );
}

export function Transactions({ orgId }: { orgId: number }) {
  const [data, setData] = useState<Feed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mine, setMine] = useState(false);
  const [kind, setKind] = useState<'all' | Transaction['kind']>('all');

  useEffect(() => {
    setData(null);
    setError(null);
    apiGet<Feed>(`/api/transactions/${orgId}`).then(setData).catch((e) => setError(e.message));
  }, [orgId]);

  const shown = useMemo(() => {
    if (!data) return [];
    return data.transactions.filter(
      (t) => (!mine || t.yours) && (kind === 'all' || t.kind === kind)
    );
  }, [data, mine, kind]);

  const kinds = useMemo(
    () => [...new Set((data?.transactions ?? []).map((t) => t.kind))],
    [data]
  );

  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <p className="muted">Reading the league's paperwork…</p>;

  if (data.transactions.length === 0) {
    return (
      <div className="hint">
        <h3>No transactions in this export</h3>
        <p>
          {data.available
            ? 'The league has not traded or signed anybody yet — the moment it does, the deals show up here.'
            : 'This save does not carry the trade and message tables the feed is built from.'}
        </p>
      </div>
    );
  }

  return (
    <div>
      <p className="muted hint-line">
        Every deal in the league, newest first, as OOTP itself recorded it — trades with both sides
        named, free-agent signings, and waiver claims. Your own moves are marked. The point of the
        rest is the one a reader put better than I would: watching for a man who fits a hole you have
        turning up on waivers or changing hands cheaply.
      </p>
      <p className="muted hint-line">
        Where the dates come from, since it matters. Trades and waiver claims are the game's own
        records and are exact. <strong>Signings</strong> come from the league's news, and OOTP does
        not write a story for every one — it favours the bigger name, so a quiet extension can go
        unreported. Those turn up as <strong>Contract</strong> instead: the app noticed the deal
        changed between two of your exports, so it knows what happened but only the window it
        happened in, not the day. That needs two imports to see anything, and it can never recover a
        signing from before you started importing.
      </p>

      <div className="toolbar">
        <span className="level-picker">
          <button className={mine ? '' : 'active'} onClick={() => setMine(false)}>
            Whole league
          </button>
          <button className={mine ? 'active' : ''} onClick={() => setMine(true)}>
            My club ({data.yours})
          </button>
        </span>
        {kinds.length > 1 && (
          <span className="level-picker">
            <button className={kind === 'all' ? 'active' : ''} onClick={() => setKind('all')}>
              All
            </button>
            {kinds.map((k) => (
              <button key={k} className={kind === k ? 'active' : ''} onClick={() => setKind(k)}>
                {KIND_LABEL[k]}
              </button>
            ))}
          </span>
        )}
        <span className="muted">
          {shown.length} of {data.transactions.length}
        </span>
      </div>

      {shown.length === 0 ? (
        <p className="muted">Nothing matches those filters.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Kind</th>
              <th>What happened</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((t, i) => (
              <tr key={i} className={t.yours ? 'ours' : undefined}>
                <td className="num">
                  {t.date ?? ''}
                  {t.seenBetween && (
                    <div className="muted seen-between">
                      since {t.seenBetween.from}
                    </div>
                  )}
                </td>
                <td>
                  <span className={`badge txn-${t.kind}`}>{KIND_LABEL[t.kind]}</span>
                </td>
                <td className="wrap-cell">
                  <Summary segments={t.summary} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
