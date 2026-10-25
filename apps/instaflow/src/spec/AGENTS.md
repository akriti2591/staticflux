# apps/instaflow/src/spec — AGENTS.md

**Work package:** Instaflow M1b **B0** (D16–D19, IF-19.1–19.15). **Layer:** app.
**Depends on:** `@staticflux/shell/spec` (the generic spec runtime, R13.25–R13.30), `capabilities` (schema DSL, capability
declarations), `gate` (decide adapter), `ui` (`GateResource`, `DecidePort`), `a11y` (`KeyCombo`), `core`; `lit` for
placeholder panel bodies; tests use `@staticflux/testkit` (`recordingSpecPort`, injector).
**Budget:** data plus the proposals service; it ships in Studio's chunk (the app build budget lands with C0/C4).

## Purpose
Editors are compositions (D16): an `EditorSpec` selects a lens, a scope and registered tools, panels, HUD actions and
capabilities. Every M1b package delivers **headless services plus contributions** here and never builds its own layout.
The generic machinery (validation, gating, diff, motion, pins) is the framework's; this module is Instaflow's vocabulary,
schema, Studio spec and the proposal pipeline.

## Public API (by file)
- `contributions.ts` — **`LensContribution`** (`palette` = theme lens, `shortcut`, `scopes`), **`ToolContribution`** (`glyph`,
  `shortcut`, `lenses`, `scopes`), **`PanelContribution`** (`placements`, `minDensity`, `render(context)`), **`HudActionContribution`**
  (`tone: direct | agent | more`, `capability`); `defineLens/Tool/Panel/HudAction`; multi tokens `LensContributionsToken`,
  `ToolContributionsToken`, `PanelContributionsToken`, `HudActionContributionsToken`; unit helpers `lensContribution(item)`,
  `toolContribution`, `panelContribution`, `hudActionContribution`; `DENSITIES`, `DENSITY_RANK`, `SCOPE_KINDS`, `PANEL_PLACEMENTS`
  (`side | dock | inspector | tray`), `HUD_TONES`.
- `schema.ts` — **`EditorSpec`** `{ id, label, lens, scope: ScopeRef, tools, panels: { panel, dock }[], hud, capabilities, density,
  pinned }`, `EditorSpecSchema` / `editorSpecJsonSchema` (agents), `parseEditorSpec(value)` (IF-SPEC-001), `defineEditorSpec`,
  `SCOPE_FIELDS` (required fields per scope kind).
- `registries.ts` — `createEditorRegistries({ lenses, tools, panels, hud, capabilities })` → `EditorRegistries` (`vocabulary`,
  lookups; IF-SPEC-002), `EDITOR_SECTIONS` / `EditorSection` (`lens` one, `tool`/`panel`/`hud` pinnable, `capability`),
  `toShellSpec(spec)` (context `{ lens, scope, density }`), `slotOf(section, id)`, `DEFAULT_DENSITY` (`focus`).
- `gate.ts` — `gateSpecDecide(gate, subject)`: the `DecidePort` over `@staticflux/gate` per subject (`principal` | `agent`).
- `capabilities.ts` — `proposeSpecCapability` (`instaflow/propose-spec`, the agent seam; input `{ spec, reason }`),
  `editDocumentCapability` (`instaflow/edit-document`), `PROPOSAL_STATES`.
- `proposals.ts` — `createSpecProposals({ runtime, decideFor, autonomy })` → `propose(spec, source, { reason, signal })`,
  `pull(proposer)`, `current`, `pending`, `history`, `autonomy` / `setAutonomy`, `capability` (implementation); `SpecProposal`
  (`state`, `preview`, `applied`, `error`, `open`, `decline`); `PROPOSAL_ROUTES` (source × autonomy → preview | mount),
  `PROPOSAL_SUBJECTS`, `AUTONOMY_MODES`; the **`SpecProposer`** port + `SpecProposerToken`; machine `SpecProposalLifecycle`
  (`instaflow/spec-proposal`, LIFECYCLES §20).
- `studio-contributions.ts` — `StudioIds` (stable ids), `studioLenses` (Canvas, Pixel, Timeline, Flow; `1`–`4`; Pages `5`, whose feature and panel are B4's `src/lenses`), `studioTools`,
  `studioPanels` (placeholders: Chat, Layers, Pages, Assets, Milestones, Brand, Properties, Adjust), `studioHudActions`;
  B8 added the ids Studio places for M1b (`panel.milestones | appearance | repeat`, `selectionHud.*` by feature).
- `studio-spec.ts` — **`studioSpec`** (D19, the maximal spec), `studioSpecFor(lens, base)` (uses the base's scope), variant
  tables `STUDIO_LENS_TOOLS`, `STUDIO_LENS_HUD`, `STUDIO_LENS_PANELS`, `STUDIO_PANELS`, `STUDIO_CAPABILITIES`, and (B8) the
  scope tables `STUDIO_SCOPE_HUD` / `STUDIO_SCOPE_PANELS` (what a selection adds). The HUD row has no More slot: tone
  `more` actions share one menu. A spec names at most 48 HUD actions (B8, was 12).
- `examples/pixel-touchup.ts` — `pixelTouchUpSpec(nodes)` (the example mini editor).
- `units.ts` — `EditorRegistriesToken`, `editorRegistriesUnit`, `studioContributionUnits`.
- `errors.ts` — `IF-SPEC-001` schema · `002` registry · `003` proposal state · `004` proposer failed · `005` canvas start.
  Slot problems are the framework's SF-SHELL-009…013 issues.
- `testing/` (test-only) — `scriptedProposer(turns, source)`, `fixtures.ts` (`studioRegistries({ gated })`, `editorGate(plan)`).

## Contributing from another work package (B1–B6)
Define your contribution with the `define*` helper and contribute it with the unit helper; reuse a `StudioIds` id to replace a
placeholder (Layers, Properties, …). Declare applicability with `lenses` / `scopes`, gating with `gate`, never with code. Add
capabilities with `capabilityDeclarationUnit`; a spec may name only declared capabilities.

## Rules
- Specs are data: no functions, no ids invented at runtime; presets use `defineEditorSpec`, untrusted input `parseEditorSpec`.
- No branch on mode, lens, source or autonomy: use the variant tables (`STUDIO_LENS_*`, `PROPOSAL_ROUTES`).
- Agent specs are decided as the agent (`decideFor('agent')`); never pass the principal's port for an agent proposal.
- Hand-driven changes (mode switch, density, pins) go through `propose(…, person)` too, so there is one pipeline.

## Test
`npx vitest run apps/instaflow/src/spec` (schema, registries, Studio and example specs, gating through a real gate,
proposals with a scripted proposer, the capability seam).
