/**
 * Client-side sentiment analysis.
 *
 * Wraps the npm "sentiment" package (pure-JS AFINN-style lexicon) so the rest
 * of the app never touches it directly. All label thresholds live here.
 */

import Sentiment from "sentiment";
import type { SentimentLabel, Vibe } from "../types/reddit";

/** Singleton analyzer — one instance is safe to reuse across all titles. */
const analyzer = new Sentiment();

export const POSITIVE_THRESHOLD = 2;
export const NEGATIVE_THRESHOLD = -2;

/** Maps an integer score to a label: >= 2 positive, <= -2 negative, else neutral. */
export function labelForScore(score: number): SentimentLabel {
  if (score >= POSITIVE_THRESHOLD) return "positive";
  if (score <= NEGATIVE_THRESHOLD) return "negative";
  return "neutral";
}

/** Runs the sentiment lexicon over a post title and returns score + label. */
export function analyzeTitle(title: string): { score: number; label: SentimentLabel } {
  const { score } = analyzer.analyze(String(title ?? ""));
  return { score, label: labelForScore(score) };
}

/** Mean of all title scores, rounded to 2 decimals. Returns 0 for empty input. */
export function roundAverage(scores: number[]): number {
  if (scores.length === 0) return 0;
  const sum = scores.reduce((total, score) => total + score, 0);
  return Math.round((sum / scores.length) * 100) / 100;
}

/** Maps an average score to a human-readable overall vibe. */
export function overallVibe(averageScore: number): Vibe {
  if (averageScore >= 2) return { emoji: "😄", label: "Very positive" };
  if (averageScore >= 0.5) return { emoji: "🙂", label: "Mostly positive" };
  if (averageScore > -0.5) return { emoji: "😐", label: "Mixed vibes" };
  if (averageScore > -2) return { emoji: "🙁", label: "Mostly negative" };
  return { emoji: "😞", label: "Very negative" };
}
