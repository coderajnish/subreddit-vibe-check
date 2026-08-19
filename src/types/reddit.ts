/**
 * Shared TypeScript types for the Reddit JSON API and the sentiment pipeline.
 * Kept in one module so api/, sentiment/ and components/ all agree on shapes.
 */

export type SentimentLabel = "positive" | "neutral" | "negative";

/** Raw shape of a single post from Reddit's JSON endpoint (json.data.children[].data). */
export interface RedditPostData {
  id: string;
  title: string;
  author: string;
  score: number;
  num_comments: number;
  permalink: string;
  subreddit: string;
  stickied?: boolean;
  over_18?: boolean;
  created_utc?: number;
}

/** One child of the listing: { kind: "t3", data: RedditPostData }. */
export interface RedditChild {
  kind: string;
  data: RedditPostData;
}

/** Top-level shape of https://www.reddit.com/r/{sub}/hot.json. */
export interface RedditListingResponse {
  kind: string;
  data: {
    children: RedditChild[];
    after: string | null;
    before: string | null;
    dist?: number;
  };
}

/** A post enriched with its client-side sentiment analysis. */
export interface AnalyzedPost extends RedditPostData {
  sentimentScore: number;
  sentimentLabel: SentimentLabel;
}

/** Aggregated summary computed from the analyzed posts. */
export interface SentimentSummary {
  total: number;
  averageScore: number;
  counts: Record<SentimentLabel, number>;
  percentages: Record<SentimentLabel, number>;
}

/** Human-readable overall vibe derived from the average score. */
export interface Vibe {
  emoji: string;
  label: string;
}
