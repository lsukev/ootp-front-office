import { FallbackNotice } from '../FallbackNotice';
import { useJob } from '../useJob';
import { type RecapCache } from '../api';
import { PlayerNames } from '../PlayerNames';
import { coveredShort } from '../coverage';

/**
 * Lately, around the league.
 *
 * Every other page here is about the reader's own club. This is the morning
 * paper: who won, what it did to the races, and who is out in front of the
 * league in something. It ends on the last day the league actually played
 * rather than the save's today, because a save exported mid-morning has not
 * played today's games yet — and it begins where the reader's last export
 * left off, so an online league simmed a week at a time gets the week rather
 * than the seventh day of it.
 */
export function LeagueRecap({ orgId }: { orgId: number }) {
  const { data, error, running: generating, start: generate } = useJob<RecapCache>(
    `/api/daily-recap/${orgId}`
  );
  const loaded = data !== null;
  const recap = data?.recap ?? null;

  return (
    <div className="storylines">
      <div className="masthead">
        <div>
          <h2 className="masthead-title">{data?.leagueName ?? 'League'} Recap</h2>
          <span className="muted">
            {recap && data?.gameDate
              ? `Games of ${coveredShort(data.gameDate, data.from, data.days)} · ` +
                `written ${new Date(data.generatedAt ?? '').toLocaleString()}`
              : 'Every game across the league since your last export, written up'}
          </span>
        </div>
        <button className="btn-feature" onClick={() => void generate()} disabled={generating}>
          {generating ? 'Writing…' : recap ? '↻ Fresh Recap' : '✍ Write Recap'}
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}
      {data?.notice && <FallbackNotice notice={data.notice} />}

      {/*
        A recap of the fourth read on the sixth is not wrong, but showing it
        without saying so is. The date it covers is in the masthead; this says
        plainly that the league has moved on since.
      */}
      {recap && data?.stale && !generating && (
        <div className="banner">
          This covers {coveredShort(data.gameDate, data.from, data.days)}. The league has played
          through {data.latestPlayed} since — write a fresh one for the latest games.
        </div>
      )}

      {generating && (
        <p className="muted generating">
          Reading the day's box scores and the tables behind them. This runs on the server, so you can
          go elsewhere in the app — the recap will be here when you come back.
        </p>
      )}

      {loaded && !recap && !generating && !error && (
        <div className="hint">
          <h3>No recap yet</h3>
          <p>
            Hit <strong>Write Recap</strong> and the AI will read the last day the league played — every
            score, every division table, and the season's leaders — and write it up division by division.
            Divisions that had no games are left out rather than padded. Turn on{' '}
            <strong>generate after import</strong> in Settings and a new one is written each time you
            re-export.
          </p>
        </div>
      )}

      {recap && (
        <div className="recap">
          {recap.summary && (
            <p className="recap-summary"><PlayerNames orgId={orgId}>{recap.summary}</PlayerNames></p>
          )}
          <div className="story-grid">
            {recap.divisions.map((d, i) => (
              <article key={i} className="story-card">
                <span className="story-category">⚾ {d.division}</span>
                <p className="story-body"><PlayerNames orgId={orgId}>{d.body}</PlayerNames></p>
              </article>
            ))}
          </div>
          {recap.notes.length > 0 && (
            <section className="recap-notes">
              <h3>Around the league</h3>
              <ul>
                {recap.notes.map((n, i) => (
                  <li key={i}><PlayerNames orgId={orgId}>{n}</PlayerNames></li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
