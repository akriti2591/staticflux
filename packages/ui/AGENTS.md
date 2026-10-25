# @staticflux/ui — AGENTS.md

**Layer:** ui (depends on `@staticflux/core`, `@staticflux/runtime`, `lit` 3.3.3, `@lit/context` 1.1.6).
**Budget:** no size-limit entry yet; the boot surface (SfElement, deps controller, MobxController,
scope element, ports) is ~6 KB gzip of tsc output (unminified). Counts toward "Total boot JS" (R12.7).

## Purpose
Lit integration: components that self-inject their declared dependencies (render / lazy /
functional) from the nearest DOM injector scope, fine-grained MobX re-rendering, one render
pass per frame, hidden-feature freezing, isolation-aware templates, render records for perf.
Implements R2.8, R2.9, LIFECYCLES §5/§5.1/§5.2 for components, R5.2 (ui part), R11.16b (ui part),
R12.13–R12.16, R12.19 (placeholders), R15.5, invariant I-11.

## Public API (by file)
- `component.ts` — `component({ tag, deps: { render, lazy, functional }, placeholder, failed, size })` → `ComponentSpec`
  (normalized `edges`); types `ComponentDeps`, `ComponentHooks` (`onInjected/onReady/onRefresh/onFailed/whileVisible`),
  `DepKey`, `DepValue`, `DepsOf`.
- `element.ts` — `SfElement<typeof spec>` (the only base class; extends LitElement): `deps`, `ready`, `componentState`,
  `wireDeps(on)` (override to register hooks), `renderPlaceholder/renderFailed`, `retry()`, `intent(...keys)`,
  `prewarm(...keys)`, `crossOrigin(url, kind)`, `measure/mutate`, `injector`, `environment`, `connectionScope`.
  `STATE_ATTR` (`sf-state`).
- `define.ts` — `defineComponent(Class, registry?)` → `Result` (SF-UI-004), `defineUiElements()`.
- `deps.ts` — `ComponentDepsController` (used by SfElement; usable on its own), `componentMachine`
  (`detached → resolving → ready | failed`), `INTENT_ATTR` (`data-sf-intent`).
- `mobx-controller.ts` — `MobxController` (track / freeze / thaw; works on plain LitElements), `createRenderTracker`.
- `scope.ts` — `<sf-scope level name .units .injector .environment ?frozen>` (`SfScopeElement`), `UiScopeController`,
  `provideScope(element, { injector, environment })`, `uiScopeContext` (ONE context key), `UiScopeHandle`.
- `ports.ts` — `RenderScheduler` (+ `frameRenderScheduler(FrameScheduler)`, `microtaskRenderScheduler`),
  `VisibilityObserver` (+ `intersectionVisibility`, `alwaysVisible`), `IsolationPolicy` (+ `createIsolationPolicy`,
  `noIsolationPolicy`), `RenderObserver` (+ `createRenderCounter`), `DecidePort` (+ `allowAllDecide`, `gateResource`),
  `UiEnvironment` (+ `createUiEnvironment`); tokens `UiEnvironmentToken`, `RenderSchedulerToken`,
  `VisibilityObserverToken`, `IsolationPolicyToken`, `RenderObserversToken` (multi), `DecideToken`.
- `directives.ts` — `sfSrc(url, kind?)` (element directive: crossorigin before src/href), `crossOriginAttr(policy, url, kind)`.
- `skeleton.ts` — `<sf-skeleton lines>` (default placeholder, aria-hidden, reduced motion).
- `events.ts` — `SfErrorEvent` (`sf-error`, bubbles+composed; caught by shell boundaries), `SfReadyEvent` (`sf-ready`).
- `units.ts` — `uiUnits`, `renderSchedulerUnit`, `visibilityObserverUnit`, `noIsolationPolicyUnit`,
  `isolationPolicyUnitWith(options)`, `allowAllDecideUnit`, `uiEnvironmentUnit`.
