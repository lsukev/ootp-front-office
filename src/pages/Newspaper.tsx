import { FallbackNotice } from '../FallbackNotice';
import { useJob } from '../useJob';
import { type IssueCache } from '../api';
import { PlayerNames } from '../PlayerNames';

/**
 * The league, as a paper.
 *
 * Set as a printed page rather than as another panel in the app: newsprint,
 * a masthead over a folio line, a lead across the full measure and the rest in
 * columns with rules between them. The sheet keeps its own ink and its own
 * paper regardless of the app's theme, because that is what makes it read as a
 * thing lying on the desk rather than a screen the app happens to be showing.
 *
 * The controls live outside the sheet. A real front page has no buttons on it,
 * and every one left inside it was the thing the eye went to first.
 */

/** "2027-05-16" the way a paper prints it, and unpadded dates are OOTP's own. */
function printDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  // Constructed as local rather than parsed as UTC — new Date('2027-05-16')
  // is midnight GMT, which is the day before for anybody west of London
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

export function Newspaper({ orgId }: { orgId: number }) {
  const { data, error, running: writing, start: write } = useJob<IssueCache>(
    `/api/newspaper/${orgId}`
  );
  const loaded = data !== null;
  const issue = data?.issue ?? null;

  return (
    <div className="paper">
      <div className="masthead">
        <div>
          <h2 className="masthead-title">The Paper</h2>
          <span className="muted">
            {issue && data?.gameDate
              ? `Edition of ${data.gameDate} · set ${new Date(data.generatedAt ?? '').toLocaleString()}`
              : 'A daily paper for your league, written from your save'}
          </span>
        </div>
        <button className="btn-feature" onClick={() => void write()} disabled={writing}>
          {writing ? 'Going to press…' : issue ? '↻ New Edition' : '✍ Print an Edition'}
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}
      {data?.notice && <FallbackNotice notice={data.notice} />}

      {writing && (
        <p className="muted generating">
          The desk is going through last night's results, the tables, the wire and the farm
          reports. This runs on the server, so you can go elsewhere in the app — the edition will
          be here when you come back.
        </p>
      )}

      {loaded && !issue && !writing && !error && (
        <div className="hint">
          <h3>No edition yet</h3>
          <p>
            Press <strong>Print an Edition</strong> and the desk will read your league — last
            night's scores, every division table, the transaction wire, the leaders and your farm
            system — and decide for itself what belongs on the front page. It will not always be
            your club, which is the point of a paper rather than a fanzine.
          </p>
          <p className="muted">
            Turn on <strong>generate after import</strong> in Settings and a fresh edition is set
            every time you re-export.
          </p>
        </div>
      )}

      {issue && (
        <div className="newsprint">
          <header className="paper-masthead">
            <h1 className="paper-name">{issue.masthead}</h1>
            <div className="folio">
              <span>{data?.leagueName ?? ''}</span>
              <span className="folio-date">{data?.gameDate ? printDate(data.gameDate) : ''}</span>
              <span>Front Office</span>
            </div>
          </header>

          <article className="lead">
            <h2 className="lead-headline">{issue.lead.headline}</h2>
            {issue.lead.standfirst && (
              <p className="deck">
                <PlayerNames orgId={orgId}>{issue.lead.standfirst}</PlayerNames>
              </p>
            )}
            {/*
              The opening paragraph is marked rather than found with
              :first-of-type — the standfirst above is a <p> too, so the
              pseudo-class was landing on that and the drop cap never appeared.
            */}
            <div className="lead-columns">
              {issue.lead.body.split(/\n\s*\n/).map((para, i) => (
                <p key={i} className={i === 0 ? 'lead-body lead-open' : 'lead-body'}>
                  <PlayerNames orgId={orgId}>{para}</PlayerNames>
                </p>
              ))}
            </div>
          </article>

          <div className="paper-columns">
            {issue.sections.map((section, i) => (
              <section key={i} className="paper-section">
                <h3 className="section-rule">{section.title}</h3>
                {section.stories.map((story, j) => (
                  <article key={j} className="paper-story">
                    <h4>{story.headline}</h4>
                    <p>
                      <PlayerNames orgId={orgId}>{story.body}</PlayerNames>
                    </p>
                  </article>
                ))}
              </section>
            ))}

            {issue.briefs.length > 0 && (
              <section className="paper-section brief-box">
                <h3 className="section-rule">In Brief</h3>
                <ul className="paper-briefs">
                  {issue.briefs.map((brief, i) => (
                    <li key={i}>
                      <PlayerNames orgId={orgId}>{brief}</PlayerNames>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>

          {/*
            The one place a paper talks about itself. It is here because this
            page is the most tempting thing in the app to mistake for reporting.
          */}
          <footer className="colophon">
            Set from your save file. Every figure comes from your own export — nothing is quoted
            and nothing is invented.
          </footer>
        </div>
      )}
    </div>
  );
}
