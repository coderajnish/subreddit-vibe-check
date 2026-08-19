/**
 * Reddit API layer — the browser never calls reddit.com directly.
 *
 * All fetching goes through the serverless proxy
 * /api/reddit?subreddit=...&limit=50 (implemented by api/reddit.ts).
 *
 * The proxy origin defaults to the same origin (empty base), but can be
 * overridden with VITE_API_BASE (e.g. "https://my-app.vercel.app") so the
 * app can run locally with `npm run dev` while using the deployed proxy —
 * essential when the local network blocks reddit.com.
 *
 *  - 30 s timeout per attempt via AbortController, bounded by a 95 s global
 *    budget so the UI always resolves with a clear error instead of hanging
 *  - Up to 3 attempts with exponential backoff + jitter
 *  - HTTP 429: honors the Retry-After header when present, waits, retries
 *  - HTTP 5xx: retried automatically
 *  - Content-type must be JSON-like: application/json, text/javascript, or
 *    any type containing "json" (Reddit sometimes responds with
 *    text/javascript)
 *  - Bodies are read as text and JSON.parse'd in a try/catch; parse failures
 *    produce a clear error with the HTTP status, content-type, and a 200-char
 *    body preview
 *  - In-memory cache (60 s TTL) keyed by subreddit + limit, so repeated
 *    clicks on the same subreddit don't re-hit the proxy or Reddit
 *  - A clear error is only thrown after every attempt is exhausted
 */

import type { RedditListingResponse, RedditPostData } from "../types/reddit";

const POST_LIMIT = 50;
const ATTEMPT_TIMEOUT_MS = 30_000;
const TOTAL_BUDGET_MS = 95_000;
const MAX_ATTEMPTS = 3;
const CACHE_TTL_MS = 60_000;
const VALID_SUBREDDIT_RE = /^[a-z0-9_]{2,21}$/;

/**
 * Base URL of the serverless proxy. Empty by default (same origin);
 * set VITE_API_BASE=https://<your-app>.vercel.app to use a deployed proxy
 * while developing locally. Trailing slashes are stripped.
 */
const API_BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");

/** Same-origin (or VITE_API_BASE-relative) serverless proxy endpoint. */
function buildEndpoint(subreddit: string): string {
  return `${API_BASE}/api/reddit?subreddit=${encodeURIComponent(subreddit)}&limit=${POST_LIMIT}`;
}

/** Debug tip appended to connectivity errors so the proxy is easy to verify. */
function proxyTip(subreddit: string): string {
  const base = API_BASE || "your deployed app";
  return `If you're running locally, open ${base}/api/reddit?subreddit=${subreddit}&limit=1 in your browser to verify the serverless proxy.`;
}

/**
 * True for application/json, text/javascript, or any content-type containing
 * the substring "json" (e.g. "application/json; charset=utf-8"). Reddit
 * sometimes serves JSON as text/javascript, so we must not require an exact
 * application/json match.
 */
function isJsonContentType(contentType: string): boolean {
  return contentType.includes("json") || contentType.includes("javascript");
}

/** Typed error carrying an optional HTTP status so the UI can tailor messages. */
export class RedditApiError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "RedditApiError";
    this.status = status;
  }
}

/** "  r/NBA/ " -> "nba". Strips whitespace, leading "r/", and trailing slashes. */
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
  return error instanceof DOMException && error.name === "AbortError";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Exponential backoff with jitter: 1s, 2s, 4s, capped at 8s. */
function backoffMs(attempt: number): number {
  const base = Math.min(1_000 * 2 ** (attempt - 1), 8_000);
  return base + Math.floor(Math.random() * 400);
}

/** Parses a Retry-After header (seconds) into ms; null if absent/invalid (HTTP-date). */
function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, 10_000); // cap at 10 s
}

/** Reads a JSON { error: string } body from error-response text, if present. */
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
  // Keep the cache bounded: prune expired entries before adding a new one.
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
  /** Raw body text, read exactly once, ready for JSON.parse. */
  text: string;
}

