<div align="center">

<img src="docs/assets/demo.gif" alt="SEO OS demo: signing in, the portfolio dashboard, a site overview, the technical audit, keywords, internal links, GEO readiness, content opportunities and the approval queue" width="960">

# SEO OS

**A self-hosted, AI-assisted SEO + GEO operating system that audits your sites, finds what to fix, ships the changes you approve, and measures whether they worked.**

[![CI](https://github.com/Ale-Newport/SEOboost/actions/workflows/ci.yml/badge.svg)](https://github.com/Ale-Newport/SEOboost/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Ale-Newport/SEOboost/actions/workflows/codeql.yml/badge.svg)](https://github.com/Ale-Newport/SEOboost/actions/workflows/codeql.yml)
[![Security](https://github.com/Ale-Newport/SEOboost/actions/workflows/security.yml/badge.svg)](https://github.com/Ale-Newport/SEOboost/actions/workflows/security.yml)
[![Release](https://img.shields.io/github/v/release/Ale-Newport/SEOboost?sort=semver)](https://github.com/Ale-Newport/SEOboost/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
<br>
[![Node.js](https://img.shields.io/badge/node-%E2%89%A520.11-339933?logo=node.js&logoColor=white)](.nvmrc)
[![Next.js 15](https://img.shields.io/badge/Next.js-15-000000?logo=nextdotjs)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](tsconfig.base.json)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15%2B-4169E1?logo=postgresql&logoColor=white)](docker-compose.yml)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[Quick start](#quick-start) · [Screenshots](#screenshots) · [Features](#what-it-does) · [Architecture](#architecture) · [Docs](SETUP.md) · [Contributing](CONTRIBUTING.md)

</div>

---

SEO OS manages a portfolio of websites from one place. It crawls them, imports Search Console
data, audits them against 61 technical rules, finds keyword and content opportunities, suggests
internal links, scores how readable each page is to answer engines (GEO), tracks whether AI
assistants mention your brand, proposes prioritised actions, applies the ones you approve to your
CMS — and then **runs an experiment on every change** to tell you whether it helped.

It is built for one person or a small team running several sites, self-hosted on your own
infrastructure, with your own API keys. Every number it shows comes from a real source; the only
synthetic data is the clearly labelled `[DEMO]` dataset.

## Why it is different

- **Deterministic first, LLM second.** Rules, scores and decisions are plain TypeScript with
  published weights. Models write, classify and synthesise — behind structured output schemas — so
  a model failure degrades a feature instead of corrupting data.
- **Every score is explainable.** No bare numbers: each score carries its factors, weights and a
  sentence explaining each contribution, and the UI shows them.
- **Nothing ships without you.** Five autonomy levels, a hard guardrail on risky actions and an
  approval queue with diffs. Social replies in other people's communities always need approval.
- **It closes the loop.** Applied changes open experiments (Welch's t-test, settling window,
  effect-size floor) and the results re-weight what it recommends next.

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="docs/assets/screenshots/dashboard.png" alt="Portfolio dashboard with clicks, impressions, position, health and pending approvals across three sites"><br><sub><b>Portfolio dashboard</b> — every site, every metric, last 28 days</sub></td>
    <td width="50%"><img src="docs/assets/screenshots/site-overview.png" alt="Site overview with health, GEO and AI visibility scores, next actions and content opportunities"><br><sub><b>Site overview</b> — health, GEO and AI-visibility scores with ranked next actions</sub></td>
  </tr>
  <tr>
    <td><img src="docs/assets/screenshots/technical-audit.png" alt="Technical SEO audit with a weighted health score broken down by category"><br><sub><b>Technical audit</b> — 61 rules, weighted and explained</sub></td>
    <td><img src="docs/assets/screenshots/keywords.png" alt="Keyword table with positions, changes, clicks, impressions, CTR and opportunity scores"><br><sub><b>Keywords</b> — striking distance, CTR gaps, clusters and opportunity scores</sub></td>
  </tr>
  <tr>
    <td><img src="docs/assets/screenshots/geo-readiness.png" alt="GEO readiness score across eleven machine-readability dimensions"><br><sub><b>GEO readiness</b> — eleven machine-readability dimensions</sub></td>
    <td><img src="docs/assets/screenshots/approvals.png" alt="Approval queue grouped by risk with the agent's reasoning for each change"><br><sub><b>Approvals</b> — every proposed change, grouped by risk, with the reasoning</sub></td>
  </tr>
</table>

<sub>Screenshots and the GIF above are from a real local install running the built-in, clearly labelled demo dataset (`npm run db:seed -- --demo`).</sub>

## Quick start

**Prerequisites:** Node 20.11+ (22 recommended), PostgreSQL 15+, Redis 7+ — or just Docker.

### One command (Node)

```bash
git clone https://github.com/Ale-Newport/SEOboost.git && cd SEOboost && ./scripts/setup.sh && npm run dev
```

`setup.sh` writes a `.env` with freshly generated secrets, installs dependencies and applies the
migrations. No Postgres/Redis yet? Run `docker compose up -d postgres redis` (or
`./scripts/dev-services.sh` with Homebrew) first.

Open <http://localhost:3000>, sign up (the first account owns the installation), and the
onboarding wizard walks you through adding a site, connecting Search Console, choosing an AI
provider and starting the first crawl.

### Docker

```bash
git clone https://github.com/Ale-Newport/SEOboost.git && cd SEOboost
cp .env.example .env   # then set AUTH_SECRET (openssl rand -base64 48) and ENCRYPTION_KEY (openssl rand -base64 32)
docker compose up -d && docker compose exec web npm run db:migrate
```

### Explore with demo data

There is no public hosted demo — SEO OS stores credentials for your accounts, so it is meant to run
on infrastructure you control. To explore it without connecting anything, sign up locally and load
the labelled demo dataset (three fictional `[DEMO]` sites with crawls, Search Console history,
keywords, actions and a measured experiment):

```bash
npm run db:seed -- --demo        # remove it later with: npm run db:seed -- --clear-demo
```

## What it does

| | |
|---|---|
| **Crawls** | Real crawler: robots.txt, sitemaps, redirects, canonical handling, crawl-trap detection, optional JS rendering, rate limiting, cancellation, progress. |
| **Audits** | 61 technical rules across crawlability, indexability, metadata, content, links, architecture, structured data, security and internationalisation — each with severity, rationale, evidence and a recommendation. |
| **Search Console** | Real OAuth integration. Daily totals, query × page rows, countries, devices, 16-month backfill. Bing Webmaster Tools and GA4 as separate, optional sources. |
| **Keywords** | Striking-distance detection, CTR gaps against a published click curve, content decay (ranking loss vs demand loss vs SERP change), cannibalisation, clustering, and an explainable 0-100 opportunity score. |
| **Content** | A decision engine that refuses to create a page when an existing one should be improved instead, then a 14-stage pipeline from research to publication with fact-checking and hallucination safeguards. |
| **Internal links** | PageRank over your link graph, orphan detection, natural-placement anchor suggestions, and anchor over-optimisation auditing. |
| **GEO** | Eleven measurable dimensions of machine readability, scored per page and per site, with entity graph extraction and structured-data generation. |
| **AI visibility** | Tracks whether assistants mention and cite you, through official provider APIs — with a manual import path for those that cannot be queried. |
| **Social** | Listens on Reddit, Hacker News, Bluesky and — through [agent-reach](https://github.com/Panniantong/agent-reach) — X, YouTube, GitHub and more for people describing the problem a site solves; scores each thread, reads the community's own rules, drafts a helpful, disclosed reply for you to approve, and plans daily posts for the accounts you own (Reddit, Bluesky, Mastodon, X, LinkedIn, Dev.to, Telegram, Discord), with engagement read back. |
| **Mail & accounts** | Read, reply and send email from your own mailboxes (Gmail via app password, Outlook, iCloud, Yahoo, any IMAP/SMTP) and use your linked GitHub and Reddit accounts — repos, issues, notifications, inbox, posts — from inside the app. |
| **Automation** | Five autonomy levels, a hard guardrail on risky actions, an approval queue with diffs, CMS adapters (WordPress, Git/GitHub, webhook, Shopify, Webflow), and a full change log with rollback data. |
| **Learning** | Every applied change opens an experiment. Welch's t-test over daily series, a settling window and an effect-size floor produce *likely positive / inconclusive / likely negative* — never a causal claim — and the results adjust future prioritisation. |

Everything above works from real data. There is no fabricated analytics anywhere; the only
synthetic rows in the system come from `DEMO_MODE=true`, and they are labelled as such.

## Architecture

```mermaid
flowchart LR
  subgraph Sources
    S1[Your websites]:::src
    S2[Search Console · GA4 · Bing]:::src
    S3[SERP & backlink providers]:::src
  end
  subgraph Worker["apps/worker (BullMQ)"]
    C[Crawler]
    E[SEO engine<br/>deterministic rules & scores]
    A[Agents<br/>scoped LLM reasoning]
    M[Measurement<br/>experiments]
  end
  subgraph Web["apps/web (Next.js 15)"]
    UI[Dashboard & approval queue]
  end
  DB[(PostgreSQL)]
  Q[(Redis)]
  CMS[CMS adapters<br/>WordPress · Git · Shopify · Webflow · webhook]

  S1 --> C --> E
  S2 --> E
  S3 --> E
  E --> A --> UI
  UI -- approved actions --> CMS --> S1
  CMS --> M --> E
  Worker <--> Q
  Worker <--> DB
  Web <--> DB
  Web --> Q
```

```
apps/web      Next.js 15 App Router — UI, API routes, server queries, auth
apps/worker   BullMQ workers + scheduler — crawling, syncing, agents, actions, measurement
packages/     shared · db · ai · crawler · seo-engine · integrations · agents · queue
```

`packages/seo-engine` is pure computation with no database or network access, which is why it
carries the bulk of the test suite. Read [ARCHITECTURE.md](ARCHITECTURE.md) for the full picture
and [`docs/adr/`](docs/adr) for the decisions behind it.

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
| Sign in with ChatGPT (Settings → AI) or `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_AI_API_KEY` | Agents, content, GEO recommendations, AI visibility — the ChatGPT option uses your Plus/Pro plan instead of an API key | Deterministic audits, scoring, links and GEO scoring still work |
| `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` | Search Console + GA4 | Traffic panels show empty states |
| `BING_API_KEY` | Bing data and URL submission | Bing panels marked not configured |
| `DATAFORSEO_*` / `SERPAPI_KEY` / `SERPER_API_KEY` | Search volume, difficulty, SERP snapshots, competitor discovery | Keyword data comes from Search Console; scores say so explicitly |
| `AHREFS_API_KEY` / `SEMRUSH_API_KEY` / `MOZ_*` | Live backlink data | CSV import still works |
| `AGENT_REACH_BIN` (agent-reach installed) | Listening on X, YouTube, GitHub, Instagram, Facebook, V2EX | Reddit, Hacker News and Bluesky are still read natively |

**Never change `ENCRYPTION_KEY` after connecting an integration** — stored credentials become
unreadable and must be reconnected.

See [`.env.example`](.env.example) for the annotated full list and [SETUP.md](SETUP.md) for
step-by-step instructions on obtaining each credential.

## Commands

```bash
npm run dev            # web + worker
npm run dev:web        # Next.js only            → http://localhost:3000
npm run dev:worker     # background worker only

npm run db:migrate     # apply migrations
npm run db:migrate:dev # create a new migration after editing the schema
npm run db:studio      # Prisma Studio
npm run db:seed        # global defaults; add -- --demo for the labelled demo dataset

npm run lint           # ESLint
npm run typecheck      # strict TypeScript across the apps (typecheck:packages for the libraries)
npm test               # 600+ unit and integration tests (Vitest)
npm run test:e2e       # Playwright end-to-end flows
npm run build          # production build
npm run verify         # generate + typecheck + test + build
```

## Security

SEO OS holds credentials for your Search Console, CMS, mail and social accounts, so it is built
defensively: AES-256-GCM encryption at rest, database-backed httpOnly sessions with CSRF checks,
ownership checks on every route, an SSRF guard on every fetch of a user-supplied URL, same-origin
redirect enforcement, and unprivileged containers. The repository runs CodeQL, gitleaks, Dependabot
and dependency review on every change.

Found a vulnerability? Please report it privately — see [SECURITY.md](SECURITY.md).

## What it deliberately does not do

No mass backlink building, spam comments, fake reviews, cloaking, hidden text, doorway pages,
fake traffic or engagement, parasite SEO, scaled low-quality page generation, scraping behind
logins, automated spam outreach, fabricated authors, fake citations or invented credentials.

Four concrete consequences you will see in the code:

- The content decision engine returns `NO_ACTION` or `IMPROVE_EXISTING_PAGE` far more often than
  it proposes a new page.
- FAQ, Review and AggregateRating schema is only generated from content that is genuinely on the
  page; the generator refuses and tells you why when it is not.
- The fact-check stage marks unverifiable claims for review instead of inventing a source.
- Social replies in other people's communities are never posted without your approval, at any
  autonomy level. Every reply that names the product must disclose the affiliation, one reply per
  thread, a few per day, none where the community's rules forbid promotion, no sock puppets and no
  browser automation — publishing uses official APIs and your own accounts only.

## Contributing

Contributions are welcome — bug reports, docs, rules, integrations. Start with
[CONTRIBUTING.md](CONTRIBUTING.md) and the
[`good first issue`](https://github.com/Ale-Newport/SEOboost/labels/good%20first%20issue) label.
Questions and ideas go to [Discussions](https://github.com/Ale-Newport/SEOboost/discussions).
Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) © 2026 Alejandro Newport Diaz
