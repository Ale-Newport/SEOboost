# Setup

Step-by-step installation, credentials and troubleshooting.

---

## 1. Prerequisites

| | Version | Notes |
|---|---|---|
| Node.js | 20.11+ | 22 recommended |
| PostgreSQL | 15+ | 17 used in development |
| Redis | 7+ | Optional to boot, required for background jobs |
| Docker | any recent | Optional — `docker compose` provides Postgres, Redis, web and worker |

---

## 2. Install

### Option A — Docker

```bash
git clone <your-repo> seo-os && cd seo-os
cp .env.example .env
```

Fill in the two secrets:

```bash
openssl rand -base64 48   # → AUTH_SECRET
openssl rand -base64 32   # → ENCRYPTION_KEY
```

Then:

```bash
docker compose up -d
docker compose exec web npm run db:migrate
docker compose logs -f worker      # confirm the worker connected
```

### Option B — Local

```bash
git clone <your-repo> seo-os && cd seo-os
./scripts/setup.sh
```

The script creates `.env`, generates both secrets, installs dependencies, generates the Prisma
client and applies migrations. If Postgres or Redis are not running:

```bash
./scripts/dev-services.sh          # Homebrew
# or
docker compose up -d postgres redis
```

Then:

```bash
npm run dev
```

---

## 3. Create your account

Open <http://localhost:3000>. The first account created becomes the **owner**. After that, set
`ALLOW_SIGNUP=false` in `.env` and restart to lock the installation down to a single user.

---

## 4. Connect Google Search Console

Search Console is the single highest-value integration — most of the keyword, CTR and decay
analysis depends on it.

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create (or select) a
   project.
2. **APIs & Services → Library** → enable **Google Search Console API**. Enable **Google
   Analytics Data API** too if you want GA4.
3. **APIs & Services → OAuth consent screen** → External → fill in the app name and your email.
   Add yourself as a **Test user** — you do not need to publish the app for personal use.
   Add these scopes:
   - `https://www.googleapis.com/auth/webmasters.readonly`
   - `https://www.googleapis.com/auth/webmasters` (only if you want sitemap submission)
   - `https://www.googleapis.com/auth/analytics.readonly` (only for GA4)
4. **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application.**
   Add this **Authorised redirect URI**, exactly:

   ```
   http://localhost:3000/api/integrations/google/callback
   ```

   In production use your real origin, e.g. `https://seo.example.com/api/integrations/google/callback`.
5. Copy the client ID and secret into `.env`:

   ```bash
   GOOGLE_CLIENT_ID="…apps.googleusercontent.com"
   GOOGLE_CLIENT_SECRET="…"
   GOOGLE_REDIRECT_URI="http://localhost:3000/api/integrations/google/callback"
   ```
6. Restart, then in the app: **Site → Settings → Integrations → Connect Google**, pick the
   property, and run the first sync. Backfill up to 16 months from the same screen.

**Troubleshooting**

| Symptom | Cause |
|---|---|
| `redirect_uri_mismatch` | The URI in Google Cloud must match `GOOGLE_REDIRECT_URI` character for character, including the scheme and any trailing path. |
| `access_denied` | Your Google account is not on the OAuth consent screen's test-user list. |
| Property missing from the list | The Google account you authorised does not have access to that Search Console property. |
| Data stops ~3 days ago | Expected. Search Console lags 2-3 days; the default windows end there so the last day is never partial. |

---

## 5. Configure an AI provider

At least one enables the agents, content pipeline, GEO recommendations and AI visibility. Without
one, crawling, the technical audit, scoring, internal-link suggestions and GEO scoring all still
work — the agents that need reasoning report themselves as skipped and say why.

```bash
ANTHROPIC_API_KEY="sk-ant-…"      # console.anthropic.com
OPENAI_API_KEY="sk-…"             # platform.openai.com
GOOGLE_AI_API_KEY="…"             # aistudio.google.com
DEFAULT_AI_PROVIDER="anthropic"   # optional; otherwise the first configured one wins
AI_MONTHLY_BUDGET_USD="50"        # optional hard ceiling across all sites
```

Model routing is per role (reasoning / fast / writing / embedding) and can be overridden per site
in **Site → Settings → AI**. Spend is tracked per provider, model, task and site under
**Settings → AI usage**, and a runaway agent loop is stopped by the budget guard.

> Anthropic does not offer an embedding model. If you only configure Anthropic, semantic features
> fall back to lexical similarity — which works, just less precisely. Add an OpenAI or Gemini key
> to enable embeddings.

---

