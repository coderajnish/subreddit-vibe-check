import { useCallback, useMemo, useRef, useState } from "react";
import { cleanSubredditInput, fetchHotPosts } from "./api/reddit";
import { analyzeTitle, roundAverage } from "./sentiment/analyze";
import type { AnalyzedPost, SentimentLabel, SentimentSummary } from "./types/reddit";
import SearchForm from "./components/SearchForm";
import SummaryCards from "./components/SummaryCards";
import PostsList from "./components/PostsList";

type Status = "idle" | "loading" | "success" | "error";

const EMPTY_COUNTS: Record<SentimentLabel, number> = { positive: 0, neutral: 0, negative: 0 };

/**
 * The Subreddit Vibe Check.
 * Fetches a subreddit's top 50 hot posts, scores every title client-side
 * with the "sentiment" package, and renders a summary + tinted post list.
 */
export default function App() {
  const [status, setStatus] = useState<Status>("idle");
  const [posts, setPosts] = useState<AnalyzedPost[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [subreddit, setSubreddit] = useState<string | null>(null);
  /** Last attempted query, so the error banner can offer a one-click retry. */
  const [lastInput, setLastInput] = useState<string | null>(null);
  /** Guards against overlapping requests (double-submit / rapid chip clicks). */
  const inFlightRef = useRef(false);

  const handleCheck = useCallback(async (rawInput: string) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    setStatus("loading");
    setError(null);
    setLastInput(rawInput);

    // Show the requested subreddit in the loading banner right away.
    const requested = cleanSubredditInput(rawInput);
    if (requested) setSubreddit(requested);

    try {
      const rawPosts = await fetchHotPosts(rawInput);
      const analyzedPosts: AnalyzedPost[] = rawPosts.map((post) => {
        const { score, label } = analyzeTitle(post.title);
        return { ...post, sentimentScore: score, sentimentLabel: label };
      });

      setPosts(analyzedPosts);
      setSubreddit(analyzedPosts[0]?.subreddit || null);
      setStatus("success");
    } catch (err) {
      setPosts([]);
      setSubreddit(null);
      setError(err instanceof Error ? err.message : "Something went wrong while checking the vibe.");
      setStatus("error");
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  /** Aggregated summary: average score + counts + percentages, memoized. */
  const summary = useMemo<SentimentSummary | null>(() => {
    if (posts.length === 0) return null;

    const counts = { ...EMPTY_COUNTS };
    const scores: number[] = [];

    for (const post of posts) {
      counts[post.sentimentLabel] += 1;
      scores.push(post.sentimentScore);
    }

    const averageScore = roundAverage(scores);
    const percentages: Record<SentimentLabel, number> = {
      positive: counts.positive / posts.length,
      neutral: counts.neutral / posts.length,
      negative: counts.negative / posts.length,
    };

    return { total: posts.length, averageScore, counts, percentages };
  }, [posts]);

  return (
    <div className="app">
      <header className="app-header">
        <h1>The Subreddit Vibe Check</h1>
        <p className="tagline">
          Client-side sentiment analysis of a subreddit&apos;s top 50 hot posts — powered by the npm{" "}
          <code>sentiment</code> package.
        </p>
      </header>

      <SearchForm loading={status === "loading"} onCheck={handleCheck} />

      {status === "loading" && (
        <div className="status-banner" role="status">
          <span className="spinner" aria-hidden="true" />
          <span>
            {subreddit ? `Fetching and analyzing r/${subreddit}…` : "Fetching and analyzing…"}
          </span>
        </div>
      )}

      {status === "error" && (
        <div className="status-banner status-banner--error" role="alert">
          <span aria-hidden="true">⚠️</span>
          <div className="error-content">
            <p>{error}</p>
            {lastInput && (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => handleCheck(lastInput)}
              >
                Try again
              </button>
            )}
          </div>
        </div>
      )}

      {status === "success" && summary && subreddit && (
        <SummaryCards subreddit={subreddit} summary={summary} />
      )}

      <PostsList posts={posts} />

      <footer className="app-footer">
        <p>
          Titles are scored with the <code>sentiment</code> lexicon: score ≥ 2 is positive, score ≤ −2
          is negative, everything else is neutral. Data comes from Reddit&apos;s public JSON API — no
          backend involved.
        </p>
      </footer>
    </div>
  );
}
