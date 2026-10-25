# apps/studio — AGENTS.md

**Layer:** app (may import every `@staticflux/*` package; packages never import the app).
**Budget (R12.7):** total boot JS ≤ 150 KB gzip — **149.1 KB** (`dist/sf-build-report.json`, entry +
`bootEntries: ['src/boot-browser.ts']` closure; was 198 KB, then 145.8 KB before the theme contract, see README "Bundle budget");
CI fails the build on a regression. Feature chunks ≤ 50 KB counted beyond the boot set (1.5–6 KB gzip each), heavy studio-desktop ≤ 200 KB
after authorize (19 KB).

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
- Keep boot lean: new heavy dependencies go behind a dynamic import (`app/document.ts`, `app/late.ts`, features) or a
  deferred unit group (`app/deferred.ts` + `app/deferred/<group>.ts`, core `deferredUnits`). Boot code names deferred
  tokens only from token-only modules (`contracts.ts`, packages' `tokens.ts`): a module that boot uses is bundled whole.
  Boot units consume deferred services through lazy (`init: 'on-demand'`) or functional deps.
- `build/boot-chunk.ts` merges the boot closure into one chunk; after changing boot wiring check `npx vite build`
  (`boot: * … KB`) and that the boot set holds no lazy-only modules.
- `vite.config.ts` imports `src/app/chunks.ts` — keep that file data-only (loader `chunk()` declarations).
- Runtime import cycles fail `pnpm lint:boundaries` (dependency-cruiser); type-only cycles are fine.

## UI kit and theme
- Every control is a `@staticflux/kit` component (`sf-button`, `sf-text-field`, `sf-segmented`, `sf-tabs`, `sf-toolbar`, …); no native
  `<button>/<input>/<select>/<textarea>` in app code. Styles use `themeTokens` (`@staticflux/ui/theme`), never literal colors or px
  spacing; the theme is the default theme contribution + `appearanceUnitWith({ restore: 'manual' })` (restored post-boot).
- Boot modules import no kit element code: app views lazy-load `ui/controls.ts` (elements upgrade in place, `:not(:defined)`
  styles keep their size); surfaces only boot needs are declared next to their adapter (`runtime-messaging.ts`), not in
  `app/surfaces.ts` (which imports `@staticflux/kit/surface-defs`).
- Surfaces render in `<sf-surface-layer>` (kit) from the deferred surfaces chunk; `Mod+K` is the kit capability palette
  (`deferred/keyboard.ts` binds it as `CommandShortcutBindingsToken`).

## Files
See README.md (architecture map + adapter table).

## Test
`npx vitest run apps/studio` (headless, happy-dom; boots the whole app per test) ·
`npx tsc -p apps/studio` (after `npx tsc -b tsconfig.build.json`) · `cd apps/studio && npx vite build` ·
`cd apps/studio && NODE_PATH=$(npm root -g) npx playwright test -c e2e/playwright.config.cjs` (Chromium smoke).
