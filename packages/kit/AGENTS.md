# @staticflux/kit — AGENTS.md

**Layer:** ui (depends on `@staticflux/core`, `@staticflux/ui` (+ `/theme`), `@staticflux/messaging`, `@staticflux/a11y`,
`@staticflux/i18n`, `@staticflux/capabilities`, `lit` 3.3.3). Same layer as messaging: the kit *renders* messaging's
surfaces, it never replaces the manager. Never import `@staticflux/shell` (higher layer) or apps.
**Budget:** one size-limit entry per component entry point (lit + framework packages excluded), plus the full surface
(≈ 21 KB brotli). Load components where they are used; boot paths import single entries or lazy-load them.

## Purpose
Themed Lit components on `SfElement` for framework apps (Studio, Instaflow): controls, overlays, shell parts and the
capability command palette. Every value is a theme-contract token (`themeTokens` from `@staticflux/ui/theme`), so
themes, density (Focus / Standard / Pro), contrast and reduced motion restyle everything. Implements R13.15–R13.20.

## Public API (entry point → exports)
- `button` — `<sf-button>` (`variant: secondary|primary|ghost|danger`, `size: sm|md|lg`, `disabled`, `pressed`, `type`), `defineButton`.
- `icon-button` — `<sf-icon-button label shortcut>` (label = name + tooltip; `aria-keyshortcuts`), `defineIconButton`.
- `segmented` — `<sf-segmented label .options .value>` (APG radio group, `sf-change`), `SegmentOption`, `defineSegmented`.
- `text-field` — `<sf-text-field label label-hidden hint error multiline>` (`input` composed, `change` + `sf-change`), `defineTextField`.
- `slider` — `<sf-slider label min max step value unit .format>` (native range, `sf-input`/`sf-change`), `snapToStep`, `defineSlider`.
- `color-field` — `<sf-color-field label value>` (hex + native picker, validates via ui `normalizeHex`), `pickerValue`, `defineColorField`.
- `popover` — `<sf-popover label side align .anchor>` (`trigger` slot; non-modal dialog; `sf-toggle`), `firstFocusable`, `definePopover`.
- `tooltip` — `<sf-tooltip text shortcut side>` (light-DOM `role=tooltip`, `aria-describedby` on the anchor), `defineTooltip`.
- `menu` — `<sf-menu label>` + `<sf-menu-item value type=item|checkbox|radio shortcut>` (APG menu button, `sf-select`), `typeaheadIndex`, `defineMenu`.
- `tabs` — `<sf-tabs label value activation=auto|manual orientation>` + `<sf-tab value>` + `<sf-tab-panel value>` (`sf-change`), `defineTabs`.
- `surfaces` — `<sf-surface-layer>` (renders messaging's `SurfaceManager`: native `<dialog>` modals, Popover-API toasts and anchored
  surfaces), `<sf-dialog heading>` frame, `<sf-toast tone>`, `supportsModalDialog`, `isBackdropClick`, `defineSurfaces`; re-exports `surface-defs`.
- `surface-defs` — `defineDialogSurface({ title, body, actions, … })`, `defineToastSurface({ message, tone, action, … })` (data only: no element code).
- `toolbar` — `<sf-toolbar label orientation>` (APG toolbar, roving focus, container-query overflow), `toolbarItems`, `TOOLBAR_CONTROLS`, `defineToolbar`.
- `dock` — `<sf-dock side label size min max collapsed>` (window splitter, rail; `sf-resize`, `sf-collapse`) + `<sf-panel label collapsed resizable size>` (`sf-toggle`, `sf-resize`), `defineDock`.
- `inspector` — `<sf-inspector-group label collapsed>` + `<sf-inspector-row label hint>`, `nameControl`, `defineInspector`.
- `tree` — `<sf-tree label .nodes .expanded .selected multiselect .canDrop row-height>` (virtualized, APG tree, Alt+↑/↓ reorder, drag hooks;
  `sf-select`, `sf-toggle`, `sf-activate`, `sf-reorder`, `sf-drag-start`), `flattenTree`, `visibleRange`, `dropPositionAt`, `isInSubtree`,
  `findNode`, `treeDragMachine` (`kit/tree-drag`), types `TreeNode`, `TreeRow`, `ReorderDetail`, `CanDrop`.
- `command-palette` — `<sf-capability-palette>` (render dep `CapabilityRegistryToken`), `fuzzyScore`, `isPaletteRunnable`, `paletteEntries`,
  `CapabilityShortcutsToken` + `capabilityShortcut(cap, keys)`, `capabilityPaletteSurface`, `CapabilityPaletteShortcut` (`Mod+K`),
  `openCapabilityPalette`, `bindCapabilityPalette`, `bindCapabilityShortcuts`.
