# apps/instaflow/src/studio — AGENTS.md

**Work package:** Instaflow M1b **B0** (IF-19.11–19.15, D17, D19), rebuilt by M1c **B11b** (IF-36). **Layer:** app.
**Depends on:** `src/spec` (registries, Studio spec, proposals), `@staticflux/shell/spec` (runtime, layout port), `kit`
(button, icon-button, segmented, tabs, tag, text-field, toolbar, dock), `ui` (`SfElement`, theme tokens), `a11y` (shortcut
registry), `surface` (input forwarder, input ring sink), `src/sequencing` (boot, behind the canvas port), `src/theme` (lens
palette). **Design:** `docs/instaflow/design/StudioCP.dc.html` (structure), `README.md` (rules).

## Purpose
The Studio shell: a frame laid out **only** from the mounted editor spec, so Studio is a spec, not a screen (D16/D19), usable
fully by hand (D17).

## Public API (by file)
- `studio.ts` — `createStudio({ registries, decideFor, spec, autonomy, reducedMotion, wait, telemetry })` → `Studio` (`port`,
  `runtime`, `proposals`, reactive `spec`, `lens`, `density`, `activeTool`; `open`, `switchLens`, `setDensity`, `setScope` (B8:
  Studio's scope follows the canvas selection; B9: spec changes run one after another, each on the spec the previous one
  left), `selectTool`,
  `togglePin`, `bindShortcuts(registry, targets, scope)`, `dispose`), `StudioShortcutScope`, `PERSON`.
- `studio-element.ts` — `<if-studio .studio .canvas .shortcuts .model .port asset-title home-href>` (`defineStudio()`, B11b):
  top bar (logo → Home, title inline rename, M1 lenses, save state → Milestones, `View ▾` zoom + density, Milestone popover,
  `⋯`, Export), tabbed dock, the canvas room (mist dots, page card + label behind the transparent canvas, tool picker with the
  shape family, `<if-hud>`, zoom pill, `<if-command-bar>`, proposal card), inspector column. `StudioChromeModel` in (mirrors),
  `StudioChromePort` out (capabilities, mirror actions, camera, export, milestone, template, copy link, page selection).
  `hudPosition` (pure pill placement), `EMPTY_CHROME`, `M1_LENSES`, `focusHud`, `focusTitle`, `focusCommandBar`,
  `focusCanvas`, `showPanel`, `canvasActive`, `studioMessages`. Event `if-navigate { href }` (the Home link, cancelable).
- `hud.ts` (B11b) — `<if-hud>`: the selection pill per kind over `studio-controls.ts` (`CONTROL_SETS`, `SECTIONS`, `CONTROL`,
  `MORE_GROUP_OF`, `MORE_EXCLUDED`); `HudPort`, `paintFromColor`, `pillCapabilities`, `moreMenuGroups`.
- `command-bar.ts` (B11b) — `<if-command-bar .sources>` (`Mod+K`; fires `if-command { value }` = `cap:` / `tool:` / `camera:`),
  `commandEntries`, `pushRecent`, `readRecentCommands`, `RECENT_LIMIT`.
- `inspector.ts` (B11b) — `<if-inspector .model .port density>`: header + the kind's sections (`InspectorModel`,
  `InspectorPort extends HudPort`, `EMPTY_INSPECTOR`, `reveal(section)`, `focusPageName()`); `inspector-model.ts` (pure:
  `INSPECTOR_SECTIONS`, `inspectorSections`, row summaries, gradient edits, dash and effect presets, blend groups, page
  presets, `PAGE_SIZE_RANGE`); `inspector-paint.ts` (fill / stroke / effect stacks, gradient editor, corners, layer);
  `inspector-text.ts` (the Text section, `TextCommands`, `WEIGHTS`); `inspector-panel.ts` (`inspectorPanel`, the spec panel
  `instaflow/inspector`); `errors.ts` (IF-POL-050 page size, IF-POL-051 no image to replace).
- `canvas.ts` — **`CanvasPort`** (`start(surface, signal) → CanvasSession { forwarded, stop }`), `sequencingCanvas({ boot, env,
  schedule })` (boots A7, forwards surface input into the editor's input ring; IF-SPEC-005 on failure).
- `hints.ts` (B11a2) — `STUDIO_HINTS` (the M1 first-use hints: frame, shape, text, hand, layers, multi-selection), `HintTargets` (typed
  coach targets to mark with `coachTarget`), `localSeenStore(localStorage)` (`instaflow/ui/hints`, memory when blocked; pass it to the
  surface manager as `seen`), `createHintSession({ manager, owner, seen, enabled })` (`offer`, `used`, `suppress`/`resume`, `reset`; two per
  session), `HINTS_PER_SESSION`, `seenKeyOf`.

## Layout rules
- Regions come from placements: `panel@side` → contextual side panel, `panel@dock` → tabbed left dock, `panel@inspector` →
  right column, `panel@tray` → bottom tray; `tool@default` → Tools toolbar; `hud@default` → HUD toolbar; `lens@default` → the
  mode switcher's value. An empty region is not rendered.
- Density collapses a region whose panels all need a higher density (`minDensity`); a panel below its density is collapsed.
  The person can open a collapsed dock (its expand button).
- Slot elements carry `data-slot`, `data-group`, `data-phase` and `--if-motion` / `--if-ease`; exiting slots are `inert`.
  Motion is CSS on transform/opacity only and is off under `prefers-reduced-motion`.
- Kit components only, theme tokens only (the canvas well is `neutral4` with a `neutral7` dot grid); lens colours and shapes from
  the typed lens palette. Strings in `studioMessages`.
- Keyboard: `1`–`5` lenses (Pages is `5`), tool letters (never while typing: the registry checks the composed origin), `Alt+Enter` HUD, `Mod+K`
  command bar, `Escape` canvas; arrows inside the toolbars, the mode switcher and the dock tabs.

## Budgets
No size entry of its own (the app chunk). The shared modules it grew carry the raises: `@instaflow/app/tools` (rotate stem),
`@instaflow/app/text` (B11b text commands), `@staticflux/kit/icons`.

## Test
`npx vitest run apps/instaflow/src/studio` — controller (spec changes, pins, keyboard), element under Clean Pop (structure vs
StudioCP, layout from spec, density, pins, proposal card, motion phases, keyboard paths, a11y audit), the
`runSpecMountPortContract` suite over the DOM, and the canvas region over the in-process A7 pipeline with the digest renderer.
B11b: `hud.test.ts`, `command-bar.test.ts`, `inspector.test.ts` (every kind audited), `inspector-model.test.ts`; the Studio smoke
drives the pill, the inspector and the command bar in both topologies.
