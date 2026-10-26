# apps/instaflow/src/studio — AGENTS.md

**Work package:** Instaflow M1b **B0** (IF-19.11–19.15, D17, D19). **Layer:** app.
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
- `studio-element.ts` — `<if-studio .studio .canvas .shortcuts asset-title project-title home-href>` (`defineStudio()`):
  top bar (home, breadcrumb, lens mode switcher with lens shapes, Saved, agent chip, density, Milestone, Save as template (C0), Share), side panel,
  tabbed dock, canvas region (tools toolbar, HUD toolbar, canvas surface, zoom, command bar, proposal card), inspector, tray.
  Events: `if-hud-action { action }`, `if-intent { intent: zoom-in | zoom-out | milestone | save-template | share }`, `if-command { text }`,
  `if-navigate { href }` (C0: the Home link, cancelable — a host that cancels it saves, then navigates; modified clicks stay the browser's).
  B8: `.status` (the top bar's save state, B5's `<if-save-status>`), `zoom` (the readout), tone `more` HUD actions in one
  `<sf-menu>` "More actions", the HUD capped at two rows, the tools pill sized by its item count, the surface positioned for
  the canvas layers.
  `focusHud`, `focusCommandBar`, `focusCanvas`, `canvasActive`. `studioMessages`.
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

## Test
`npx vitest run apps/instaflow/src/studio` — controller (spec changes, pins, keyboard), element under Clean Pop (structure vs
StudioCP, layout from spec, density, pins, proposal card, motion phases, keyboard paths, a11y audit), the
`runSpecMountPortContract` suite over the DOM, and the canvas region over the in-process A7 pipeline with the digest renderer.
