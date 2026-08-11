import { useJob } from '../useJob';
import { generateStorylines, getStorylines, type StorylineCache } from '../api';
import { PlayerNames } from '../PlayerNames';

const CATEGORY_ICONS: Record<string, string> = {
  'The Club': '⚾',
  'Player Spotlight': '⭐',
  'Down on the Farm': '🌾',
  'Front Office': '💼',
  'Looking Ahead': '🔭',
};

export function Storylines({ orgId, orgLabel }: { orgId: number; orgLabel: string }) {
  // Written on the server, so this watches rather than waits: start a set and
  // go elsewhere in the app while it is made
  const { data, error, running: generating, start: generate } = useJob<StorylineCache>(
    `/api/storylines/${orgId}`
  );
  const loaded = data !== null;

  return (
    <div className="storylines">
      <div className="masthead">
        <div>
          <h2 className="masthead-title">{orgLabel} Storylines</h2>
          <span className="muted">
            {data?.storylines && data.generatedAt
              ? `As of ${data.gameDate} in-game · written ${new Date(data.generatedAt).toLocaleString()}`
              : 'AI-written beat coverage of your organization, grounded in your save data'}
          </span>
        </div>
        <button className="btn-feature" onClick={() => void generate()} disabled={generating}>
          {generating ? 'Writing…' : data?.storylines ? '↻ Fresh Storylines' : '✍ Write Storylines'}
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}
      {data?.notice && <div className="banner notice">{data.notice}</div>}
      {generating && (
        <p className="muted generating">
          The beat writer is combing through standings, box scores, prospect reports and the payroll
          ledger. This runs on the server, so you can go elsewhere in the app — the stories will be
          here when you come back.
        </p>
      )}

      {loaded && !data?.storylines && !generating && !error && (
        <div className="hint">
          <h3>No storylines yet</h3>
          <p>
            Hit <strong>Write Storylines</strong> and the AI will read your org's standings, recent results, stat
            leaders, prospect signals, and contract situations — then write the stories. Regenerate any time after
            you sim and re-export.
          </p>
        </div>
      )}

      {data?.storylines && (
        <div className="story-grid">
          {data.storylines.map((s, i) => (
            <article key={i} className="story-card">
              <span className="story-category">
                {CATEGORY_ICONS[s.category] ?? '📰'} {s.category}
              </span>
              <h3 className="story-headline">{s.headline}</h3>
              <p className="story-body"><PlayerNames orgId={orgId}>{s.body}</PlayerNames></p>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