interface RouteFailure {
  ok: false;
  error: unknown;
}

type RouteResult = RouteSuccess | RouteFailure;

/**
 * Tries the serverless proxy endpoint up to MAX_ATTEMPTS times.
 * Retries on 429 (honoring Retry-After), 5xx, timeouts, and transport errors.
 * Non-retryable 4xx errors (404, 403, …) and non-JSON responses are returned
 * immediately with a clear error.
 */
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

      // HTTP 429 — rate limited (status passed through from Reddit).
      // Honor Retry-After if present, then retry.
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

      // HTTP 5xx — transient upstream/proxy errors, retry with backoff.
      if (response.status >= 500 && response.status < 600) {
        const text = await response.text();
        const detail = parseErrorDetail(text);
        lastError = new RedditApiError(
          detail ?? messageForStatus(subreddit, response.status),
          response.status
        );
        if (attempt < MAX_ATTEMPTS) {
          await delay(backoffMs(attempt));
        }
        continue;
      }

      // Other non-OK statuses (404, 403, …) are definitive — don't retry.
      if (!response.ok) {
        const text = await response.text();
        const detail = parseErrorDetail(text);
        const contentType = response.headers.get("content-type") ?? "";
        let message = detail ?? messageForStatus(subreddit, response.status);
        if (!detail && !isJsonContentType(contentType)) {
          // e.g. the serverless function isn't deployed and the host
          // returned its own HTML error page.
          message = `The API endpoint returned HTTP ${response.status} with a non-JSON response — the serverless proxy (api/reddit.ts) may not be deployed. ${proxyTip(subreddit)}`;
        }
        return { ok: false, error: new RedditApiError(message, response.status) };
      }

      // The response must be JSON-like; an HTML error page isn't.
      const contentType = response.headers.get("content-type") ?? "";
      if (!isJsonContentType(contentType)) {
        return {
          ok: false,
          error: new RedditApiError(
            `The API returned a non-JSON response for r/${subreddit} (content-type: ${
              contentType || "none"
            }). The serverless proxy may not be deployed. ${proxyTip(subreddit)}`
          ),
        };
      }

      // Read the body exactly once, as text — JSON.parse happens later in
      // parseListingBody so failures can include a body preview.
      const text = await response.text();
      return { ok: true, response, text };
    } catch (error) {
      if (isAbortError(error)) {
        lastError = new RedditApiError(
          `Reddit is not responding — the request timed out after multiple attempts. ${proxyTip(subreddit)}`
        );
      } else {
        lastError = error; // transport / CORS failure
      }
      if (attempt < MAX_ATTEMPTS) {
        await delay(backoffMs(attempt));
      }
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  return { ok: false, error: lastError };
}

/**
 * Parses the response body text and validates the listing shape.
 * On parse failure, throws a clear error including the HTTP status,
 * content-type, and the first 200 characters of the body.
 */
function parseListingBody(response: Response, text: string, subreddit: string): RedditListingResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const contentType = response.headers.get("content-type") ?? "none";
    throw new RedditApiError(
      `The API returned invalid JSON for r/${subreddit} (HTTP ${response.status}, content-type: ${contentType}). Body preview: ${JSON.stringify(
        text.slice(0, 200)
      )}. ${proxyTip(subreddit)}`
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

/**
 * Fetches the listing through the serverless proxy.
 * A clear error is thrown only after all attempts are exhausted.
 */
async function fetchListing(subreddit: string): Promise<RedditListingResponse> {
  const result = await attemptRoute(
    buildEndpoint(subreddit),
    subreddit,
    Date.now() + TOTAL_BUDGET_MS
  );

  if (!result.ok) throw result.error;

  return parseListingBody(result.response, result.text, subreddit);
}

/**
 * Fetches and parses the top 50 HOT posts from a subreddit.
 * Results are cached in memory for 60 seconds (keyed by subreddit + limit).
 * Throws RedditApiError with a human-readable message only after all retries.
 */
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
