import { overallVibe } from "../sentiment/analyze";
import type { SentimentLabel, SentimentSummary } from "../types/reddit";

interface SummaryCardsProps {
  subreddit: string;
  summary: SentimentSummary;
}

const LABEL_META: Record<SentimentLabel, { label: string; tone: string }> = {
  positive: { label: "Positive", tone: "positive" },
  neutral: { label: "Neutral", tone: "neutral" },
  negative: { label: "Negative", tone: "negative" },
};

/** Formats an average score with a leading "+" for positive values. */
function formatScore(score: number): string {
  return score > 0 ? `+${score}` : `${score}`;
}

/** Vibe banner + 4 responsive summary cards (average, positive, neutral, negative). */
export default function SummaryCards({ subreddit, summary }: SummaryCardsProps) {
  const vibe = overallVibe(summary.averageScore);

  return (
    <section className="summary" aria-label="Sentiment summary">
      <div className="vibe-banner">
        <span className="vibe-emoji" aria-hidden="true">
          {vibe.emoji}
        </span>
        <div>
          <h2>
            r/{subreddit} is feeling {vibe.label.toLowerCase()}
          </h2>
          <p className="vibe-sub">
            Average sentiment score <strong>{formatScore(summary.averageScore)}</strong> across{" "}
            {summary.total} hot posts
          </p>
        </div>
      </div>

      <div className="summary-grid">
        <div className="summary-card summary-card--average">
          <span className="summary-card-label">Average Score</span>
          <span className="summary-card-value">{formatScore(summary.averageScore)}</span>
          <span className="summary-card-sub">mean of {summary.total} title scores</span>
        </div>

        {(Object.keys(LABEL_META) as SentimentLabel[]).map((label) => {
          const meta = LABEL_META[label];
          const percent = Math.round(summary.percentages[label] * 100);
          return (
            <div key={label} className={`summary-card summary-card--${meta.tone}`}>
              <span className="summary-card-label">{meta.label}</span>
              <span className="summary-card-value">{summary.counts[label]}</span>
              <span className="summary-card-sub">{percent}% of posts</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
