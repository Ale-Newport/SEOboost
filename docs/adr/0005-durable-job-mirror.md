# ADR 0005 — Durable `JobRecord` mirror alongside BullMQ

**Status:** accepted

## Context
BullMQ keeps job state in Redis. If Redis is unavailable — a real possibility in a single-VPS
deployment, and the default state of a fresh checkout — a Redis-only design leaves the Jobs screen
blank and silently drops the user's request.

## Decision
`enqueue()` always writes a `JobRecord` row first, then pushes to BullMQ if Redis is reachable.
When it is not, the row is kept in `QUEUED` with a `progressMessage` explaining that no worker is
connected, and `enqueue` returns `{ enqueued: false, reason: 'redis-unavailable' }`.

Work is **never** executed inline as a fallback: an HTTP request must not run a 10,000-page crawl,
and pretending a job succeeded would be worse than reporting that it is waiting.

## Consequences
- **Good:** the Jobs UI is truthful in every state, with full history and retry.
- **Good:** job history survives a Redis flush.
- **Good:** the API layer can report the exact reason a request will not progress.
- **Cost:** one extra write per enqueue, and the reconciliation logic in `worker-runtime.ts`.
