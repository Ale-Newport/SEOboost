# Security Policy

SEO OS stores credentials for your Search Console, CMS, mail and social accounts, so security
reports are taken seriously and handled before anything else.

## Supported versions

| Version | Supported |
|---------|-----------|
| 1.x (`main`) | ✅ |
| < 1.0 | ❌ |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub:
[**Report a vulnerability**](https://github.com/Ale-Newport/SEOboost/security/advisories/new)
(Security tab → *Report a vulnerability*).

Include what you can of:

- the affected component (route, package, file) and version or commit,
- steps to reproduce or a proof of concept,
- the impact you believe it has.

You can expect an acknowledgement within **3 working days** and a status update at least every
**7 days** until it is resolved. Fixes ship as a patch release with a GitHub Security Advisory;
reporters are credited unless they ask not to be.

## Scope

In scope: everything in this repository — the web app, the worker, the packages, the Dockerfile
and `docker-compose.yml`.

Out of scope: vulnerabilities in third-party services the app integrates with, findings that
require a compromised host or a malicious administrator, and missing hardening on an install
that has deliberately turned a safeguard off (for example `ALLOW_PRIVATE_NETWORK_FETCH=true`).

## How the project protects you

- **Credentials at rest** are encrypted with AES-256-GCM using `ENCRYPTION_KEY` and are never
  returned to the browser.
- **Sessions** are httpOnly, `SameSite=Lax` cookies backed by a database row; every mutating API
  route also checks a CSRF token. Every route that takes an id checks ownership.
- **Server-side fetches of user-supplied URLs** (crawler, renderer, CMS/webhook adapters,
  Mastodon/Bluesky) are blocked from loopback, private, link-local and cloud-metadata
  addresses on every redirect hop.
- **Redirect targets** after login and OAuth are restricted to same-origin paths.
- **Containers** run as the unprivileged `node` user; Postgres and Redis are published on
  `127.0.0.1` only.
- **Repository**: secret scanning with push protection, gitleaks in CI, CodeQL, Dependabot
  alerts and security updates, dependency review on pull requests, and SHA-pinned Actions with
  read-only default permissions.

## Hardening a public install

1. Set `ALLOW_SIGNUP=false` once your account exists.
2. Serve the app over HTTPS and set `APP_URL` to the `https://` URL (enables secure cookies and HSTS).
3. Keep Postgres and Redis off the public internet and change the default database password.
4. Generate `AUTH_SECRET` and `ENCRYPTION_KEY` with `openssl rand -base64 48` / `openssl rand -base64 32`
   and store them in your host's secret manager, never in the repository.

## Known advisories

| Package | Advisory | Status |
|---------|----------|--------|
| `zod` 3.25.76 | Memory exhaustion when validating oversized constrained collections (fixed in 4.6.6) | Request bodies are size-limited by the API layer. The fix requires the zod 4 migration, tracked in [#6](https://github.com/Ale-Newport/SEOboost/issues/6). |
