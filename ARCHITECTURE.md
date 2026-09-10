# Architecture

SEO OS is a multi-site AI SEO/GEO operating system. This document explains how it is put
together, why the boundaries sit where they do, and where to add things.

---

## 1. The loop the system implements

Everything in the codebase exists to serve one cycle:

```
Websites → Crawl + Search Console + SERP data
        → SEO Intelligence Engine (deterministic)
        → Agents (deterministic gather → scoped LLM reasoning → deterministic act)
        → Prioritised actions
        → Human approval / guarded automation
        → Website changes via adapters
        → Measurement window
        → Experiment evaluation
        → Learned outcomes feed back into prioritisation
```

The two design commitments that follow from this:

1. **Determinism first.** Rules, scores and decisions are computed in plain TypeScript with
   published weights. The LLM is used where judgement genuinely helps — writing, classification,
   synthesis, strategy — and always behind a structured output schema. A model failure degrades
   the product; it never corrupts the data.
2. **Everything is explainable.** No score is a bare number. `ExplainableScore` carries the
   factors, their weights, their contributions and a sentence explaining each one, and the UI
   renders them.

---

## 2. Repository layout

```
apps/
  web/        Next.js 15 App Router — UI, API routes, server queries, auth
  worker/     BullMQ worker process + scheduler; where all long work happens
packages/
  shared/     env, logger, errors, url/text/math helpers, crypto, dates, constants, zod schemas
  db/         Prisma schema (54 tables), client singleton, helpers, seed
  ai/         Provider abstraction (OpenAI/Anthropic/Gemini), prompt registry, structured output,
              embeddings, cost tracking and budget guard
  crawler/    Fetcher, robots, sitemaps, HTML analysis, optional Playwright rendering, crawl engine
  seo-engine/ Technical rules, scoring, keyword intelligence, clustering, internal links,
              content decisions, GEO, structured data, entities, competitors, experiments, portfolio
  integrations/ Google (Search Console, GA4, OAuth), Bing, SERP providers, backlinks, CMS adapters
  agents/     Agent framework, typed tools, agent memory, thirteen specialised agents
  queue/      Queue abstraction over BullMQ + durable JobRecord mirror + scheduler + job status
```

Packages export TypeScript source directly (`"main": "./src/index.ts"`). Next compiles them via
`transpilePackages`; the worker runs them through `tsx`. There is no separate package build step,
which removes an entire class of stale-artifact bugs from a monorepo this size.

**Server/client boundary.** `@seo/shared`'s main barrel is isomorphic and safe in a client
component. Anything needing `node:crypto` sits behind an explicit subpath — `@seo/shared/crypto`
(AES-GCM, session tokens, fingerprints) and `@seo/shared/hash` (sha256, simhash). Re-exporting
those from the barrel pulled a Node built-in into the browser bundle and failed the production
build; the subpaths also make the boundary visible at the import site. Every other package is
server-only.

**Environment loading.** Both apps load the repo-root `.env` explicitly (`next.config.ts` and the
worker entrypoint). Next only reads env files from its own project directory, so in a workspace
layout the root `.env` is otherwise invisible — and the failure is silent and misleading: Redis
looks unreachable while it is perfectly healthy.

### Dependency direction

```
shared  ←  db  ←  ai
   ↑        ↑      ↑
   └── crawler     │
   ↑        ↑      │
   └── seo-engine ─┘
   ↑        ↑
   └── integrations
            ↑
         agents
            ↑
    web  ·  worker      (queue sits beside db, used by both)
```

Nothing below `agents` imports anything above it. `seo-engine` is pure computation — it never
touches Prisma or the network, which is why it is the most heavily unit-tested package.

---

## 3. Data model

The Prisma schema is the contract. Highlights:

