# The Subreddit Vibe Check 🎭

A small, production-ready React app that takes a subreddit name, fetches its **top 50 HOT posts**
through a **serverless proxy**, and runs **client-side sentiment analysis** on every post title
using the [`sentiment`](https://www.npmjs.com/package/sentiment) npm package.

No OAuth. No user accounts. No backend to operate — just a single Vercel Serverless Function.

## Why a serverless proxy?

The browser **never calls reddit.com directly**. Local networks and corporate firewalls often
block reddit.com, and browser CORS makes direct calls unreliable. Instead:

```
Browser ── GET /api/reddit?subreddit=nba&limit=50 (same origin) ──▶ Vercel Serverless Function
                                                                        │ fetch (cloud-side)
                                                                        ▼
                                                              https://www.reddit.com/r/nba/hot.json
```

- **Production**: the function runs in Vercel's cloud, so the upstream request originates from
  Vercel's servers — a blocked local network cannot break the app.
- **Local development**: `vercel dev` runs the same function locally alongside the Vite app.
- The previous Vite dev-server proxy approach was removed: proxying through the developer's
  machine still originates from the blocked network, so it couldn't help.

## Features

- 🔎 Subreddit input with defensive cleanup (accepts `nba`, `r/nba`, `r/nba/`, ` NBA `)
- ⚡ Preset chips: `nba`, `soccer`, `technology`, `news`, `wallstreetbets`, `AskReddit`
- 📊 Summary cards: **average sentiment score** + counts of **positive / neutral / negative**
  posts (with percentages)
- 📰 List of all 50 posts with title → Reddit permalink, author, upvotes, comment count,
  sentiment label + score badge, and row backgrounds tinted by sentiment
- 🛡️ Resilient fetching: 30 s per-attempt timeout, up to 3 retries with exponential backoff,
  HTTP 429 honors `Retry-After`, 5xx retried automatically, 60 s in-memory result cache
- ♿ Loading spinner, error banner with a proxy-verification debug tip, and an empty state

## Tech stack

| Layer    | Choice                                              |
| -------- | --------------------------------------------------- |
| Build    | [Vite](https://vitejs.dev)                          |
| UI       | React 19 (hooks: `useState`, `useCallback`, `useMemo`) |
| Language | TypeScript (strict mode)                            |
| Analysis | [`sentiment`](https://www.npmjs.com/package/sentiment) (pure client-side AFINN-style lexicon) |
| Styling  | Plain CSS (`src/App.css`) — no Tailwind/MUI/Bootstrap |
| Data     | `/api/reddit?subreddit=...&limit=50` → Vercel Serverless Function → `https://www.reddit.com/r/{sub}/hot.json?limit={limit}&raw_json=1` |

## Project structure

```
├── api/
│   └── reddit.ts               # Vercel Serverless Function (Node) — Reddit JSON proxy
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── README.md
└── src/
    ├── main.tsx                # React entry point
    ├── App.tsx                 # State machine (idle/loading/success/error) + summary memo
    ├── App.css                 # All styles (design tokens, cards, rows, chips, responsive)
    ├── types/
    │   └── reddit.ts           # Typed Reddit API shapes, AnalyzedPost, SentimentSummary
    ├── api/
    │   └── reddit.ts           # Client fetch layer: retry/backoff/timeout/cache → /api/reddit
    ├── sentiment/
    │   └── analyze.ts          # analyzeTitle, labelForScore, overallVibe, thresholds
    └── components/
        ├── SearchForm.tsx      # Input + preset chips + "Check the vibe" button
        ├── SummaryCards.tsx    # Vibe banner + 4 summary cards
        └── PostsList.tsx       # Empty state + tinted post rows with badges
```

## The serverless proxy (`api/reddit.ts`)

`GET /api/reddit?subreddit=nba&limit=50`

| Behavior | Detail |
| -------- | ------ |
| Params   | `subreddit` (required, strips leading `r/`), `limit` (optional, default 50, clamped 1–100) |
| Upstream | `https://www.reddit.com/r/{sub}/hot.json?limit={limit}&raw_json=1` with `User-Agent: SubredditVibeCheck/1.0` and `Accept: application/json`, 20 s timeout |
| Validation | The upstream body is always checked with `JSON.parse` before forwarding. Valid JSON is re-serialized with `Content-Type: application/json; charset=utf-8` and Reddit's original status code (so 404/403/429 stay distinguishable). Non-JSON bodies (block pages, HTML errors) → `502` with `{ error, upstreamStatus, upstreamContentType, bodyPreview }` |
| Content-type | Reddit sometimes serves JSON as `text/javascript` instead of `application/json`. The serverless proxy re-serializes everything as `application/json`, and the client accepts `application/json`, `text/javascript`, or any content-type containing `json` |
| Caching  | `Cache-Control: s-maxage=30, stale-while-revalidate=60` (CDN-friendly) |
| CORS     | `Access-Control-Allow-Origin: *` on all responses, so the frontend can also call the deployed proxy cross-origin (see `VITE_API_BASE` below) |
| Errors   | Upstream/network failures → JSON `{ "error": string }` with status 500 |

## Getting started

Requires **Node.js 20.19+ or 22.12+** (Vite 7 requirement) and npm.

```bash
# 1. Install dependencies
npm install

# 2. Full local experience (Vite app + serverless function together)
npm i -g vercel
vercel dev            # serves the Vite app AND /api/reddit locally

# 3. UI-only dev server (the /api/reddit endpoint will 404 here)
npm run dev

# 4. Production build (outputs to dist/)
npm run build

# 5. Preview the production build
npm run preview
```

> **Note:** plain `npm run dev` serves only the frontend — the `/api/reddit` endpoint needs
> `vercel dev` (locally) or a deployment (in production).

### Using the deployed proxy while developing locally (`VITE_API_BASE`)

If your local network blocks reddit.com, the local serverless function won't help — its
upstream request still originates from your machine. Instead, point the dev frontend at your
**deployed** Vercel proxy, whose upstream request originates from Vercel's cloud:

```bash
# .env.local  (create this file in the project root — git-ignored by default)
VITE_API_BASE=https://<your-app>.vercel.app
```

Then start the app as usual:

```bash
npm run dev
```

The frontend now fetches `https://<your-app>.vercel.app/api/reddit?subreddit=...&limit=50`
instead of the same-origin path. Because the proxy sends `Access-Control-Allow-Origin: *`,
cross-origin calls from `localhost:5173` work without any extra configuration. Without
`VITE_API_BASE` set, the app falls back to the same-origin `/api/reddit` path.

## Deployment (Vercel)

The repo is pre-configured: Vercel auto-detects the Vite frontend (`dist/`) and the `api/`
directory (Serverless Functions). **No configuration files needed.**

**Option A — CLI:**

```bash
npm i -g vercel
npm install
vercel             # follow the prompts; framework preset: Vite
vercel --prod      # deploy to production
```

**Option B — Git import:** push the repo to GitHub, then "Add New Project" in the Vercel
dashboard and import it. Vercel runs `npm install` + `npm run build` and deploys both the
static site and the function.

After deploying, open
`https://<your-app>.vercel.app/api/reddit?subreddit=nba&limit=1` — if it returns Reddit JSON,
the proxy works, and the app will work on any network (even ones that block reddit.com).

**Other hosts:** any host that runs Vercel-style Node serverless functions (or a plain
Node server) can host `api/reddit.ts`; the frontend only requires that `/api/reddit` exists
on the same origin.

## How the sentiment analysis works

1. The app calls `/api/reddit?subreddit=nba&limit=50` (same-origin). The serverless function
   fetches Reddit's hot listing server-side and returns `json.data.children[].data`, parsed into
   strongly typed `RedditPostData` objects.
2. Every post title is run through `sentiment.analyze(title).score` (an integer).
3. Labels are derived from the raw score:

   | Score  | Label    |
   | ------ | -------- |
   | `>= 2` | positive |
   | `<= -2`| negative |
   | else   | neutral  |

4. The dashboard summarizes the 50 scores: average (rounded to 2 decimals), counts, and
   percentages, plus a friendly overall "vibe" (e.g. *r/nba is feeling mostly positive*).

## Error handling

| Situation              | UX                                                              |
| ---------------------- | --------------------------------------------------------------- |
| Empty input            | Friendly prompt, nothing fetched                                |
| Invalid name           | Validation message (letters, numbers, underscores, 2–21 chars)  |
| Nonexistent subreddit  | "`r/xyz` does not exist…" (Reddit's 404 passed through)         |
| Private/banned sub     | "…private, banned, or quarantined…" (Reddit's 403 passed through) |
| Rate limited           | 429 retried automatically, honors `Retry-After`, 60 s cache reduces repeat hits |
| Upstream/network error | Serverless function returns `{ error }` + 500; the client retries with backoff, then shows a clear message |
| Timeout               | 30 s per attempt, 3 attempts; error includes a debug tip: open `/api/reddit?subreddit=nba&limit=1` (or the `VITE_API_BASE` URL) to verify the proxy |
| Non-JSON content-type | `text/javascript` and any type containing `json` are accepted; other types are reported with the content-type so HTML error pages are easy to spot |
| Invalid JSON body     | Parse failures show HTTP status, content-type, and the first 200 chars of the body — instantly revealing HTML/JS error pages instead of JSON |
| Proxy not deployed     | Non-JSON/HTML error responses are detected and explained with the same debug tip |

## Notes & limitations

- Analysis is **titles only** — Reddit post bodies would require fetching each thread separately.
- The `sentiment` package uses a general English lexicon; sarcasm, memes, and jargon
  (especially in `wallstreetbets`) will skew results. That's part of the fun.
- The serverless function uses Node's built-in `fetch` (Node 18+) — no new dependencies were
  added for it; `@types/node` was already present for the Vite config.
- Vercel's free tier includes generous function invocations; the 60 s client cache plus the
  CDN `s-maxage=30` cache keep usage low.
