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
- `button` — `<sf-button>` (`variant: secondary|primary|agent|agent-soft|ghost|danger`, `size: sm|md|lg`, `disabled`, `pressed`, `type`), `defineButton`.
  `agent` hands work to an agent (`color.agent`/`onAgent`), `agent-soft` is an agent action in a toolbar (`agentSoft`/`agentInk`).
- `icon` — `<sf-icon .icon=${trash2Icon} size=16|18|24 label>` (inline SVG in `currentColor`, decorative unless `label`; `name` reflects the
  icon), `defineIcon(name, nodes, source)` (data), `IconDef`, `IconNode`, `iconElement`, `iconProblems`, `iconStrokeWidth`, `ICON_SIZES`,
  `defineIconElement`. *(B11a)*
- `icons` / `icons/<name>` — the icon set as typed values: `@staticflux/kit/icons/trash-2` → `trash2Icon` (Lucide ISC, see `src/icons/LICENSE`)
  and the custom gap icons (`booleanUnionIcon`, `maskIcon`, `skewIcon`, `pivotIcon`, `repeatRadialIcon`, …); the `icons` barrel has all.
  **Generated**: add a Lucide name to `src/icons/icons.json` or an SVG to `src/icons/custom/`, run `node packages/kit/scripts/generate-icons.mjs`
  (`--check` is what the test runs). Import single modules in boot paths. *(B11a)*
- `number-field` — `<sf-number-field label label-hidden unit .units .value mixed min max step precision wrap=angle percent-of scrub>`
  (APG spinbutton; `sf-input` live while scrubbing, `sf-change` `NumberChangeDetail { value, delta, source }` once per commit; `commitText()`,
  `restore()`, `cancelScrub()`), `parseNumberInput` (→ `Result`, SF-KIT-001), `scrubDelta`, `stepMultiplier`, `clampNumber`, `normalizeAngle`,
  `roundTo`, `formatNumberValue`, `numberScrubMachine` (`kit/number-scrub`), `defineNumberField`. *(B11a)*
- `inline-edit` — `<sf-inline-edit label .value placeholder required maxlength trigger=dblclick|click|none editing>` (`edit()`, `save()`,
  `cancel()`; `sf-edit-start`, `sf-change` `{ value, previous }`, `sf-cancel`), `validateName` (SF-KIT-002), `inlineEditMachine`
  (`kit/inline-edit`), `defineInlineEdit`. *(B11a)*
- `swatch` — `<sf-swatch color opacity unresolved size=16|24>` (decorative colour chip; hatched when unresolved), `swatchColor`,
  `swatchOpacity`, `defineSwatch`. *(B11a)*
- `icon-button` — `<sf-icon-button label shortcut>` (label = name + tooltip; `aria-keyshortcuts`), `defineIconButton`.
- `segmented` — `<sf-segmented label .options .value>` (APG radio group, `sf-change`), `SegmentOption`, `defineSegmented`.
- `text-field` — `<sf-text-field label label-hidden hint error multiline>` (`input` composed, `change` + `sf-change`), `defineTextField`.
- `slider` — `<sf-slider label min max step value unit .format>` (native range + keyboard, `sf-input`/`sf-change`; thin `neutral7` track,
  accent fill and thumb ring, `surface3` thumb, value in a mono pill, `value` slot), `snapToStep`, `sliderFill`, `defineSlider`.
