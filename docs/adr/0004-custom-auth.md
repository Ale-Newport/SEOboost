# ADR 0004 — Custom session auth instead of NextAuth

**Status:** accepted

## Context
The product is single-user first, with an architecture that must be able to grow into multi-user
SaaS. NextAuth/Auth.js solves OAuth-provider login, which is not the requirement here; the
requirement is a secure local account plus a separate Google OAuth flow for *Search Console data
access* (an integration, not a login).

## Decision
Hand-rolled session auth: bcrypt password hashing (cost 12), database-backed `Session` rows with a
JWT carrier (`jose`), httpOnly `SameSite=Lax` cookies, double-submit CSRF tokens, constant-time
comparisons, timing-equalised login, and edge middleware for cheap redirects. Google OAuth lives
entirely in `packages/integrations` as an integration concern.

## Consequences
- **Good:** immediate session revocation — deleting the row logs the user out now, not at token
  expiry. A JWT-only design cannot do this.
- **Good:** one fewer dependency tracking Next's release cadence, and no version churn risk.
- **Good:** login and the data integration are cleanly separated; connecting Search Console does
  not affect who you are signed in as.
- **Cost:** we own the security-sensitive code. Mitigated by keeping it small (~250 lines),
  conventional, and covered by tests.
- **Growth path:** `User.role` and `Website.userId` already exist; adding an organisation table and
  a membership join is additive.
