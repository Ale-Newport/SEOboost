#!/usr/bin/env bash
# One-shot local setup. Idempotent: safe to re-run.
set -euo pipefail

cd "$(dirname "$0")/.."

info()  { printf '\033[36m→\033[0m %s\n' "$1"; }
ok()    { printf '\033[32m✓\033[0m %s\n' "$1"; }
warn()  { printf '\033[33m!\033[0m %s\n' "$1"; }

if [ ! -f .env ]; then
  info "Creating .env from .env.example"
  cp .env.example .env

  # Generate the two secrets the app refuses to boot without.
  AUTH_SECRET=$(openssl rand -base64 48 | tr -d '\n')
  ENCRYPTION_KEY=$(openssl rand -base64 32 | tr -d '\n')

  # BSD sed (macOS) needs an explicit empty backup suffix.
  if sed --version >/dev/null 2>&1; then SED=(sed -i); else SED=(sed -i ''); fi
  "${SED[@]}" "s|^AUTH_SECRET=.*|AUTH_SECRET=\"${AUTH_SECRET}\"|" .env
  "${SED[@]}" "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=\"${ENCRYPTION_KEY}\"|" .env
  ok "Generated AUTH_SECRET and ENCRYPTION_KEY"
  warn "Keep ENCRYPTION_KEY safe — changing it makes stored integration credentials unreadable."
else
  ok ".env already exists (leaving it alone)"
fi

info "Installing dependencies"
npm install --no-audit --no-fund

info "Generating the Prisma client"
npm run db:generate

info "Applying database migrations"
if ! npm run db:migrate; then
  warn "Migrations failed. Is Postgres running and DATABASE_URL correct?"
  warn "With Docker:      docker compose up -d postgres redis"
  warn "With Homebrew:    brew services start postgresql@17 && createdb seo_os"
  exit 1
fi

ok "Setup complete."
echo
echo "  Start everything:   npm run dev"
echo "  Web only:           npm run dev:web      → http://localhost:3000"
echo "  Worker only:        npm run dev:worker"
echo
echo "  Optional demo data: DEMO_MODE=true npm run db:seed"
echo
