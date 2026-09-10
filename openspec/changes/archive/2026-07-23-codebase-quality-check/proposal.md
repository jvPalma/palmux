## Why

palmux grew fast through seven back-to-back feature changes (chrome tabs/panes → split view → reorder → markdown → theming → tab grouping) and now carries **zero automated code-quality tooling** — no linter, no formatter, no lint/format scripts anywhere in the repo — while the React client has accumulated the usual rapid-growth friction (per-frame/per-keystroke re-render hazards, boolean-prop proliferation, and a ~1000-line `App.tsx` orchestration hub). This change installs a reproducible quality gate and captures a concrete, ranked catalog of findings to work down, so future changes start from a linted, formatted, deeper baseline rather than accreting more of the same.

## What Changes

- **Introduce a lint + format gate** (not a migration — there is nothing to migrate _from_): add **Oxlint** (`correctness` + `perf` + `react`/`react-perf` rules) and **Oxfmt** (Prettier-compatible, matching the project's 2-space / single-quote / semicolon / trailing-comma style), each behind a root `yarn lint` / `yarn format` script that runs across the workspaces. `performance-lint-rules` (the skill) targets the oxc Rust repo and is **N/A here**; its applicable analog is enabling Oxlint's `perf` category + `react-perf` rules — folded into the Oxlint config.
- **Catalog and fix a ranked set of React performance findings** (Vercel React guide, _client-only_ subset — the app is a **Vite SPA on React 18**, so all `server-*`/RSC/`next/dynamic`/React-19 rules are excluded): `rerender-*`, `rendering-*`, `js-*`, `bundle-*`, `client-*` instances with `file:line`.
- **Catalog and address composition-pattern findings** (Vercel composition guide, _React-18_ subset — no `use()`/`forwardRef` drop): boolean-prop proliferation and prop-drilling that want explicit variants, compound components, or a lifted-state seam.
- **Catalog architecture deepening candidates** (shallow → deep modules): extract testable seams out of the `App.tsx` orchestration hub and tighten module interfaces, verified with the deletion test.
- These findings are internal-quality refactors (no user-facing behavior change), so they land as **tasks + a design catalog**, gated by the existing test suites staying green; only the tooling is a new spec capability.

## Capabilities

### New Capabilities

- `code-quality-tooling`: a reproducible lint + format + performance-rule gate for the workspace (Oxlint + Oxfmt config, scripts, and the rule categories enforced), plus the standing quality invariants the catalogued refactors must preserve (behavior-preserving, test-gated).

### Modified Capabilities

<!-- None — the perf/composition/architecture findings are behavior-preserving internal refactors; they do not change any existing capability's requirements. -->

## Impact

- **New config + deps**: `.oxlintrc.json`, `.oxfmtrc.json`, dev-dependencies `oxlint` + `oxfmt`, root `lint`/`format`/`format:check` scripts (and per-workspace wiring). No CI is added (out of scope per project convention — CI is only touched on explicit request).
- **Touched source**: primarily `packages/client/src/` (React perf + composition refactors: `App.tsx`, `session/*`, `terminal/*`, `panes/*`, `mobile/*`, `settings/*`), with a few `packages/server/src/` and `packages/shared/src/` module-interface tightenings from the architecture pass.
- **Safety**: every refactor is behavior-preserving and gated by `yarn typecheck` + `yarn test` (500+ existing tests) staying green; the tooling introduction is additive and reversible.
- **Formatting churn**: the first `oxfmt --write` will reflow files repo-wide — landed as one isolated formatting commit so it doesn't muddy the refactor diffs.
