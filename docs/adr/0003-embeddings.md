# ADR 0003 — `Float[]` embeddings with exact cosine, before pgvector

**Status:** accepted

## Context
Embeddings power semantic similarity for internal linking, cannibalisation detection, keyword
clustering and content-gap analysis. pgvector is the natural production answer but is an extension
that must be installed in the database, which adds a hard deployment prerequisite to a product
whose stated goal is "works with `docker compose up`".

## Decision
`EmbeddingRecord.vector` is a native Postgres `Float[]`. Similarity search loads the candidate set
for one website and one owner type and computes exact cosine similarity in process.

## Consequences
- **Good:** works on any Postgres, including a managed instance with no extension access.
- **Good:** exact results, not approximate — at this corpus size recall matters more than latency.
- **Good:** the provider abstraction means the vectors themselves are portable.
- **Cost:** linear scan. Measured acceptable to roughly 100k vectors per site with 1536 dimensions.

## Migration path when a site exceeds that
1. `CREATE EXTENSION vector;`
2. Add `vectorV2 vector(1536)` via `Unsupported("vector")` in the Prisma schema, backfilled from
   `vector`.
3. Create an HNSW index and replace the body of `findSimilar` with an ORDER BY `<=>` query.
The call sites do not change — `findSimilar` is the only entry point.
