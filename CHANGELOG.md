# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-11-19

### Security

- **SSRF:** user-supplied fetches now check the address they actually connect to, closing DNS
  rebinding between the check and the connection (#7).
- **Brute force:** sign-in is rate-limited per IP and per account, and sign-up per IP, with
  `Retry-After` on 429 responses (#8).
- **Ownership:** concurrent first sign-ups can no longer both become OWNER (#3).
- **CSRF:** a `null` or malformed `Origin` header is rejected with 401 instead of crashing with
  500 (#2).
- **GitHub HTML:** sanitized with an allowlist parser (`sanitize-html`) instead of regexes; entity-encoded
  `javascript:` URLs are caught (#26).
- **Dependencies:** zod 4.6.7 (memory-exhaustion advisory) and a patched `effect` for the Prisma
  CLI. `npm audit` reports 0 vulnerabilities.

### Added

- `npm run demo`: a production build on labelled synthetic data with a throwaway login, in one
  command (#10).
- Unit tests for `apps/web` run in Vitest and CI (#9); e2e test for concurrent sign-ups.

### Changed

- Migrated from zod 3 to zod 4 (#6). Structured-output JSON Schemas are byte-identical; partial
  updates keep omitted fields unchanged. Default validation messages use zod 4 wording.
- Dependency updates: React 19.3.1, Radix UI, OpenAI SDK 7.57, Playwright 1.65, googleapis 190,
  @google/genai 3.3, lucide-react 1.73 and 20 more minor/patch updates.

### Fixed

- `react` and `react-dom` versions diverged in the lockfile, breaking `next build`.
- Remaining lint warnings (#4, #5); `npm run lint` is now warning-free.

## [1.0.0] - 2026-11-19

First public release.

### Added

- **Crawler** with robots.txt, sitemaps, redirect and canonical handling, crawl-trap detection,
  optional JavaScript rendering, rate limiting, cancellation and live progress.
- **Technical audit** of ~60 rules across crawlability, indexability, metadata, content, links,
  architecture, structured data, security and internationalisation, with a site health score.
- **Search Console, GA4 and Bing Webmaster Tools** integrations with 16-month backfill.
- **Keyword intelligence**: striking-distance detection, CTR gaps, content decay, cannibalisation,
  clustering and an explainable 0–100 opportunity score.
- **Content decision engine** and a 14-stage pipeline from research to publication with
  fact-checking safeguards.
- **Internal links**: PageRank over the link graph, orphan detection and anchor suggestions.
- **GEO**: eleven machine-readability dimensions, entity graph extraction and structured-data generation.
- **AI visibility** tracking through official provider APIs, plus manual import.
- **Social listening and publishing** for Reddit, Hacker News, Bluesky, Mastodon, X, LinkedIn,
  Dev.to, Telegram and Discord, with approval-gated, disclosed replies.
- **Sign in with ChatGPT** as an AI provider, and one-click social account linking.
- **In-app mail** over IMAP/SMTP (Gmail, Outlook, iCloud, Yahoo, any server).
- **Personal GitHub and Reddit accounts** usable from inside the app.
- **Automation** with five autonomy levels, an approval queue with diffs, CMS adapters
  (WordPress, Git/GitHub, webhook, Shopify, Webflow) and rollback data.
- **Experiments** that measure every applied change with Welch's t-test and feed results back
  into prioritisation.
- Docker images for web and worker, `docker-compose.yml`, and a one-command `scripts/setup.sh`.

### Security

- Server-side request forgery guard for every fetch of a user-supplied URL (crawler, renderer,
  CMS/webhook adapters, Mastodon, Bluesky), checked on each redirect hop.
- Same-origin enforcement for post-login and OAuth return paths (blocks `/%09/evil.com`-style
  open redirects).
- Admin role required to change installation-wide OAuth app credentials.
- 5 MB cap on JSON request bodies.
- Fixed CodeQL findings: polynomial-time regexes on remote and LLM-produced input replaced with
  linear scanners; the GitHub HTML sanitizer repeats until stable and escapes crafted markup;
  `resolveUrl` rejects `vbscript:` and newline-split `javascript:` URLs; Markdown links escape
  backslashes.
- Containers run as the unprivileged `node` user; Postgres and Redis are bound to `127.0.0.1`
  in `docker-compose.yml`.
- `Content-Security-Policy: frame-ancestors 'none'`, HSTS in production, no `X-Powered-By`.
- Dependencies updated: Next.js 15.5.29 (fixes image-optimizer RCE and cache-poisoning
  advisories), Vitest 4.1.12, ESLint 9.39.5, fast-xml-parser 5.12.1, plus patched transitive
  `postcss`, `postcss-selector-parser`, `brace-expansion` and `deepmerge-ts`.

### Infrastructure

- GitHub Actions: lint, typecheck, unit tests, production build, Playwright end-to-end tests,
  Docker builds, CodeQL, gitleaks, dependency audit and dependency review — all with SHA-pinned
  actions and read-only default permissions.
- Dependabot for npm, GitHub Actions and Docker.
- ESLint flat config (`next lint` replacement); lint now runs and passes.

### Fixed

- Invalid nested `<button>` in sortable table headers with info tooltips, which caused a React
  hydration error on the Keywords page.
- Section headers without actions overlapped their description (GEO readiness page).
- Truncated column headers in the keyword table.
- End-to-end tests: ambiguous password selector and navigation races with client redirects.
- MIT license, security policy, contributing guide, code of conduct, issue and PR templates.

[Unreleased]: https://github.com/Ale-Newport/SEOboost/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/Ale-Newport/SEOboost/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Ale-Newport/SEOboost/releases/tag/v1.0.0
