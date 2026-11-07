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

### Recommended: Sign in with ChatGPT (no API key)

**Settings → AI → Sign in with ChatGPT** connects your ChatGPT **Plus or Pro** plan through
OpenAI's official [Sign in with ChatGPT](https://developers.openai.com/siwc) flow for
self-hosted tools. Requests then run against your plan's allowance instead of a paid API key, and
ChatGPT becomes the default provider.

- Open the app at the address in `APP_URL` when you sign in: OpenAI only allows a loopback
  callback (`http://127.0.0.1:<port>/api/ai/chatgpt/callback`), which the app sets up for you.
- Usage counts against the weekly cap you choose for this app in ChatGPT under
  [Settings → Usage](https://chatgpt.com/settings/usage). When the cap is reached, AI tasks pause
  with a clear message instead of failing silently.
- Embeddings are not part of plan usage: semantic features fall back to lexical similarity unless
  an OpenAI or Gemini key is also set.
- Tokens are stored encrypted and refreshed automatically; if OpenAI revokes the connection, the
  card asks you to sign in again.

### API keys (alternative)

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

### Social listening and publishing

**Site → Social** finds public conversations about the problem a site solves, drafts helpful
replies for you to approve, and posts daily to accounts you own. Read
[ADR 0006](docs/adr/0006-social-outreach.md) for the rules it follows.

**Listening** works out of the box for Reddit (public JSON, or the API once a Reddit app is
connected), Hacker News (Algolia) and Bluesky. To also search X, YouTube, GitHub, Instagram,
Facebook and V2EX, install [agent-reach](https://github.com/Panniantong/agent-reach) on the
machine that runs the worker:

```bash
# Follow the project's own installer — the PyPI package called "agent-reach" is unrelated.
# https://raw.githubusercontent.com/Panniantong/Agent-Reach/main/docs/install.md
agent-reach version           # the Social page shows the same status
agent-reach add reddit        # login channels: reddit, twitter, …
agent-reach login reddit      # you log in yourself, in its own browser window
```

Without logging in, agent-reach already searches Reddit, YouTube, GitHub and V2EX through public
routes. X, Facebook and Instagram search need a login in agent-reach's own browser.

agent-reach is read-only and never logs in for you. Use a secondary account for its login
channels; platforms may restrict accounts used for automated reading. If the binary is not on the
worker's `PATH`, set `AGENT_REACH_BIN`.

**Publishing** only ever uses a platform's official API with an account you connect at
**Site → Social → Accounts**. Credentials are encrypted like every other integration. Each site
gets one brand account per network; **Social accounts** in the main navigation shows every site ×
network in one grid, so a portfolio of sites and accounts is managed from one screen.

**One-click connect (OAuth).** Mastodon, Reddit, X, LinkedIn and Discord connect with a single
"Connect" button: you approve on the network's own page and the app stores and refreshes the
tokens. Mastodon needs nothing else. Reddit, X, LinkedIn and Discord need a developer app
registered **once per installation** — the **One-time developer apps** card on the Accounts tab
links to each portal, shows the exact redirect URI to paste (`${APP_URL}/api/social/oauth/<network>/callback`,
so set `APP_URL` first) and stores the client id and secret encrypted. After that, every site and
every account is one click. Bluesky, Telegram and Dev.to have no OAuth for this, so their cards
link straight to the page where the app password, bot token or API key is created. Creating the
accounts themselves (sign-up, email verification) is always done by you on each network.

The table below is the manual "Use keys instead" path, still available on every card.

| Platform | What to create | Notes |
|---|---|---|
| **Reddit** | A *script* app at reddit.com/prefs/apps (client id + secret), plus the account's username and password | Replies and original posts. List the subreddits you own under "Communities you own" — posting anywhere else always needs approval. |
| **Bluesky** | An app password (Settings → Privacy and security → App passwords) | Never your account password. Posts, replies, metrics. |
| **Mastodon** | An access token with `write:statuses read:statuses` from your instance's Development settings | Posts, replies, metrics. |
| **X** | A developer app with OAuth 1.0a user tokens (API key/secret + access token/secret) | Posting needs at least X's free write tier; metrics need a paid tier and are skipped quietly otherwise. |
| **LinkedIn** | An access token with `w_member_social` (or `w_organization_social`) and your author URN | Original posts only. |
| **Dev.to** | An API key (Settings → Extensions) | Cross-posts articles with `canonical_url` pointing at your site. |
| **Telegram** | A bot token from @BotFather, added as an admin of your channel | Original posts only. |
| **Discord** | A channel webhook URL | Original posts only. |
| **Hacker News** | — | No posting API: approved items become "post by hand" with a prefilled submit link. |

Turn on **Settings → Automation** on the Social page to schedule listening every 4 hours, reply
drafting after each listen, daily post planning, a publisher sweep every 15 minutes and metrics
twice a day. Replies in other communities always wait for your approval; posts on your own
channels publish without approval only when the site runs at autonomy Level 4.

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