- `tag` — `<sf-tag tone=neutral|agent .color .ink mono>` (non-interactive label pill: no role, not focusable; custom colour pairs are the
  caller's to test), `defineTag`.
- `status` — `<sf-status tone=neutral|success|warning|danger busy>` (non-interactive dot + muted label in a polite live region,
  `role="status"` unless set; the words carry the state; `busy` pulses, none under reduced motion), `defineStatus`. *(Instaflow B5 save state)*
- `card` — `<sf-card href label>` (content card: raised surface, hairline, `radius.lg`; with `href` the whole card is one native link with the
  focus ring, name from its text or `label`; `--kit-card-padding`, `--kit-card-gap`, `::part(card)`), `defineCard`. *(Instaflow C0 Home)*
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
- `errors` (root) — `InvalidNumberInputError` (SF-KIT-001), `InvalidNameError` (SF-KIT-002).
- root (`.`) — everything above (except the icon modules) + `kitMessages` / `kitText` (i18n), `resizeMachine` (`kit/resize`), `sizeFromDrag`, `sizeFromKey`, `clampSize`, `defineKit()`.

## Rules
- Components extend `SfElement` only; reactive properties via `static properties` + `declare` + constructor init; no decorators.
- Shapes and edges: pressable controls (button, icon button, segmented track + segments) and tags take `radius.control`; fields keep
  `radius.md`. Secondary buttons and fields draw `color.controlEdge` (≥ 3:1); `color.border` is for dividers; the segmented track
  is a borderless `neutral3` fill with a raised `surface3` selected segment. Per-size font size and inline padding come from
  `type.control*` / `size.controlPad*` (`--kit-font-size`, `--kit-pad-inline` in `controlStyles`). Focus is a 2 px `focusRing`
  outline at a 2 px offset on every control, fields included.
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
- Icons: never a text glyph or emoji as an icon; use `<sf-icon>` with a module from `./icons/` (generated; never edit by hand).

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
| @staticflux/kit/slider | 1.95 KB | packages/kit/dist/slider.js |
| @staticflux/kit/color-field | 2.25 KB | packages/kit/dist/color-field.js |
| @staticflux/kit/menu | 5.5 KB | packages/kit/dist/menu.js |
| @staticflux/kit/popover | 3.5 KB | packages/kit/dist/popover.js |
| @staticflux/kit/tooltip | 3.6 KB | packages/kit/dist/tooltip.js |
| @staticflux/kit/tabs | 3 KB | packages/kit/dist/tabs.js |
| @staticflux/kit/surfaces | 8.25 KB | packages/kit/dist/surfaces.js |
| @staticflux/kit/surface-defs | 0.5 KB | packages/kit/dist/surface-defs.js |
| @staticflux/kit/toolbar | 2.5 KB | packages/kit/dist/toolbar.js |
| @staticflux/kit/dock (raised 7 → 7.6 KB by B11a: chevrons are <sf-icon> + Lucide modules, no text glyphs) | 7.6 KB | packages/kit/dist/dock.js |
| @staticflux/kit/inspector (raised 1.85 → 2.65 KB by B11a: the group chevron is <sf-icon>) | 2.65 KB | packages/kit/dist/inspector.js |
| @staticflux/kit/tree (raised 4.4 → 5.1 KB by B11a: the twisty is <sf-icon>) | 5.1 KB | packages/kit/dist/tree.js |
| @staticflux/kit/command-palette | 3.6 KB | packages/kit/dist/command-palette.js |
| @staticflux/kit/roving | 1.25 KB | packages/kit/dist/roving.js |
| @staticflux/kit/position | 1.5 KB | packages/kit/dist/position.js |
| @staticflux/kit (full, excl. lit + framework; raised 22.5 → 22.6 KB by C0: the new card component; 22.6 → 27.5 KB by B11a: icon element, number field, inline edit, swatch) | 27.5 KB | packages/kit/dist/index.js |
| @staticflux/kit/tag | 1.1 KB | packages/kit/dist/tag.js |
| @staticflux/kit/status | 1.1 KB | packages/kit/dist/status.js |
| @staticflux/kit/card | 1.1 KB | packages/kit/dist/card.js |
| @staticflux/kit/icon (<sf-icon> + icon data helpers; B11a) | 1.65 KB | packages/kit/dist/icon.js |
| @staticflux/kit/icons (the whole kit icon set: 89 Lucide + 15 custom; well under STUDIO-UX-SPEC §10.2's 20 KB cap for Studio's set; B11a) | 5 KB | packages/kit/dist/icons/index.js |
| @staticflux/kit/icons/trash-2 (one icon module ≈ 0.2 KB, STUDIO-UX-SPEC §10.2; B11a) | 0.3 KB | packages/kit/dist/icons/trash-2.js |
| @staticflux/kit/number-field (<sf-number-field>: expressions, units, scrub, mixed; B11a) | 4.8 KB | packages/kit/dist/number-field.js |
| @staticflux/kit/inline-edit (<sf-inline-edit>; B11a) | 2.75 KB | packages/kit/dist/inline-edit.js |
| @staticflux/kit/swatch (<sf-swatch>; B11a) | 1.3 KB | packages/kit/dist/swatch.js |

Budgets ratchet (R12.8): `sf budgets` proposes tightening; raising one needs a reviewed reason.

## Allowed dependencies

**Layer:** ui

- Internal: `@staticflux/a11y`, `@staticflux/capabilities`, `@staticflux/core`, `@staticflux/i18n`, `@staticflux/messaging`, `@staticflux/ui`

Anything else is a boundary violation (`pnpm lint:boundaries`). Adding a dependency needs a reviewed reason.
<!-- sf:generated:end -->