- `telemetry.ts` — `UI_SUBSYSTEMS` (`ui/component|scope|render`), `uiMetrics` (renders, render-duration, time-to-content).
- `errors.ts` — `SF-UI-001…007`.
- `testing.ts` (subpath `@staticflux/ui/testing`) — `mountTestRoot`, `manualVisibility`, `settle`.
- `theme.ts` (subpath `@staticflux/ui/theme`) — the **theme contract** (R13.11–R13.14):
  - `theme-tokens.ts` — `defineTokens(prefix, { group: ['name', …] })` → typed `ThemeToken`s (`property`, `ref`, `css`), `TokenValues`,
    `PartialTokenValues`, `tokenSetOf`, `tokenProperty`, `kebabCase`, `valueOf`.
  - `theme-contract.ts` — `themeTokens` (THE token set: color ramp/surfaces/text/borders/accent/semantic/focus, font, type, space
    (4 px grid), size (density), radius, shadow, motion, z), `legacyAliases` (pre-contract `--sf-*` names), types `ThemeValues`, `PartialThemeValues`.
  - `theme-contrast.ts` — `TEXT_CONTRAST_PAIRS` (4.5:1), `UI_CONTRAST_PAIRS` (3:1) for the testkit theme contract (not runtime).
  - `theme-define.ts` — `defineTheme({ id, tokens, values, dark, contrast, density, reducedMotion, aliases })`, `extendTheme(base, overrides)`,
    `validateTheme` (SF-UI-008), `resolveThemeValues`, `themeValue`, `compileTheme(theme, { selector })`, `APPEARANCE_ATTRS`, `DENSITIES`.
  - `theme-color.ts` — `parseColor`, `formatHex`, `normalizeHex`, `compositeOver`, `relativeLuminance`, `contrastRatio` (SF-UI-010).
  - `theme-appearance.ts` — `createAppearance({ themes, theme, initial, media, store })` → `theme`, `preference`, `resolved`, `set`,
    `useTheme` (SF-UI-009), `restore`, `apply(root, scope)`; `resolveAppearance`, `sanitizeAppearance`, `browserMediaQueries`, `DEFAULT_APPEARANCE`.
  - `theme-units.ts` — `ThemesToken` (multi), `AppearanceToken`, `AppearanceStoreToken`, `themeContribution(theme, { order })`,
    `appearanceUnitWith({ theme, initial, media, restore: 'init' | 'manual' })`, `appearanceUnit`.
- `default-theme.ts` (subpath `@staticflux/ui/default-theme`) — `defaultTheme` (`sf/default`: brand-neutral, WCAG 2.2 AA, light/dark,
  contrast-more, Focus/Standard/Pro, reduced motion), `defaultThemeContribution` (order −100: any app theme wins).

## Semantics to know
- Root: `<sf-scope .injector=${app} .environment=${await app.get(UiEnvironmentToken)}>` (or `provideScope`).
  Feature roots: `<sf-scope level="feature" .injector=${ctx.injector} ?frozen=${ctx.hidden}>`.
- Init timing: render deps `eager`, lazy `on-arrival`, functional `on-demand`; `on-visible` via the VisibilityObserver;
  `on-intent` pre-warms on pointerover/focusin/pointerdown of an element with `data-sf-intent=${this.intent('key')}`.
- Readiness is reactive (handle states are observables); blocking `onReady` hooks keep the placeholder.
- Updates go through the RenderScheduler (frame flush); updates requested during a flush run in the same frame
  (microtask). Before binding, Lit's microtask scheduling is used (first placeholder paint).
- Frozen scope: no renders (`shouldUpdate` false), MobX tracking dropped, `whileVisible` scopes disposed; one
  render on thaw. `content-visibility: hidden` on the scope element.
- Disconnect + reconnect within one task (moving an element) keeps the binding (microtask-deferred teardown).
- Hook scopes are children of the connection scope, itself a child of the injector scope.

## Theme semantics
- `compileTheme` emits `:root{…}` (light, standard, aliases), `@media` rules for `prefers-color-scheme` / `prefers-contrast` /
  `prefers-reduced-motion` on a root **without** `data-sf-*` attributes (pre-JS), and attribute rules (`data-sf-scheme|contrast|density|motion`)
  that `appearance.apply` keeps in sync after boot. Dark + more re-resolves every contrast key against the dark values.
- Active theme: the `theme` id option, else the last contributed theme. Brand themes: `extendTheme(defaultTheme, { id, values, dark })`
  contributed with a higher `order`; run `runThemeContract` (testkit) on them.
- Boot cost (Studio): contract + appearance + default theme ≈ 3.3 KB gzip net of the shell theme controller they replace.

## Rules
- Components extend `SfElement` only (no further inheritance); no decorators (R2.14).
- Lit reactive properties: `static properties` + `declare` fields + constructor init (useDefineForClassFields).
- Never read render deps outside `render()` before `ready` (SF-UI-001).
- MobX only through the core reactivity port.

## Test
`npx vitest run packages/ui` · `npx tsc -p packages/ui --noEmit`

<!-- sf:generated:start -->
<!-- Generated by `sf agents` from package.json and .size-limit.json. Do not edit between these markers. -->

## Budgets

| Check | Limit | Measures |
|---|---|---|
| @staticflux/ui (full, excl. lit) | 9 KB | packages/ui/dist/index.js |
| @staticflux/ui/theme (contract, appearance, units) | 6 KB | packages/ui/dist/theme.js |
| @staticflux/ui/default-theme | 2.5 KB | packages/ui/dist/default-theme.js |

Budgets ratchet (R12.8): `sf budgets` proposes tightening; raising one needs a reviewed reason.

## Allowed dependencies

**Layer:** ui

- Internal: `@staticflux/core`, `@staticflux/runtime`

Anything else is a boundary violation (`pnpm lint:boundaries`). Adding a dependency needs a reviewed reason.
<!-- sf:generated:end -->