## 6. Optional integrations

### Bing Webmaster Tools
Bing Webmaster Tools → **Settings → API access → API key**. Set `BING_API_KEY`. Adds Bing query
and traffic data (stored alongside Search Console with `source: 'bing'`), crawl issues, and URL
and sitemap submission.

### SERP data
Any one of DataForSEO, SerpApi or Serper enables search volume, keyword difficulty, SERP
snapshots, People Also Ask and automatic competitor discovery.

```bash
DATAFORSEO_LOGIN=""   DATAFORSEO_PASSWORD=""
SERPAPI_KEY=""
SERPER_API_KEY=""
```

Without one, keyword data comes from Search Console alone and the opportunity score's competition
factor falls back to a neutral value and says so in its explanation.

### Backlinks
Set `AHREFS_API_KEY`, `SEMRUSH_API_KEY` or `MOZ_ACCESS_ID`/`MOZ_SECRET_KEY`, or just import a CSV
export from any tool at **Site → Backlinks → Import**. The importer auto-detects the common
Ahrefs, Semrush and Majestic column layouts.

### Publishing changes back to your sites

| Adapter | Credentials | Setup |
|---|---|---|
| **WordPress** | Site URL, username, application password | WordPress → Users → Profile → Application Passwords. Yoast and Rank Math meta fields are detected automatically. |
| **Git / GitHub** | Personal access token with `repo`, plus owner/repo/branch/content path | Best for static sites. Commits to a `seo-os/*` branch and opens a pull request by default — it never force-pushes and never deletes files. |
| **Webhook** | Endpoint URL + shared secret | Receives HMAC-SHA256 signed change requests. Reference verification code ships in `packages/integrations/src/adapters/webhook.ts`. |
| **Shopify / Webflow** | Admin API token | Partial support; each adapter declares its real capabilities rather than failing at apply time. |

---

## 7. JS rendering (optional)

Most sites crawl fine over plain HTTP, which is far faster. For client-rendered sites:

```bash
npx playwright install chromium
```

then set `ENABLE_JS_RENDERING=true`, or enable it per site in **Site → Settings → Crawler**. If the
browser is not installed, rendering reports itself as unavailable and HTTP crawling continues —
nothing breaks.

---

## 8. Production

```bash
npm run verify        # generate + typecheck + test + build — run this before deploying
```

Deploy the web app and the worker as **two processes sharing one database and one Redis**:

```bash
npm run db:migrate
npm run start          # web
npm run start:worker   # worker
```

Set `NODE_ENV=production`, a real `APP_URL` (used to build the OAuth redirect and to validate
CSRF origins), and `ALLOW_SIGNUP=false`.

| Target | Notes |
|---|---|
| **VPS + Docker Compose** | The simplest option and what `docker-compose.yml` is written for. Put Caddy or nginx in front for TLS. |
| **Railway / Render / Fly.io** | Two services from the same repo (`target: web`, `target: worker`) plus managed Postgres and Redis. |
| **AWS** | ECS/Fargate for both services, RDS Postgres, ElastiCache Redis. |
| **Vercel** | Works for the web app, but it cannot run the worker — pair it with a worker on Railway, Fly or a small VPS. Long crawls exceed serverless limits by design. |

Back up Postgres regularly, and store `ENCRYPTION_KEY` in your secret manager. Losing it means
re-connecting every integration.

---

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| `Missing required environment variable DATABASE_URL` | `.env` is missing or not loaded. `cp .env.example .env` and fill it in. |
| Jobs stay QUEUED forever | The worker is not running, or `REDIS_URL` is wrong. Check `npm run dev:worker`, then **Jobs → Queue health**. |
| `Malformed encrypted payload` | `ENCRYPTION_KEY` changed after credentials were stored. Reconnect the affected integrations. |
| Crawl finds only the homepage | The site blocks the crawler, or robots.txt disallows it. Check the crawl's skipped URLs list, then adjust the user agent or disable "respect robots.txt" for your own site. |
| Crawl is very slow | Lower concurrency and raise the delay in **Site → Settings → Crawler**, or turn off JS rendering. |
| `AI_BUDGET_EXCEEDED` | The monthly cap was hit. Raise it in **Settings → AI**, or per site in **Site → Settings**. |
| Prisma "engine not found" in Docker | Rebuild without cache: `docker compose build --no-cache`. |
| Migration fails with a drift error | `npm run db:reset` **destroys all data** — only for development. |

Structured JSON logs go to stdout. Set `LOG_LEVEL=debug` for detail; secrets are redacted
automatically by key name.
