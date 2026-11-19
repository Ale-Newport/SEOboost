# Launch kit

Ready-to-post copy for sharing SEO OS. Everything here is accurate as of v1.0.0 — update the
numbers if they change. Post from your own accounts, one community at a time, and stay in the
thread to answer questions. Read each community's rules first; several only allow self-promotion
on specific days or in specific threads.

## Show HN

**Title** (80 chars max)

> Show HN: SEO OS – self-hosted SEO/GEO platform that measures if its fixes worked

**URL:** https://github.com/Ale-Newport/SEOboost

**First comment**

> Hi HN — I built SEO OS to run SEO for a handful of my own sites without paying for five
> different SaaS tools or trusting a black box.
>
> It crawls each site, pulls Search Console/GA4/Bing data, runs 61 technical audit rules, finds
> keyword opportunities (striking distance, CTR gaps, decay, cannibalisation), suggests internal
> links with PageRank over the link graph, and scores pages on "GEO" — how readable they are to
> answer engines. Agents propose prioritised changes; nothing reaches a live site until you
> approve it in a queue with diffs.
>
> The part I cared most about: every applied change opens an experiment. A Welch's t-test over
> daily series, a settling window and an effect-size floor give "likely positive / inconclusive /
> likely negative" — never a causal claim — and those results re-weight future recommendations.
>
> Design choices that might be interesting:
> - Deterministic first: rules and scores are plain TypeScript with published weights; the LLM
>   only does writing/classification/synthesis behind structured output schemas.
> - Every score is explainable — factors, weights and contributions are shown in the UI.
> - Self-hosted (Next.js 15, BullMQ, Postgres, Redis), MIT licensed, bring your own API keys.
>   No AI provider is required for the audits, scoring and link analysis.
> - It deliberately refuses spammy tactics: no fake reviews, doorway pages or unapproved
>   posting in other people's communities.
>
> There's no hosted demo because it stores credentials for your accounts, but
> `npm run db:seed -- --demo` loads a clearly labelled demo dataset so you can click around
> locally. Feedback on the scoring models and the experiment design is very welcome.

## Reddit

Post as a text post, link in the body, disclose that you built it. Suggested communities
(check current rules and flair before posting):

| Subreddit | Angle | Notes |
|---|---|---|
| r/selfhosted | Self-hosted alternative to SEO SaaS suites | Allows project posts; use the correct flair |
| r/TechSEO | Explainable scoring, 61-rule audit, GEO dimensions | Lead with methodology, not promotion |
| r/SideProject | Build story | Self-promotion is the point of the sub |
| r/opensource | MIT-licensed, looking for contributors | Mention `good first issue` labels |
| r/nextjs | Architecture: Next.js 15 + BullMQ monorepo with source packages | Technical write-up only |

**r/selfhosted**

> **Title:** SEO OS — a self-hosted SEO + GEO platform for managing several sites (MIT)
>
> I run a few small sites and got tired of juggling SaaS dashboards, so I built a self-hosted
> tool that does it end to end: crawler + 61-rule technical audit, Search Console/GA4/Bing
> import, keyword opportunities, internal-link suggestions, AI-answer-engine readiness (GEO),
> and an approval queue for changes it wants to make to WordPress/Git/Shopify/Webflow.
>
> Every applied change gets measured afterwards (t-test with a settling window) so you can see
> whether it actually helped.
>
> Stack: Next.js 15, BullMQ worker, Postgres, Redis, Docker Compose. Credentials are encrypted
> at rest; AI providers are optional (bring your own key, or none).
>
> Repo: https://github.com/Ale-Newport/SEOboost — disclosure: I'm the author. Happy to answer
> questions and very open to feedback.

**r/TechSEO**

> **Title:** I open-sourced the explainable scoring models I use for technical audits, GEO and
> keyword opportunity — feedback wanted
>
> Each score (site health, GEO readiness, keyword opportunity) is a weighted sum of published
> factors, and the UI shows every factor's contribution. GEO is scored across eleven dimensions
> (fact density, expertise signals, structure, citation-worthiness, comparisons & tables, …) and
> is explicitly framed as "probability of being understood and quoted", not a ranking lever.
> Changes are evaluated afterwards with Welch's t-test and an effect-size floor.
>
> Weights live in `packages/seo-engine` — I'd love critique of the factors and weights from
> people who do this professionally. Repo: https://github.com/Ale-Newport/SEOboost (I'm the author.)

## Other places

- **dev.to / Hashnode** — a write-up on "deterministic first, LLM second" agent design, linking the repo.
- **awesome-selfhosted** — submit a PR to the *Analytics* or *Software Development* section once
  the project has a few releases; follow that list's contribution rules.
- **Product Hunt** — only once a hosted demo or a one-click deploy exists.