| Cluster | Tables | Notes |
|---|---|---|
| Identity | `User`, `Session` | Database-backed sessions with a JWT carrier; revocation is immediate. |
| Sites | `Website`, `WebsiteSettings`, `KnowledgeBase`, `BrandFact` | Per-site crawl limits, autonomy level, model routing, budgets, schedules. |
| Integrations | `Integration` | One row per (site, provider). Credentials are AES-256-GCM encrypted and never leave the server. |
| Crawling | `Crawl`, `CrawlPage`, `LinkEdge` | Immutable per-crawl snapshots plus the full internal link graph. |
| Durable pages | `Page`, `PageSnapshot` | The cross-crawl view of a URL, with historical snapshots for diffs and experiments. |
| Technical SEO | `TechnicalIssue` | Reconciled by a stable `fingerprint`, so re-crawls update instead of duplicating, and produce OPEN → RESOLVED → REGRESSED transitions. |
| Search data | `SearchConsoleDaily`, `GscQueryMetric` | Source-tagged (`gsc` / `bing` / `ga4`), so analytics is provider-agnostic. |
| Keywords | `Keyword`, `KeywordMetric`, `KeywordCluster`, `Ranking` | Opportunity scores stored with their factor breakdown. |
| Competitors | `Competitor`, `CompetitorKeyword`, `CompetitorPage`, `SerpSnapshot` | |
| Content | `ContentOpportunity`, `ContentBrief`, `ContentDraft`, `ContentStageRun`, `ContentVersion` | Every pipeline stage is an explicit row, so stages can be re-run. |
| Links | `InternalLinkSuggestion` | |
| Machine readability | `StructuredDataItem`, `Entity`, `EntityRelationship`, `GeoAudit`, `GeoPageAudit` | |
| AI search | `AiVisibilityPrompt`, `AiVisibilityRun`, `AiVisibilityMention` | |
| Automation | `SeoAction`, `ActionExecution`, `Approval`, `Experiment`, `ChangeLog` | The full propose → approve → execute → measure trail. |
| Operations | `AgentRun`, `AiUsage`, `JobRecord`, `ScheduledJob`, `Report`, `Notification`, `ScoreSnapshot`, `StrategyPlan` | |
| Vectors | `EmbeddingRecord` | `Float[]` with exact in-process cosine search; see ADR-0003 for the pgvector path. |

---

## 4. The crawler

`crawlWebsite(config, hooks)` is a pure function: config in, `CrawlOutcome` out. It performs no
database writes, which makes it testable and lets the same engine power a full crawl, a single-URL
re-check after a change, and (in future) a dry run.

- BFS by depth with bounded concurrency and per-host rate limiting.
- URL normalisation is the backbone: `normalizeUrl` unifies protocol, `www`, trailing slashes,
  index files, default ports, tracking parameters and parameter order. Two URLs that render the
  same page produce the same key, or the crawler loops and the link graph fragments.
- Respects robots.txt (including `Crawl-delay`), include/exclude globs, max pages, max depth, and
  skips non-HTML extensions. **Every skip is recorded with a reason** rather than silently dropped.
- Detects crawl traps (repeated path segments, faceted parameter explosions, calendar patterns).
- Optional Playwright rendering behind `isRenderingAvailable()` — a missing browser degrades to
  HTTP crawling and never breaks a build or a job.
- Identifies itself with a configurable, honest user agent.

---

## 5. The SEO intelligence engine

`packages/seo-engine` is where the product's opinions live.

**Technical rules** (`technical/catalogue.ts` + `technical/audit.ts`) — ~60 rules declared as data
(id, category, severity, weight, auto-fixable, *rationale*), evaluated over an `AuditDataset`.
The rationale strings are rendered in the audit UI, so the methodology is visible rather than
folded into code comments. Site-level rules (duplicates, orphans, isolated clusters, sitemap
reconciliation) run over the whole dataset; page-level rules run per URL.

**Scoring** — four scorers, all returning `ExplainableScore`:
- Health: per-category penalties (severity × rule weight) normalised against site size with a
  saturating curve, combined with published category weights.
- Page SEO: nine measurable on-page signals.
- Keyword opportunity: eight weighted factors, degrading gracefully when no SERP provider exists.
- Action priority: `(Impact × Confidence × BusinessValue) / (Effort × Risk)`, square-rooted to
  spread the useful range, then Bayesian-adjusted by the site's own measured history.

**Keyword intelligence** — striking distance, CTR gaps against a published position/CTR curve,
content decay (separating *ranking* loss from *demand* loss from *SERP layout* change), and
cannibalisation detection that only fires when a second URL has a real impression share at a
comparable position.

**Content decision engine** (`content/decision.ts`) — the guard that stops page spam. Before any
LLM call it searches existing content, compares semantic intent, checks cannibalisation, and only
returns "create a new page" when nothing existing can plausibly rank and demand is measured.

**Internal links** — a PageRank pass over the link graph plus suggestions that require the anchor
phrase to already appear in the source page's prose, so links can be placed naturally. Anchor
diversity is enforced to prevent exact-match over-optimisation.

**GEO** — eleven measurable dimensions (entity clarity, structured data, fact density, content
structure, expertise signals, citation worthiness, brand consistency, definitions, comparative
content, first-party data, source quality) scored deterministically per page and rolled up per
site. Recommendations are framed as probabilities and best practice, never as guaranteed ranking
factors, because AI retrieval is not deterministic and pretending otherwise would be dishonest.

**Experiments** — Welch's t-test over daily series with a settling window, a minimum observation
period and an effect-size floor. Outcomes are labelled *likely positive / inconclusive / likely
negative*, and the interpretation text always names the confounders.

---

## 6. AI layer

`packages/ai` gives every consumer one façade:

```ts
await ai.generateStructured({
  task: 'content-brief', websiteId, role: 'reasoning',
  schema: BriefSchema, system, prompt,
});
```

