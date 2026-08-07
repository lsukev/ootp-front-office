import { useEffect, useState } from 'react';
import { generateStorylines, getStorylines, type StorylineCache } from '../api';

const CATEGORY_ICONS: Record<string, string> = {
  'The Club': '⚾',
  'Player Spotlight': '⭐',
  'Down on the Farm': '🌾',
  'Front Office': '💼',
  'Looking Ahead': '🔭',
};

export function Storylines({ orgId, orgLabel }: { orgId: number; orgLabel: string }) {
  const [data, setData] = useState<StorylineCache | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setLoaded(false);
    setError(null);
    getStorylines(orgId)
      .then((d) => {
        setData(d);
        setLoaded(true);
      })
      .catch((e) => setError(e.message));
  }, [orgId]);

  const generate = async () => {
    setGenerating(true);
    setError(null);
    try {
      setData(await generateStorylines(orgId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="storylines">
      <div className="masthead">
        <div>
          <h2 className="masthead-title">{orgLabel} Storylines</h2>
          <span className="muted">
            {data
              ? `As of ${data.gameDate} in-game · written ${new Date(data.generatedAt).toLocaleString()}`
              : 'AI-written beat coverage of your organization, grounded in your save data'}
          </span>
        </div>
        <button className="btn-feature" onClick={generate} disabled={generating}>
          {generating ? 'Writing…' : data ? '↻ Fresh Storylines' : '✍ Write Storylines'}
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}
      {generating && (
        <p className="muted generating">
          The beat writer is combing through standings, box scores, prospect reports, and the payroll ledger… this
          takes half a minute or so.
        </p>
      )}

      {loaded && !data && !generating && !error && (
        <div className="hint">
          <h3>No storylines yet</h3>
          <p>
            Hit <strong>Write Storylines</strong> and Claude will read your org's standings, recent results, stat
            leaders, prospect signals, and contract situations — then write the stories. Regenerate any time after
            you sim and re-export.
          </p>
        </div>
      )}

      {data && (
        <div className="story-grid">
          {data.storylines.map((s, i) => (
            <article key={i} className="story-card">
              <span className="story-category">
                {CATEGORY_ICONS[s.category] ?? '📰'} {s.category}
              </span>
              <h3 className="story-headline">{s.headline}</h3>
              <p className="story-body">{s.body}</p>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
