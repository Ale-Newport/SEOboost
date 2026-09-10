#!/usr/bin/env bash
# Starts Postgres and Redis for local development without Docker (Homebrew).
set -euo pipefail

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew not found. Use 'docker compose up -d postgres redis' instead." >&2
  exit 1
fi

brew services start postgresql@17 >/dev/null 2>&1 || true
brew services start redis >/dev/null 2>&1 || true

PG_BIN="$(brew --prefix postgresql@17)/bin"
for _ in $(seq 1 30); do "$PG_BIN/pg_isready" -q && break; sleep 1; done

"$PG_BIN/createdb" seo_os 2>/dev/null || true
"$PG_BIN/pg_isready" && echo "postgres ready"
"$(brew --prefix redis)/bin/redis-cli" ping && echo "redis ready"