Behind it: provider resolution (OpenAI / Anthropic / Gemini, or "not configured"), per-site model
routing by role (reasoning / fast / writing / embedding), a budget check, retry with backoff,
structured-output validation with a repair loop that feeds validation errors back to the model,
usage recording, and cost estimation.

Prompts live in `packages/ai/src/prompts/templates/` as versioned, typed templates — never as
string literals scattered through business logic. Shared fragments carry the anti-spam quality
rules and render the site knowledge base plus **verified** brand facts, with an instruction that
only verified facts may be asserted.

---

## 7. Agents

An agent is not a large prompt. Every agent runs the same shape:

1. **gather** — deterministic collection through typed tools (`getPage`, `getSearchConsoleData`,
   `getTechnicalIssues`, `searchSiteContent`, …). An agent never receives a database dump.
2. **reason** — at most one tightly-scoped LLM call with a structured output schema. Several
   agents (technical, analytics) are fully deterministic and never call a model at all.
3. **act** — deterministic persistence through write tools, which enforce that the action type is
   in the agent's declared `allowedActionTypes`.

Agent memory is explicit and database-backed: previous recommendations, measured outcomes,
rejected proposals. Nothing relies on model conversation memory.

`SEOManagerAgent` sits above the others and answers "what should we do next?", producing a
`StrategyPlan` with Today / This week / This month lists, and converting recommendations into
`SeoAction` rows with transparent priority scores.

---

## 8. Safety and autonomy

Five autonomy levels per site, from insights-only to high autonomy. The guardrail is a single
function, `canAutoExecute`, called by both the UI and the worker — the worker re-checks rather
than trusting the enqueuer.

Some actions **always** require explicit human approval regardless of level: creating redirects,
consolidating pages, and any custom action. Mass URL deletion, sitewide canonical removal and
robots.txt blocking are not automatable at all.

Every change writes an `ActionExecution` and a `ChangeLog` entry with before/after state and
rollback data, then opens an `Experiment` so the result is measured rather than assumed.

---

## 9. Jobs and scheduling

All slow work runs in `apps/worker`. Enqueueing **always** writes a durable `JobRecord` row first
and only then pushes to BullMQ, so the Jobs screen is accurate even when Redis is down — in that
case `enqueue` returns `{ enqueued: false, reason: 'redis-unavailable' }` rather than pretending
the job ran.

Schedules live in the `ScheduledJob` table and in each site's cron settings; `syncSchedules()`
reconciles Redis repeatables against the database idempotently.

---

## 10. Web app

- **Server Components by default**; client components only where interaction requires them.
- **Server queries** in `apps/web/src/server/queries/` are shared by both pages and API routes,
  so a page never round-trips through HTTP to read its own data.
- **API routes** go through one `route()` wrapper providing auth, CSRF, typed error translation
  and structured logging.
- **Auth** is database-backed sessions with a JWT carrier, bcrypt hashing, httpOnly cookies,
  double-submit CSRF, and edge middleware for cheap redirects.
- **Design system** in `components/ui/`, charts in `components/charts/`, tables and filters in
  `components/data/`. Tokens are CSS variables; every surface works in light and dark.

---

## 11. Graceful degradation

The base product boots with only `DATABASE_URL`, `AUTH_SECRET` and `ENCRYPTION_KEY`.

| Missing | Effect |
|---|---|
| Redis / worker | Crawls and syncs queue but do not run; the UI says so explicitly. |
| Any AI provider | Agents that need reasoning return `skipped` with a reason. Deterministic audits, scoring, link suggestions and GEO scoring all still work. |
| Search Console | Traffic panels show empty states; crawl-derived analysis is unaffected. |
| SERP provider | Keyword difficulty and competitor discovery fall back to Search Console data and say so in the score explanation. |
| Backlink provider | CSV import still works. |
| CMS adapter | Actions are prepared and approved but marked as manual-apply. |

Nothing is ever filled in with invented numbers. `DEMO_MODE=true` seeds a clearly-labelled
(`isDemo: true`, "[DEMO]" prefix) dataset and is the only path that creates synthetic rows.

---

## 12. Architecture decisions

See `docs/adr/`. Summary:

- **0001 — Monorepo with source-exported packages.** No build step for packages; Next
  transpiles, `tsx` runs. Removes stale-artifact bugs; costs a slightly slower cold typecheck.
- **0002 — Deterministic engine, scoped LLM.** Rules and scores in TypeScript; models for
  judgement only, always behind a schema. Reproducible, cheap, and safe when a provider is down.
- **0003 — `Float[]` embeddings before pgvector.** Exact cosine in-process is correct and fast
  to ~100k vectors and works on any Postgres. Migration path documented.
- **0004 — Custom auth over NextAuth.** Single-user-first, one dependency fewer, full control of
  session revocation and CSRF; the `User`/`Session` tables are shaped for future multi-user.
- **0005 — Durable JobRecord mirror.** The Jobs UI must be truthful when Redis is unavailable.
