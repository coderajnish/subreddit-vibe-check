/**
 * Vercel Serverless Function — Reddit JSON proxy (Node runtime).
 *
 * The browser never calls reddit.com directly; it requests this same-origin
 * endpoint, which runs in Vercel's cloud and fetches Reddit server-side.
 * This works even when the local network blocks reddit.com, because the
 * upstream request originates from Vercel's servers, not the user's machine.
 *
 * GET /api/reddit?subreddit=nba&limit=50
 *   - subreddit: name, with or without a leading "r/" (required)
 *   - limit:     number of posts, clamped to 1..100 (default: 50)
 *
 * The upstream body is always validated with JSON.parse before being sent:
 *   - valid JSON: re-serialized and returned with Reddit's status code and
 *     Content-Type: application/json; charset=utf-8
 *   - invalid JSON (block page, HTML error, proxy banner): 502 with
 *     { error, upstreamStatus, upstreamContentType, bodyPreview }
 *
 * CORS is wide open (Access-Control-Allow-Origin: *) so the frontend can use
 * this endpoint cross-origin via VITE_API_BASE while developing locally.
 * No OAuth, no credentials, no user data — a public read-only proxy.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

const REDDIT_ORIGIN = "https://www.reddit.com";
const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;
const UPSTREAM_TIMEOUT_MS = 20_000;
const USER_AGENT = "SubredditVibeCheck/1.0";

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(payload));
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "Method not allowed. Use GET." });
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const subreddit = (url.searchParams.get("subreddit") ?? "")
      .trim()
      .replace(/^\/?r\//i, "")
      .replace(/\/+$/, "")
      .toLowerCase();

    if (!subreddit) {
      sendJson(res, 400, { error: "Missing or invalid 'subreddit' query parameter." });
      return;
    }

    let limit = DEFAULT_LIMIT;
    const rawLimit = url.searchParams.get("limit");
    if (rawLimit !== null) {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed < 1) {
        sendJson(res, 400, { error: "'limit' must be a positive integer." });
        return;
      }
      limit = Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, parsed));
    }

    const upstream = await fetch(
      `${REDDIT_ORIGIN}/r/${encodeURIComponent(subreddit)}/hot.json?limit=${limit}&raw_json=1`,
      {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      }
    );

    const text = await upstream.text();
    const upstreamContentType = upstream.headers.get("content-type") ?? "";

    // Always validate the upstream body with JSON.parse before forwarding.
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      sendJson(res, 502, {
        error: `Reddit returned a non-JSON response (HTTP ${upstream.status}).`,
        upstreamStatus: upstream.status,
        upstreamContentType,
        bodyPreview: text.slice(0, 200),
      });
      return;
    }

    // Pass through Reddit's status so the frontend can distinguish 404, 403,
    // 429, etc. The body is re-serialized with an explicit JSON content-type.
    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "s-maxage=30, stale-while-revalidate=60",
    };
    const retryAfter = upstream.headers.get("retry-after");
    if (retryAfter) headers["Retry-After"] = retryAfter;

    res.writeHead(upstream.status, headers);
    res.end(JSON.stringify(parsed));
  } catch (error) {
    // Network failure, upstream timeout, or unexpected error.
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : "Upstream Reddit request failed.",
    });
  }
}
