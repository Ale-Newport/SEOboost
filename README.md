# SEO OS

An AI-powered SEO + GEO operating system for managing a portfolio of websites from one place.

It crawls your sites, imports your Search Console data, audits them against ~60 technical rules,
finds keyword and content opportunities, suggests internal links, generates structured data,
scores how readable your site is to answer engines, tracks whether AI assistants mention your
brand, proposes prioritised actions, applies the approved ones to your CMS, and then **measures
whether they worked** and feeds that back into what it recommends next.

It is built for one person running several sites, not for a SaaS funnel — but the data model is
shaped so it could become one.

---

## What it actually does

| | |
|---|---|
| **Crawls** | Real crawler: robots.txt, sitemaps, redirects, canonical handling, crawl-trap detection, optional JS rendering, rate limiting, cancellation, progress. |
| **Audits** | ~60 technical rules across crawlability, indexability, metadata, content, links, architecture, structured data, security and internationalisation — each with severity, rationale, evidence and a recommendation. |
| **Search Console** | Real OAuth integration. Daily totals, query × page rows, countries, devices, 16-month backfill. Bing Webmaster Tools and GA4 as separate, optional sources. |
| **Keywords** | Striking-distance detection, CTR gaps against a published click curve, content decay (ranking loss vs demand loss vs SERP change), cannibalisation, clustering, and an explainable 0-100 opportunity score. |
| **Content** | A decision engine that refuses to create a page when an existing one should be improved instead, then a 14-stage pipeline from research to publication with fact-checking and hallucination safeguards. |
| **Internal links** | PageRank over your link graph, orphan detection, natural-placement anchor suggestions, and anchor over-optimisation auditing. |
| **GEO** | Eleven measurable dimensions of machine readability, scored per page and per site, with entity graph extraction and structured-data generation. |
| **AI visibility** | Tracks whether assistants mention and cite you, through official provider APIs — with a manual import path for those that cannot be queried. |
| **Automation** | Five autonomy levels, a hard guardrail on risky actions, an approval queue with diffs, CMS adapters (WordPress, Git/GitHub, webhook, Shopify, Webflow), and a full change log with rollback data. |
| **Learning** | Every applied change opens an experiment. Welch's t-test over daily series, a settling window and an effect-size floor produce *likely positive / inconclusive / likely negative* — never a causal claim — and the results adjust future prioritisation. |

Everything above works from real data. There is no fabricated analytics anywhere; the only
synthetic rows in the system come from `DEMO_MODE=true`, and they are labelled as such.

---

## Quick start

### With Docker (recommended)

```bash
cp .env.example .env
# Set AUTH_SECRET and ENCRYPTION_KEY — generate with:
#   openssl rand -base64 48   (AUTH_SECRET)
#   openssl rand -base64 32   (ENCRYPTION_KEY)
docker compose up -d
docker compose exec web npm run db:migrate
```

Open <http://localhost:3000> and create your account.

### Without Docker

You need Node 20+, Postgres 15+ and Redis 7+.

```bash
./scripts/setup.sh     # generates .env secrets, installs deps, runs migrations
npm run dev            # web on :3000 + worker together
```

`scripts/dev-services.sh` starts Postgres and Redis via Homebrew if you do not have them running.

### First run

1. Sign up — the first account owns the installation.
2. The onboarding wizard walks you through adding a site, describing the business, adding
   competitors, connecting Search Console, choosing an AI provider, and starting the first crawl.
3. When the crawl finishes you get a technical audit, a health score and a first action plan.

---

## Configuration

Only three variables are required:

```bash
DATABASE_URL=postgresql://seo:seo@localhost:5432/seo_os?schema=public
AUTH_SECRET=          # openssl rand -base64 48
ENCRYPTION_KEY=       # openssl rand -base64 32 — encrypts integration credentials at rest
```

Everything else is optional and the product degrades honestly without it:

| Variable | Enables | Without it |
|---|---|---|
| `REDIS_URL` | Background jobs | Jobs queue but never run; the UI says so |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_AI_API_KEY` | Agents, content, GEO recommendations, AI visibility | Deterministic audits, scoring, links and GEO scoring still work |
| `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` | Search Console + GA4 | Traffic panels show empty states |
| `BING_API_KEY` | Bing data and URL submission | Bing panels marked not configured |
| `DATAFORSEO_*` / `SERPAPI_KEY` / `SERPER_API_KEY` | Search volume, difficulty, SERP snapshots, competitor discovery | Keyword data comes from Search Console; scores say so explicitly |
| `AHREFS_API_KEY` / `SEMRUSH_API_KEY` / `MOZ_*` | Live backlink data | CSV import still works |

**Never change `ENCRYPTION_KEY` after connecting an integration** — stored credentials become
unreadable and must be reconnected.

See `.env.example` for the annotated full list, and [SETUP.md](SETUP.md) for step-by-step
instructions on obtaining each credential.

---

## Commands

```bash
npm run dev            # web + worker
npm run dev:web        # Next.js only            → http://localhost:3000
npm run dev:worker     # background worker only

npm run db:migrate     # apply migrations
npm run db:migrate:dev # create a new migration after editing the schema
npm run db:studio      # Prisma Studio
npm run db:seed        # global defaults; add DEMO_MODE=true for labelled demo data
npm run db:seed -- --clear-demo

npm run typecheck      # strict TypeScript across every package and app
npm run test           # unit + integration tests (Vitest)
npm run test:e2e       # Playwright end-to-end flows
npm run build          # production build
npm run verify         # generate + typecheck + test + build
```

---

## How it is put together

```
apps/web      Next.js 15 App Router — UI, API routes, server queries, auth
apps/worker   BullMQ workers + scheduler — crawling, syncing, agents, actions, measurement
packages/     shared · db · ai · crawler · seo-engine · integrations · agents · queue
```

`packages/seo-engine` is pure computation with no database or network access, which is why it
carries the bulk of the test suite. Read [ARCHITECTURE.md](ARCHITECTURE.md) for the full picture
and `docs/adr/` for the decisions behind it.

---

## What this deliberately does not do

No mass backlink building, spam comments, fake reviews, cloaking, hidden text, doorway pages,
fake traffic or engagement, parasite SEO, scaled low-quality page generation, scraping behind
logins, automated spam outreach, fabricated authors, fake citations or invented credentials.

Three concrete consequences you will see in the code:

- The content decision engine returns `NO_ACTION` or `IMPROVE_EXISTING_PAGE` far more often than
  it proposes a new page.
- FAQ, Review and AggregateRating schema is only generated from content that is genuinely on the
  page; the generator refuses and tells you why when it is not.
- The fact-check stage marks unverifiable claims for review instead of inventing a source.

---

## Licence

Private. Built for a single operator's own portfolio.
