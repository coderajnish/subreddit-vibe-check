// src/api/reddit.ts
/**
 * Reddit API layer — the browser never calls reddit.com directly.
 *
 * All fetching goes through the serverless proxy:
 *   /api/reddit?subreddit=...&limit=50 (implemented by api/reddit.ts)
 *
 * Can be overridden with VITE_API_BASE (e.g. "https://my-app.vercel.app")
 * so the app can run locally while using the deployed proxy.
 */

import type { RedditListingResponse, RedditPostData } from "../types/reddit";

const POST_LIMIT = 50;
const ATTEMPT_TIMEOUT_MS = 30_000;
const TOTAL_BUDGET_MS = 95_000;
const MAX_ATTEMPTS = 3;
const CACHE_TTL_MS = 60_000;
const VALID_SUBREDDIT_RE = /^[a-z0-9_]{2,21}$/;

const API_BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");

function buildEndpoint(subreddit: string): string {
  return `${API_BASE}/api/reddit?subreddit=${encodeURIComponent(subreddit)}&limit=${POST_LIMIT}`;
}

function proxyTip(subreddit: string): string {
  const base = API_BASE || "your deployed app";
  return `If you're running locally, open ${base}/api/reddit?subreddit=${subreddit}&limit=1 in your browser to verify the serverless proxy.`;
}

function isJsonContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return ct.includes("json") || ct.includes("javascript");
}

export class RedditApiError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "RedditApiError";
    this.status = status;
  }
}

export function cleanSubredditInput(rawInput: string): string {
  return rawInput
    .trim()
    .replace(/^\/?r\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function validateSubreddit(subreddit: string): void {
  if (!subreddit) {
    throw new RedditApiError('Please enter a subreddit name first, e.g. "nba".');
  }
  if (!VALID_SUBREDDIT_RE.test(subreddit)) {
    throw new RedditApiError(
      "That doesn't look like a valid subreddit — names use 2–21 letters, numbers, and underscores."
    );
  }
}

function messageForStatus(subreddit: string, status: number): string {
  if (status === 403) {
    return `Reddit refused access to r/${subreddit} (HTTP 403) — it may be private, banned, or blocking automated requests.`;
  }
  if (status === 404) {
    return `r/${subreddit} does not exist. Double-check the name and try again.`;
  }
  if (status === 429) {
    return "Reddit is rate-limiting requests right now. Wait a minute and try again.";
  }
  return `Reddit responded with HTTP ${status} for r/${subreddit}.`;
}

function isAbortError(error: unknown): boolean {
  // Some browsers throw DOMException, some throw plain Error with name AbortError.
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (typeof error === "object" && error !== null && (error as any).name === "AbortError")
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  const base = Math.min(1_000 * 2 ** (attempt - 1), 8_000);
  return base + Math.floor(Math.random() * 400);
}

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, 10_000);
}

function parseErrorDetail(text: string): string | null {
  try {
    const json = JSON.parse(text) as { error?: unknown };
    return typeof json?.error === "string" && json.error ? json.error : null;
  } catch {
    return null;
  }
}

/* ---------------- In-memory cache (60 s TTL) ---------------- */

