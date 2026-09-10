# ADR 0001 — npm workspaces with source-exported packages

**Status:** accepted

## Context
The system spans nine internal packages plus two applications. A conventional monorepo compiles
each package to `dist/` and consumes the artifacts, which requires build orchestration and
produces a recurring class of bug: an application importing a stale `dist/` after a source change.

## Decision
Packages export TypeScript source directly (`"main": "./src/index.ts"`). `apps/web` compiles them
through Next's `transpilePackages`; `apps/worker` runs them through `tsx`. There is no per-package
build step and no `dist/` directory.

## Consequences
- **Good:** one source of truth; no stale artifacts; instant cross-package refactors; simple CI.
- **Good:** `npm run typecheck` over the two app tsconfigs transitively covers every package.
- **Cost:** a cold typecheck is slower than incremental project references would be.
- **Cost:** publishing a package externally would require adding a build step. Acceptable — these
  packages are internal by design.
- **Rejected:** Turborepo/Nx. Real value at this size would be caching, and the build we would be
  caching is the one this decision removes.