- `roving` — `rovingNextIndex`, `RovingFocusController`, `isRovingDisabled`, `isTextEditing`.
- `position` — `computePosition`, `anchorFloating` (CSS anchor positioning or JS fallback), `supportsAnchorPositioning`, `positionArea`.
- root (`.`) — everything above + `kitMessages` / `kitText` (i18n), `resizeMachine` (`kit/resize`), `sizeFromDrag`, `sizeFromKey`, `clampSize`, `defineKit()`.

## Rules
- Components extend `SfElement` only; reactive properties via `static properties` + `declare` + constructor init; no decorators.
- Styles use theme tokens only (`t.color.text.css`), logical properties only, motion on compositor properties via `motion.*` tokens
  (0 under reduced motion); add a `forced-colors` rule for any state shown by color alone.
- ARIA ids never cross a shadow boundary: label/describe inside one root, or put roles on hosts / light-DOM children
  (tabs, menu items, tooltip text). Check with `@staticflux/testkit/a11y` (`expectNoA11yIssues`) in every component test.
- Overlays: `popover="manual"` + `lightDismiss` (identical with and without the Popover API); place with `anchorFloating`.
  Feature-level dialogs/toasts/banners/coach marks go through the messaging `SurfaceManager`, never through kit elements directly.
- Every listener has a signal (`ConnectedListeners`, `{ signal }`); timers are cleared on disconnect.
- Shared internals are small single-purpose modules (`internal/*.ts`): bundlers place whole modules, so a broad helper module
  shared by a boot entry and a lazy entry ends up in boot.
- Kit strings: add to `kitMessages`; props override them.

## Test
`npx vitest run packages/kit` · `npx tsc -p packages/kit --noEmit` (after `npx tsc -b packages/ui packages/messaging`)

<!-- sf:generated:start -->
<!-- Generated by `sf agents` from package.json and .size-limit.json. Do not edit between these markers. -->

## Budgets

| Check | Limit | Measures |
|---|---|---|
| @staticflux/kit/button | 1.75 KB | packages/kit/dist/button.js |
| @staticflux/kit/icon-button | 4.5 KB | packages/kit/dist/icon-button.js |
| @staticflux/kit/segmented | 2.75 KB | packages/kit/dist/segmented.js |
| @staticflux/kit/text-field | 2 KB | packages/kit/dist/text-field.js |
| @staticflux/kit/slider | 1.6 KB | packages/kit/dist/slider.js |
| @staticflux/kit/color-field | 2.25 KB | packages/kit/dist/color-field.js |
| @staticflux/kit/menu | 5.5 KB | packages/kit/dist/menu.js |
| @staticflux/kit/popover | 3.5 KB | packages/kit/dist/popover.js |
| @staticflux/kit/tooltip | 3.6 KB | packages/kit/dist/tooltip.js |
| @staticflux/kit/tabs | 3 KB | packages/kit/dist/tabs.js |
| @staticflux/kit/surfaces | 8.25 KB | packages/kit/dist/surfaces.js |
| @staticflux/kit/surface-defs | 0.5 KB | packages/kit/dist/surface-defs.js |
| @staticflux/kit/toolbar | 2.5 KB | packages/kit/dist/toolbar.js |
| @staticflux/kit/dock | 7 KB | packages/kit/dist/dock.js |
| @staticflux/kit/inspector | 1.85 KB | packages/kit/dist/inspector.js |
| @staticflux/kit/tree | 4.4 KB | packages/kit/dist/tree.js |
| @staticflux/kit/command-palette | 3.6 KB | packages/kit/dist/command-palette.js |
| @staticflux/kit/roving | 1.25 KB | packages/kit/dist/roving.js |
| @staticflux/kit/position | 1.5 KB | packages/kit/dist/position.js |
| @staticflux/kit (full, excl. lit + framework) | 22.5 KB | packages/kit/dist/index.js |

Budgets ratchet (R12.8): `sf budgets` proposes tightening; raising one needs a reviewed reason.

## Allowed dependencies

**Layer:** ui

- Internal: `@staticflux/a11y`, `@staticflux/capabilities`, `@staticflux/core`, `@staticflux/i18n`, `@staticflux/messaging`, `@staticflux/ui`

Anything else is a boundary violation (`pnpm lint:boundaries`). Adding a dependency needs a reviewed reason.
<!-- sf:generated:end -->