interface CacheEntry {
  posts: RedditPostData[];
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(subreddit: string): string {
  return `${subreddit}:${POST_LIMIT}`;
}

function readCache(subreddit: string): RedditPostData[] | null {
  const key = cacheKey(subreddit);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.posts;
}

function writeCache(subreddit: string, posts: RedditPostData[]): void {
  const key = cacheKey(subreddit);
  if (cache.size >= 100 && !cache.has(key)) {
    const now = Date.now();
    for (const [cachedKey, entry] of cache) {
      if (entry.expiresAt <= now) cache.delete(cachedKey);
    }
  }
  cache.set(key, { posts, expiresAt: Date.now() + CACHE_TTL_MS });
}

/* ---------------- Retry logic ---------------- */

interface RouteSuccess {
  ok: true;
  response: Response;
  text: string;
}
interface RouteFailure {
  ok: false;
  error: unknown;
}
type RouteResult = RouteSuccess | RouteFailure;

async function attemptRoute(url: string, subreddit: string, deadline: number): Promise<RouteResult> {
  let lastError: unknown = new RedditApiError(
    `Could not reach the Reddit proxy for r/${subreddit} after multiple attempts. ${proxyTip(subreddit)}`
  );

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (Date.now() >= deadline) break;

    const remaining = deadline - Date.now();
    const timeoutMs = Math.min(ATTEMPT_TIMEOUT_MS, remaining);

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        cache: "no-store",
        headers: { accept: "application/json" },
      });

      // 429 retry
      if (response.status === 429) {
        const text = await response.text();
        const detail = parseErrorDetail(text);
        lastError = new RedditApiError(detail ?? messageForStatus(subreddit, 429), 429);

        if (attempt < MAX_ATTEMPTS) {
          const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after")) ?? 1_500;
          await delay(Math.min(retryAfterMs, Math.max(deadline - Date.now(), 0)));
        }
        continue;
      }

      // 5xx retry
      if (response.status >= 500 && response.status < 600) {
        const text = await response.text();
        const detail = parseErrorDetail(text);
        lastError = new RedditApiError(detail ?? messageForStatus(subreddit, response.status), response.status);

        if (attempt < MAX_ATTEMPTS) await delay(backoffMs(attempt));
        continue;
      }

      // other errors: don't retry
      if (!response.ok) {
        const text = await response.text();
        const detail = parseErrorDetail(text);
        const contentType = response.headers.get("content-type") ?? "";

        let message = detail ?? messageForStatus(subreddit, response.status);
        if (!detail && contentType && !isJsonContentType(contentType)) {
          message =
            `The API endpoint returned HTTP ${response.status} with a non-JSON response — ` +
            `the serverless proxy may not be running. ${proxyTip(subreddit)}`;
        }

        return { ok: false, error: new RedditApiError(message, response.status) };
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType && !isJsonContentType(contentType)) {
        return {
          ok: false,
          error: new RedditApiError(
            `The API returned a non-JSON response for r/${subreddit} (content-type: ${
              contentType || "none"
            }). ${proxyTip(subreddit)}`
          ),
        };
      }

      const text = await response.text();
      return { ok: true, response, text };
    } catch (error) {
      if (isAbortError(error)) {
        lastError = new RedditApiError(
          `Reddit is not responding — the request timed out after multiple attempts. ${proxyTip(subreddit)}`
        );
      } else {
        lastError = error;
      }

      if (attempt < MAX_ATTEMPTS) await delay(backoffMs(attempt));
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  return { ok: false, error: lastError };
}

function parseListingBody(response: Response, text: string, subreddit: string): RedditListingResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const contentType = response.headers.get("content-type") ?? "none";
    throw new RedditApiError(
      `The API returned invalid JSON for r/${subreddit} (HTTP ${response.status}, content-type: ${contentType}). ` +
        `Body preview: ${JSON.stringify(text.slice(0, 200))}. ${proxyTip(subreddit)}`
    );
  }

  const json = parsed as RedditListingResponse;
  if (!Array.isArray(json?.data?.children)) {
    throw new RedditApiError(
      `The Reddit proxy returned an unexpected response format for r/${subreddit}. ${proxyTip(subreddit)}`
    );
  }
  return json;
}

async function fetchListing(subreddit: string): Promise<RedditListingResponse> {
  const result = await attemptRoute(buildEndpoint(subreddit), subreddit, Date.now() + TOTAL_BUDGET_MS);
  if (!result.ok) throw result.error;
  return parseListingBody(result.response, result.text, subreddit);
}

export async function fetchHotPosts(rawInput: string): Promise<RedditPostData[]> {
  const subreddit = cleanSubredditInput(rawInput);
  validateSubreddit(subreddit);

  const cached = readCache(subreddit);
  if (cached) return cached;

  const json = await fetchListing(subreddit);

  const posts = (json?.data?.children ?? [])
    .map((child) => child.data)
    .filter((post) => post && typeof post.title === "string");

  if (posts.length === 0) {
    throw new RedditApiError(`r/${subreddit} has no hot posts right now. Try another subreddit.`);
  }

  const result = posts.slice(0, POST_LIMIT);
  writeCache(subreddit, result);
  return result;
}