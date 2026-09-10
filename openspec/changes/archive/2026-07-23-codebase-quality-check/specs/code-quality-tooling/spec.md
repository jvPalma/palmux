## ADDED Requirements

### Requirement: The workspace enforces linting via Oxlint

The repository SHALL provide a single reproducible lint command (`yarn lint`) that runs **Oxlint** across every workspace package, and a matching autofix command (`yarn lint:fix`). Oxlint SHALL be introduced fresh — there is no prior ESLint config to migrate — via a checked-in `.oxlintrc.json` that enables the `correctness` (default), `perf`, and `suspicious` categories plus the `react`, `react-perf`, `import`, and `unicorn` rule sets, and pins the config schema. The React perf rule surface (the applicable analog of the oxc-internal `performance-lint-rules` guidance, which does NOT apply to this TypeScript app) SHALL be enabled through Oxlint's `perf` category and the `react-perf` rules.

#### Scenario: A single command lints the whole workspace

- **WHEN** a developer runs `yarn lint` at the repo root
- **THEN** Oxlint lints all `packages/*` TypeScript/TSX sources against the configured rule set and exits non-zero on any violation

#### Scenario: React performance rules are active

- **WHEN** a component reintroduces an unstable inline prop or another `react-perf`/`perf`-category violation
- **THEN** `yarn lint` reports it (the perf-rule gate is enforced, not merely advisory)

#### Scenario: No ESLint is added

- **WHEN** the tooling is installed
- **THEN** the repo depends on `oxlint` only (no `eslint`, no `@oxlint/migrate` in `package.json`) and the config lives in `.oxlintrc.json`

### Requirement: The workspace enforces formatting via Oxfmt

The repository SHALL provide `yarn format` (write) and `yarn format:check` (verify, non-mutating) commands backed by **Oxfmt**, configured in a checked-in `.oxfmtrc.json` that matches the project's established style: two-space indentation, semicolons, single quotes in TS/JS, double quotes in JSX attributes, and trailing commas where Prettier would add them. Oxfmt is introduced fresh (no Prettier or Biome config exists to migrate from). The one-time repo-wide reflow SHALL be isolated from behavioral refactors.

#### Scenario: Format check is reproducible and non-mutating

- **WHEN** a developer runs `yarn format:check`
- **THEN** Oxfmt verifies every source file against `.oxfmtrc.json` and exits non-zero on any file that is not already formatted, changing nothing

#### Scenario: Style matches the codebase conventions

- **WHEN** Oxfmt formats a TS/TSX file
- **THEN** the result keeps two-space indent, semicolons, single-quoted TS strings, double-quoted JSX attributes, and Prettier-style trailing commas (no churn beyond whitespace/quote normalization)

### Requirement: Catalogued quality refactors are behavior-preserving and test-gated

Every refactor drawn from this change's findings catalog (React re-render/rendering/JS-perf/bundle fixes, composition-pattern extractions, and architecture deepenings) SHALL preserve observable behavior and SHALL be gated by `yarn typecheck` and the existing test suites (500+ tests) staying green; no finding SHALL change an existing capability's requirements. New unit tests MAY be added where a refactor exposes a newly-testable seam.

#### Scenario: A refactor lands only behind a green gate

- **WHEN** a composition or architecture refactor (e.g. extracting a `useTabGroups` hook or a `SplitView` compound) is applied
- **THEN** `yarn typecheck` and `yarn test` both pass unchanged, and no user-visible behavior differs

#### Scenario: Findings never alter shipped behavior

- **WHEN** any performance finding is fixed (e.g. an index Map, a deferred read, a memoized child)
- **THEN** the fix changes only internal efficiency/structure, and the archived feature specs remain accurate without modification
