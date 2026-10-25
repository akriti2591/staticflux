# apps/instaflow/src/a11y — AGENTS.md

**Work package:** Instaflow M1b **B6** (accessibility layer; IF-7.12, IF-25.1–25.27, LIFECYCLES §26, `IF-A11Y-001…003`).
**Layer:** app. **Export:** `@instaflow/app/a11y` (projection and announcer: editor side, no DOM; `dom.ts`: main thread).
**Depends on:** `@staticflux/core` (Result, machines, `watch`, scopes), `surface` (`createAccessibleLayer`, `AccessibleNode`,
R11.60–R11.62), `a11y` (`Announcer`, `Timers` types), `capabilities`, `ui/theme` (focus-ring token), `document` types; B3's
`../tools` (element index, view state, `canvasSelectable`), B1's `../elements` (bounds, resolve, `P`), B7's `../repeat`
(instance resolution, `instanceCount`), B2's `../text` (`SEMANTIC_TEXT_ROLES`, `readTextBlock`), B0's `../spec` (HUD action).
Tests also use `fast-check`, `happy-dom`, `@staticflux/testkit/a11y`, the Studio element and the real authoring Wasm (skipped
when not built).
**Budget:** `.size-limit.json` — `@instaflow/app/a11y` 16 KB brotli (measured 15.6 KB incl. the B1/B3/B7/B2 modules it reads;
framework excluded).

## Purpose
What assistive technology sees of a canvas drawn on the GPU: a **virtualized DOM projection** (only elements in or near the
view get nodes; reading order = document tree; names and roles from tables), a **focus path** that follows B3's selection
and entered container with the same keys, **polite selection announcements** that stay quiet during drags, and the
`describe-canvas` capability. Headless services plus B0 contributions; no screen layout (the layer lives inside Studio's
canvas surface).

## Public API (by file)
- `roles.ts` — `ELEMENT_A11Y_ROLES` (kind → role + description), `KIND_SHAPE_DESCRIPTIONS`, `DEFAULT_SHAPE`,
  `REPEAT_DESCRIPTIONS`, `SEMANTIC_A11Y_ROLES` (from B2's `SEMANTIC_TEXT_ROLES`, headings only), `DEFAULT_A11Y_ROLE`,
  `a11yRoleOf(kind, shape, semantic, repeat)`.
- `projection.ts` — `ProjectionInput { ctx, index, view, text?, instances?, margin? }`, **`projectCanvas(input)`** →
  `CanvasSnapshot { root, label, nodes, ids, focus, region }` (IF-A11Y-001), `describeElement`, `focusTargetOf`, `sourceOf`,
  `instanceOf`, `visibleRegion`, `hasOwnBounds`, `PROJECTION_MARGIN`; **`createCanvasProjector({ …input, schedule, scope })`**
  → `state`, `snapshot`, `flush`, `onChange`, `stats`, `dispose` (IF-A11Y-002); machine `CanvasProjectionLifecycle`
  (`instaflow/a11y-projection`). Ports `InstanceSource` (B7's repeat view) and `TextSource`.
- `announce.ts` — `selectionMessage(view, describe, contextChanged)`, **`createSelectionAnnouncer({ view, describe, announcer,
  timers, busy, debounceMs, scope })`**, `ANNOUNCE_DEBOUNCE_MS`, machine `SelectionAnnounceLifecycle` (`instaflow/a11y-announce`).
- `dom.ts` (main thread) — **`mountCanvasA11y({ host, document, onFocusNode })`** → `layer`, `focused`, `apply(snapshot)`,
  `dispose`; `CANVAS_FOCUS_RING`.
- `canvas-a11y.ts` — **`createCanvasA11y(options)`** (projector + mount + announcer for one tab in one realm; re-exports `describe.ts`).
- `editor-side.ts` — **`createCanvasA11yEditor(options)`** (the editor-side half: projector, announcer, `describe`; no DOM — B9's
  editor worker posts its snapshots to main, where `mountCanvasA11y` applies them).
- `describe.ts` — `describeCanvas(input, 'selection' | 'visible')`, `DESCRIBE_TARGETS`, `DESCRIBE_MAX_ITEMS` (DOM-free).
- `text-source.ts` — `partTextSource(part)` (B2 → B6: plain text of text elements).
- `contributions.ts` — `describeCanvasCapability` (`instaflow/describe-canvas`), `a11yCapabilityImplementations(env)`,
  `describeHudAction` ("Describe", tone `more`), `a11yContributionUnits(env)`.
- `messages.ts` — `a11yMessages` (every string), `NAME_MAX_CHARS`.
- `errors.ts` — `IF-A11Y-001` root not on the stage · `002` used after dispose · `003` no open canvas.

## Wiring (per tab)
```ts
// colocated: B3's ToolSession pieces + the canvas surface element Studio hands its CanvasPort
const a11y = createCanvasA11y({ ctx, index, view, instances: repeatView, text: partTextSource(part), host: surface,
  document, announcer, timers: env.timers, gesture: controller, schedule: requestAnimationFrame, scope: tabScope });
units.push(...a11yContributionUnits({ canvas: () => a11y }));
// split topology: createCanvasProjector in the editor worker → post snapshots → mountCanvasA11y(...).apply on main
```

## Rules
- No branch on mode, lens or kind in code paths: roles, shapes, repeat kinds and semantic roles are table rows.
- Derived repeat instances never get nodes; map any view id through `sourceOf` before using it as a DOM id.
- One tab stop at most inside the canvas (roving tabindex); the layer never handles keys itself (B3's shortcuts do).
- Never move focus unless the canvas already has it; never send announced text anywhere but the live region.
- Colours only from the theme (the focus ring is `color.focusRing`); strings only in `messages.ts`.
- Every new Instaflow custom element must run the full audit under Clean Pop in its test (`chrome.test.ts` guards it).

## Test
`pnpm vitest run apps/instaflow/src/a11y` (needs `pnpm build` for the Wasm-backed suites): roles and region (data), the
projection (names, roles, order, virtualization, focus path, repeats, fast-check against a brute-force reference under
random edits and camera moves, coalescing, errors), the announcer (debounce, gestures), the DOM mount (focus path, keys,
focus ring, audit), the full keyboard path over B3's shortcut registry, the capability, the chrome audit guard and theme
facts, and the Studio frame with the layer mounted.
