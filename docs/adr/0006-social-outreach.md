# ADR 0006 — Social listening and publishing: participate, never astroturf

**Status:** accepted

## Context
A site gets found in more places than search results. People describe the exact problem a
product solves on Reddit, Hacker News, Bluesky, X and in YouTube comments every day, and a
maker who answers them helpfully earns visibility no amount of on-page work buys. The same
capability, automated naively, is a spam bot: it gets accounts banned, products blacklisted by
moderators, and — with undisclosed affiliation — runs into advertising law.

[agent-reach](https://github.com/Panniantong/agent-reach) gives an agent read access to many of
these platforms through one JSON CLI. It is deliberately read-only.

## Decision
Split the module along the read/write line and put a human on the write side wherever it touches
someone else's community.

**Reading** (`packages/integrations/src/social/`): each platform has an ordered list of readers —
the official API when an account is connected, then agent-reach, then a public endpoint. A
*final* error (rate limit, platform verification wall, bad input) stops the chain instead of
retrying through another door. agent-reach is used within its own red lines: no logins on the
user's behalf, no retry loops, no writes.

**Deciding** (`packages/seo-engine/src/social/`, pure and unit-tested): a published, explainable
relevance score (topic fit, intent, freshness, engagement, community fit); a deterministic reading
of each community's own rules into ALLOWED / RESTRICTED / FORBIDDEN / UNKNOWN; and the guardrails —
one reply per thread, a daily reply cap, two replies per community per week, no replies to threads
older than 14 days, no link where the rules restrict promotion, a cap on the share of activity that
links to the site, and mandatory disclosure whenever the product is named. Operator settings can
tighten the caps but never exceed the hard limits.

**Writing** (`publishers/`, official APIs only): every post is a `SeoAction`.
- `SOCIAL_REPLY` — anything posted into a community we do not own, replies included — is in
  `ALWAYS_REQUIRES_APPROVAL`. No autonomy level publishes one unattended.
- `SOCIAL_POST` — posts on the operator's own channels — publishes automatically only at Level 4.
- The guardrails run again at publish time, from current data.
- Platforms without a write API (Hacker News) become "post by hand" with a prefilled link. There is
  no browser-automation fallback.
- A failed publish is never retried automatically: the post may exist on the platform even though
  the response was lost, and a duplicate is worse than a visible failure.

Social actions do not open an `Experiment`: a post is not a change to the site, and a Search
Console before/after test on it would report noise as a result. Links carry UTM parameters so
referral traffic is attributable in analytics instead.

## Consequences
- **Good:** the product can find and act on real conversations across a dozen platforms, and the
  daily posting loop runs unattended on owned channels.
- **Good:** every reply has a human reviewer, a stated reason, the relevance breakdown and the
  community rules attached — the decision is auditable after the fact.
- **Cost:** reply throughput is bounded by the operator's attention by design.
- **Cost:** agent-reach is a Python tool outside this repo; when it is missing, listening covers
  Reddit, Hacker News and Bluesky only, and the UI says so.
