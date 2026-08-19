// api/reddit.ts
/**
 * Vercel Serverless Function — Reddit JSON proxy (Node runtime).
 *
 * GET /api/reddit?subreddit=nba&limit=50
 *
 * Notes:
 * - Always responds with JSON (application/json), even when Reddit returns HTML.
 * - Tries multiple upstream origins to reduce 403/blocked responses:
 *     1) https://api.reddit.com  (preferred)
 *     2) https://www.reddit.com
 *     3) https://old.reddit.com
 * - Adds a more realistic User-Agent + Referer (helps avoid 403).
 * - Adds CORS headers so you can use VITE_API_BASE from local dev if needed.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;
const UPSTREAM_TIMEOUT_MS = 25_000;

const USER_AGENT =
  "Mozilla/5.0 (compatible; SubredditVibeCheck/1.0; +https://github.com/coderajnish/subreddit-vibe-check)";

function sendJson(res: ServerResponse, status: number, payload: unknown, extraHeaders: Record<string, string> = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Cache-Control": "s-maxage=30, stale-while-revalidate=60",
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

function bodyPreview(text: string, n = 400) {
  return text.slice(0, n);
}

async function fetchWithTimeout(url: string, headers: Record<string, string>): Promise<Response> {
  // AbortSignal.timeout exists in Node 18+, but keep a fallback.
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    return await fetch(url, {
      headers,
      signal: (AbortSignal as any).timeout ? (AbortSignal as any).timeout(UPSTREAM_TIMEOUT_MS) : controller.signal,
    });
  } finally {
    clearTimeout(id);
  }
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (req.method === "OPTIONS") {
      // Preflight
      sendJson(res, 204, null);
      return;
    }

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

    const upstreamCandidates = [
      `https://api.reddit.com/r/${encodeURIComponent(subreddit)}/hot?limit=${limit}&raw_json=1`,
      `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/hot.json?limit=${limit}&raw_json=1`,
      `https://old.reddit.com/r/${encodeURIComponent(subreddit)}/hot.json?limit=${limit}&raw_json=1`,
    ];

    const headers = {
      "User-Agent": USER_AGENT,
      "Accept": "application/json, text/javascript;q=0.9, */*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/`,
    };

    let lastFailure: any = null;

    for (const upstreamUrl of upstreamCandidates) {
      let upstream: Response;
      let text = "";
      let upstreamContentType = "";

      try {
        upstream = await fetchWithTimeout(upstreamUrl, headers);
        upstreamContentType = upstream.headers.get("content-type") ?? "";
        text = await upstream.text();
      } catch (e: any) {
        lastFailure = {
          error: "Upstream fetch failed",
          message: e?.message ?? String(e),
          urlTried: upstreamUrl,
        };
        continue;
      }

      // Try to parse JSON even if content-type is text/javascript (Reddit does this).
      let parsed: unknown = null;
      let parsedOk = false;
      try {
        parsed = JSON.parse(text);
        parsedOk = true;
      } catch {
        parsedOk = false;
      }

      // If success and JSON parses: return it (even if status is 403/404/etc. — frontend handles status).
      if (parsedOk) {
        const extra: Record<string, string> = {};
        const retryAfter = upstream.headers.get("retry-after");
        if (retryAfter) extra["Retry-After"] = retryAfter;

        sendJson(res, upstream.status, parsed, extra);
        return;
      }

      // If NOT JSON, record failure and try next candidate (common for 403 HTML pages).
      lastFailure = {
        error: "Upstream returned non-JSON",
        upstreamStatus: upstream.status,
        upstreamContentType,
        bodyPreview: bodyPreview(text, 400),
        urlTried: upstreamUrl,
      };

      // If it's a hard success (200) but body isn't JSON, no point continuing much,
      // but we'll still try the other origins once.
      continue;
    }

    // All candidates failed to return JSON.
    // Return a JSON error so the frontend doesn't mis-diagnose "proxy not deployed".
    sendJson(res, 502, lastFailure ?? { error: "All upstream attempts failed." });
  } catch (error: any) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : "Unexpected proxy error." });
  }
}