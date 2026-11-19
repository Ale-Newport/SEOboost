# Contributing to SEO OS

Thanks for taking the time to contribute! This guide gets you from a fresh clone to a merged
pull request.

## How changes get in

- `main` is protected. Every external change lands through a **pull request from a fork**.
- Each pull request needs an approving review from the code owner
  ([@Ale-Newport](https://github.com/Ale-Newport), see [`.github/CODEOWNERS`](.github/CODEOWNERS))
  and green CI. New pushes dismiss earlier approvals, and all review threads must be resolved.
- Workflows from first-time contributors wait for maintainer approval before they run.

## Before you start

- **Bugs** — search [existing issues](https://github.com/Ale-Newport/SEOboost/issues) first, then
  open one with the bug template.
- **Features** — open a feature request or a
  [discussion](https://github.com/Ale-Newport/SEOboost/discussions) before writing a large change,
  so we can agree on the approach.
- **First contribution?** Look for
  [`good first issue`](https://github.com/Ale-Newport/SEOboost/labels/good%20first%20issue) and
  [`help wanted`](https://github.com/Ale-Newport/SEOboost/labels/help%20wanted).
- **Security issues** — never in public; see [SECURITY.md](SECURITY.md).

## Development setup

Prerequisites: Node 22 (`.nvmrc`), PostgreSQL 15+ and Redis 7+ (or Docker).

```bash
git clone https://github.com/<you>/SEOboost.git && cd SEOboost
./scripts/setup.sh            # writes .env with fresh secrets, installs deps, migrates
npm run dev                   # web on :3000 + worker
```

No Postgres/Redis locally? `docker compose up -d postgres redis` or `./scripts/dev-services.sh`
(Homebrew). To explore the UI with clearly labelled sample data: `npm run db:seed -- --demo`.

## Checks

Run the same checks CI runs before you push:

```bash
npm run lint
npm run typecheck && npm run typecheck:packages
npm test                      # Vitest unit + integration tests
npm run test:e2e              # Playwright (needs Postgres + Redis)
npm run build
```

`npm run verify` runs generate + typecheck + tests + build in one go.

## Guidelines

- **Keep pull requests focused.** One logical change per PR; separate refactors from behaviour changes.
- **Tests.** `packages/seo-engine` is pure and must stay that way — add tests in the package's
  `__tests__/` folder for every rule, score or parser you touch.
- **No fabricated data.** Every number the UI shows must come from a real source or be labelled
  as demo data. Do not add placeholder analytics.
- **Respect the guardrails.** No features for spam, cloaking, fake engagement or posting in
  communities without the operator's approval (see the README).
- **Database changes** go through `npm run db:migrate:dev` and ship with the migration.
- **Secrets** never go in code, tests or fixtures. Gitleaks runs on every push and PR.
- **Style.** TypeScript strict mode, ESLint, `.editorconfig`. Prefer small, explicit functions
  over clever abstractions.

## Commit messages

Write the subject in the imperative mood ("Add Bing sitemap submission"), keep it under 72
characters, and explain *why* in the body when it is not obvious.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
