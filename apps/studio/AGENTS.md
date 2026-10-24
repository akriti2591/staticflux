# apps/studio — AGENTS.md

**Layer:** app (may import every `@staticflux/*` package; packages never import the app).
**Budget (R12.7):** total boot JS ≤ 150 KB gzip — currently **over** (`dist/sf-build-report.json`: ~198 KB gzip,
entry + `bootEntries: ['src/boot-browser.ts']` closure); feature chunks ≤ 50 KB counted beyond the boot set (1–6 KB
gzip each), heavy studio-desktop ≤ 200 KB after authorize.

## Purpose
The integration proof: every StaticFlux vertical composed into one real app (FEATURE-NEEDS "Studio") against mock
services only. `src/app/compose.ts` is the single place packages are wired; `src/adapters/<a>-<b>.ts` bridge the
ports of two packages; features are manifests + lazily loaded modules.

## Rules
- Features (`src/features/<name>/`) never import each other; they talk through `src/app/contracts.ts`
  (tokens, capabilities, intents, URL bindings, slices, surfaces). Shared code lives in `src/lib` / `src/ui`.
- No feature reads flags or modes: variant bindings (`OnboardingCopyToken`) and per-mode features (desktop/mobile).
- One adapter file per package pair, header comment states what it bridges; package bugs/gaps are worked around
  in the adapter with a `PACKAGE GAP` / `WORKAROUND` comment — never patched in `packages/`.
- Mock services only (`src/mocks`). No network, no real auth. Client gating is UX, not security: the mock backend
  re-checks plan/credits.
- Keep boot lean: new heavy dependencies go behind a dynamic import (`app/document.ts`, `app/late.ts`, features).
- `vite.config.ts` imports `src/app/chunks.ts` — keep that file data-only (loader `chunk()` declarations).
- Runtime import cycles fail `pnpm lint:boundaries` (dependency-cruiser); type-only cycles are fine.

## Files
See README.md (architecture map + adapter table).

## Test
`npx vitest run apps/studio` (headless, happy-dom; boots the whole app per test) ·
`npx tsc -p apps/studio` (after `npx tsc -b tsconfig.build.json`) · `cd apps/studio && npx vite build` ·
`cd apps/studio && NODE_PATH=$(npm root -g) npx playwright test -c e2e/playwright.config.cjs` (Chromium smoke).
