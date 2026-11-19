# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- MIT license, security policy, contributing guide, code of conduct, issue and PR templates.

[Unreleased]: https://github.com/Ale-Newport/SEOboost/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Ale-Newport/SEOboost/releases/tag/v1.0.0
