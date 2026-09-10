# Engineering contract — read before writing any code in this repo

This file is the single source of truth for conventions. Everything below is already
implemented and must be **used**, not re-invented.

## Repo layout

```
apps/web        Next.js 15 App Router (UI + API routes + server actions)
apps/worker     BullMQ worker process + scheduler
packages/shared  env, logger, errors, url, text, math, concurrency, crypto, dates, constants, validation
packages/db      Prisma client singleton + helpers (re-exports all Prisma types)
packages/ai      AI provider abstraction, prompt registry, structured output, embeddings, cost tracking
packages/crawler HTTP/JS crawler, robots, sitemaps, HTML analysis
packages/seo-engine  Technical rules, scoring, keywords, clustering, internal links, content intelligence, GEO
packages/integrations  Google Search Console/GA4, Bing, SERP providers, backlinks, CMS adapters
packages/agents  Agent framework, agent tools, specialised SEO agents
packages/queue   Queue abstraction over BullMQ + durable JobRecord mirror
```

## Hard rules

1. **TypeScript strict.** No `any`, no `@ts-ignore`, no `as unknown as X` unless there is a
   comment explaining why. Everything must pass `npm run typecheck`.
2. **ESM.** All packages are `"type": "module"`. Import from siblings with *extensionless
   relative paths* (`./foo`, `../bar/baz`) — Next `transpilePackages` and `tsx` both resolve them.
3. **Never read `process.env` directly** outside `packages/shared/src/env.ts`.
   Use `import { env, isConfigured } from '@seo/shared'`.
4. **Never crash on a missing integration.** If a provider key is absent, throw
   `IntegrationNotConfiguredError` from a function the caller expects to fail, or return a
   typed `{ configured: false }` result. The app must boot with only
   `DATABASE_URL` + `AUTH_SECRET` + `ENCRYPTION_KEY`.
5. **No fabricated data.** No hard-coded metrics, no `Math.random()` analytics, no placeholder
   charts. If data is unavailable, return empty and let the UI show an empty state.
   The *only* exception is `packages/db/src/seed.ts` behind `DEMO_MODE`, which marks rows `isDemo: true`.
6. **No TODO placeholders for core behaviour.** If a feature is in your scope, implement it.
7. **Secrets never leave the server.** Integration credentials are encrypted with
   `encryptJson()/decryptJson()` from `@seo/shared` and must never be returned by an API route.
8. **Every exported function gets a short doc comment** when its behaviour is not obvious from
   the name. Explain *why*, not *what*.
9. **Explainable scores.** Any 0-100 score must return its factors
   (`ExplainableScore` / `ScoreFactor` in `@seo/shared`), never a bare number.
10. **No black-hat features.** No mass outreach, no cloaking, no fake reviews/authors/citations,
    no scaled low-quality page generation, no scraping behind logins.

## Available from `@seo/shared`

```ts
import {
  env, isConfigured,
  AppError, ValidationError, NotFoundError, UnauthorizedError, ForbiddenError,
  ConflictError, RateLimitError, IntegrationNotConfiguredError, ProviderError,
  toAppError, errorMessage,
  createLogger, logger,                       // structured, auto-redacting
  normalizeUrl, resolveUrl, getHostname, cleanDomain, isSameDomain, isSameSite,
  getPath, urlDepth, hasNonHtmlExtension, looksLikeCrawlTrap, matchesPattern,
  toAbsolute, slugFromUrl,
  slugify, normalizeKeyword, tokenize, countWords, splitSentences,
  fleschReadingEase, readabilityLabel, truncate,
  jaccardSimilarity, lexicalCosine, containsPhrase, keywordDensity, extractTopTerms,
  markdownToText, extractMarkdownHeadings, STOP_WORDS,
  clamp, round, safeDivide, normalize, saturate, logNormalize, percentChange,
  sum, mean, median, stdDev, welchTTest, cosineSimilarity, expectedCtr, ctrDelta,
  createLimiter, mapWithConcurrency, retry, sleep, withTimeout, RateLimiter, chunk,
  toUtcDate, formatDateKey, addDays, daysBetween, lastNDays, previousPeriod, eachDay,
  isWithin, startOfMonth, startOfWeek, humanDuration, DAY_MS,
  SEO_THRESHOLDS, SEVERITY_WEIGHT, SEVERITY_ORDER, HEALTH_CATEGORY_WEIGHT,
  KEYWORD_OPPORTUNITY_WEIGHTS, GEO_DIMENSION_WEIGHTS, GEO_DIMENSION_LABELS,
  PAGE_SEO_WEIGHTS, ACTION_RISK_BY_TYPE, ALWAYS_REQUIRES_APPROVAL,
  AUTONOMY_DESCRIPTIONS, SCHEMA_TYPES, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE,
  // types
  type Paginated, type ScoreFactor, type ExplainableScore, type IntegrationHealth,
  type MetricDelta, type TimeSeriesPoint, type Trend, type HeadingNode,
  type StructuredDataBlock, type ImageInfo, type DiscoveredLink, type JobProgress,
  // zod schemas
  paginationSchema, dateRangeSchema, domainSchema, urlSchema, emailSchema, passwordSchema,
  createWebsiteSchema, updateWebsiteSchema, websiteSettingsSchema, loginSchema, signupSchema,
  startCrawlSchema, keywordImportSchema, approvalDecisionSchema, knowledgeBaseSchema,
  brandFactSchema, parseSearchParams,
} from '@seo/shared';

// Node-only surfaces live behind explicit subpaths. The main barrel is isomorphic: a client
// component that imports from '@seo/shared' must not drag `node:crypto` into the browser bundle,
// which is exactly what a production build fails on.
import { encrypt, decrypt, encryptJson, decryptJson, tryDecryptJson, hashToken, randomToken,
         constantTimeEquals, fingerprint } from '@seo/shared/crypto';
import { sha256, contentHash, simhash, simhashDistance } from '@seo/shared/hash';
```

**Server/client boundary.** `@seo/shared` is safe in a client component. `@seo/shared/crypto`,
`@seo/shared/hash`, `@seo/db`, `@seo/ai`, `@seo/crawler`, `@seo/integrations`, `@seo/agents` and
`@seo/queue` are server-only — importing any of them from a `'use client'` file breaks the build.

## Available from `@seo/db`

```ts
import { prisma, Prisma, checkDatabaseConnection, isUniqueViolation, isNotFound,
         createManyChunked, json, readJson, getAppSetting, setAppSetting,
         paginate, buildPaginated } from '@seo/db';
// All Prisma model types and enums are re-exported: Website, Page, Keyword,
// IssueSeverity, ActionStatus, AutonomyLevel, …
```

The full schema is `packages/db/prisma/schema.prisma` (54 tables). **Read it** before writing
persistence code. Do not change it without a very good reason; if you must, add a migration
via `npx prisma migrate dev --name <name> --schema packages/db/prisma/schema.prisma`.

## Logging

```ts
const log = createLogger('crawler');
log.info('crawl finished', { websiteId, pages: 120 });
```
Keys matching /password|secret|token|apikey|credential|.../ are auto-redacted.

## Error handling in API routes

Throw the typed errors; the shared route wrapper converts them to JSON with the right status.

## Style

- 2-space indent, single quotes, semicolons, trailing commas.
- Prefer small pure functions; keep I/O at the edges so logic is unit-testable.
- Comments explain intent and non-obvious tradeoffs. Do not narrate obvious code.
- File names kebab-case; exported symbols camelCase/PascalCase.
