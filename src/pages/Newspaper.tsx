import { FallbackNotice } from '../FallbackNotice';
import { useJob } from '../useJob';
import { type IssueCache } from '../api';
import { PlayerNames } from '../PlayerNames';

/**
 * The league, as a paper.
 *
 * One issue rather than the two overlapping AI pages this replaces: a front
 * page with a lead, sections the editor chose, and a column of shorts. The
 * layout is a paper's because the content is — a lead story set wide, the rest
 * in columns, and rules between them.
 */
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
          <h2 className="masthead-title">{issue?.masthead ?? data?.leagueName ?? 'The League'}</h2>
          <span className="muted">
            {issue && data?.gameDate
              ? `${data.gameDate} · set ${new Date(data.generatedAt ?? '').toLocaleString()}`
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
        <>
          <article className="lead-story">
            <h1>{issue.lead.headline}</h1>
            {issue.lead.standfirst && (
              <p className="standfirst">
                <PlayerNames orgId={orgId}>{issue.lead.standfirst}</PlayerNames>
              </p>
            )}
            {/*
              The opening paragraph is marked rather than found with
              :first-of-type — the standfirst above is a <p> too, so the
              pseudo-class was landing on that and the drop cap never appeared.
            */}
            {issue.lead.body.split(/\n\s*\n/).map((para, i) => (
              <p key={i} className={i === 0 ? 'lead-body lead-open' : 'lead-body'}>
                <PlayerNames orgId={orgId}>{para}</PlayerNames>
              </p>
            ))}
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
              <section className="paper-section">
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
        </>
      )}
    </div>
  );
}
