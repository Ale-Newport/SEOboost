# ADR 0002 — Deterministic engine, tightly scoped LLM

**Status:** accepted

## Context
The obvious way to build an "AI SEO platform" is to assemble a large prompt and ask a model what
to do. That approach is non-reproducible, expensive at portfolio scale, impossible to unit-test,
and fails badly when a provider is unavailable. It also produces confident nonsense: a model asked
to "audit this site" will invent issues.

## Decision
1. Rules, thresholds and scores are plain TypeScript with published weights in
   `packages/shared/src/constants.ts`. Every score returns an `ExplainableScore` carrying its
   factors, weights, contributions and per-factor explanations.
2. LLMs are used only where judgement genuinely helps: intent classification, topic naming,
   content strategy, writing, GEO recommendations, competitor synthesis, AI-answer analysis, and
   the SEO Manager's strategy. Every such call goes through a structured output schema with
   validation and a repair retry.
3. Agents run gather (deterministic) → reason (scoped LLM) → act (deterministic). Tools fetch
   exactly what is needed; no agent ever receives a database dump.

## Consequences
- **Good:** the audit, scores, link suggestions and GEO analysis are reproducible and unit-tested.
- **Good:** the product remains substantially useful with zero AI keys configured.
- **Good:** cost is bounded and attributable per site, model and task.
- **Cost:** more code than a prompt-only design, and the rules encode opinions that need periodic
  revision as search changes. The `rationale` field on every rule makes those opinions reviewable.
