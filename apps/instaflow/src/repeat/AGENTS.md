# apps/instaflow/src/repeat — AGENTS.md

**Work package:** Instaflow M1b **B7** (repeat; IF-26.1–26.27, LIFECYCLES §27, `IF-REP-001…005`). **Layer:** app.
**Exports:** `@instaflow/app/repeat` (editor worker, plus contributions) and `@instaflow/app/repeat/panel` (the Repeat
inspector element, main thread).
**Depends on:** `@staticflux/core`, `document` (`v2`, `spatial-index` types), `stage` (types, session layer), `capabilities`,
`ui` / `ui/theme` and `kit` (panel only), `lit`; B1's `../elements` (components, resolve, layout, actions, projection) and
B0's `../spec` (contribution types, `StudioIds`). Tests also use `fast-check`, `@staticflux/testkit/a11y`,
`@staticflux/ui/testing`, the theme and the real authoring Wasm (skipped when not built).
**Budgets:** `.size-limit.json` — `repeat` entry 17.5 KB brotli (includes the B1 element code it pulls in; framework
excluded), `repeat/panel` 4.5 KB.

## Purpose
Illustrator-style **live, non-destructive repeats** (radial, grid, mirror) over one or more source elements, as headless
services plus B0 contributions. Instances are **derived in a view over the stage**, never stored: the B1 render projection,
bounds, booleans, masks and hit tests read the view and see instances like any element. Expand turns a repeat into real
elements in one undo step with deterministic match keys. No screen layout; B3 owns the hit-testing UI, smart guides and the
handle overlay (it uses `hitInstance`, `instanceBounds`, `repeatHandles`, `beginHandleDrag`).

## Public API (by file)
- `components.ts` — the `repeat` component (`Repeat`; `kind`, radial `count radius startAngle sweep rotate`, grid `rows columns
  gapX gapY rowOffset columnOffset brick brickShift`, mirror `axis angle offset`), `REPEAT_KINDS`, `BRICK_AXES`, `MIRROR_AXES`,
  `REPEAT_DEFAULTS`, paths `RP`, `REPEAT_PATHS`, `REPEAT_KIND_PARAMS`, `REPEAT_COMPONENTS`, **`REPEAT_KIND_COMPONENTS`** (merge
  into `createElementRegistry({ components, kinds })`), id separators `INSTANCE_SEPARATOR` (`~`), `COPY_SEPARATOR` (`^`).
- `params.ts` — `RepeatParams` (`RadialParams | GridParams | MirrorParams`), `RepeatPatch`, `REPEAT_LIMITS`, `readRepeat`,
  `defaultParams`, `instanceCount`, `repeatOps`, `patchOps`, `clearRepeatOps`, `applyPatch`, `checkRepeatValue` /
  `validateRepeatOps` (IF-REP-001, IF-REP-002).
- `instances.ts` — `Placement` (wrapper spatial values), `instancePlacements(params, content)`, `placementTransform`,
  `radialCenter`, `radialStep`, `mirrorAxis`, `IDENTITY_PLACEMENT`.
- `stage.ts` — **`createRepeatStage({ stage, geometry, kit, scope })`** → `RepeatStage` (a `Pick<Stage, read children value explain
  lockOf checkWrite onInvalidate>` plus `params`, `layout`, `isDerived`, `resolveInstance` → `InstanceRef { source, index, path,
  derived, wrapper }`, `sourceChildren`, `base`, `dispose`); `wrapperId`, `copyId`, `instanceKey`, `wrapperProps`.
- `actions.ts` — `RepeatContext` (B1's `ActionContext` over the view), `makeRepeat`, `setRepeat`, `releaseRepeat`,
  **`expandRepeat`** (`{ ops, instances }`), `liveRepeat`, `newRepeatParams`, **`commitRepeatEdit`** (one change set).
- `hit.ts` — `hitInstance(ctx, node, x, y, tolerance)` → `InstanceHit` (source + instance index + path), `instanceBounds`.
- `handles.ts` — `REPEAT_HANDLE_IDS`, `repeatHandles(ctx, node)` (page positions, directions), `handlePatch`,
  `beginHandleDrag(env, node, handle, { signal })` → `HandleDrag` (`move`, `commit`, `cancel`, `state`), machine
  `RepeatHandleDragLifecycle` (`instaflow/repeat-handle-drag`).
- `inspector.ts` — `repeatModel(ctx, node)` → `RepeatModel`, `RepeatEdit`, `repeatEditOps`.
- `contributions.ts` — `REPEAT_ACTIONS`, `repeatCapabilities` (`instaflow/repeat-radial | -grid | -mirror | -edit | -expand |
  -release`), `repeatCapabilityImplementations(env)`, `runRepeatAction`, `repeatHudActions`, `repeatPanel` (`instaflow/repeat`),
  `repeatContributionUnits(env)`, `repeatSelectionFacts`.
- `panel.ts` (entry `repeat/panel`) — `<if-repeat-inspector>` (`IfRepeatInspectorElement`), `defineRepeatInspector`,
  `bindRepeatInspector(element, source)`, `REPEAT_EDIT_EVENT`.
- `errors.ts` — `IF-REP-001` parameter · `002` too many instances · `003` not applicable · `004` derived instance · `005` handle
  drag.
- `testing/` (test-only) — `createRepeatFixture(geometry, ops)` (B1's page fixture + the view), `renderTree` (canonical
  projected tree), `keyTree`.

## Wiring (editor worker)
```ts
const registry = createElementRegistry({ components: [...REPEAT_COMPONENTS], kinds: REPEAT_KIND_COMPONENTS });
const view = createRepeatStage({ stage, geometry, kit, scope });           // over B1's stage
const source = createElementRenderSource({ stage: view, geometry, kit, root: pageId, orderOf });   // instead of `stage`
const ctx: RepeatContext = { stage: view, geometry, kit, newId };           // B1 actions may use it too
const target = { undo, stage: view, part: pageId };                        // view.checkWrite refuses derived ids
units.push(...repeatContributionUnits({ context: () => ctx, target: () => target, actorFor }));
```

## Rules
- Instances are derived: never write a copy or a wrapper into the document (the view refuses it, IF-REP-004). Edit the
  source (`resolveInstance(id).source`) or the parameters.
- Instance 0 is always the identity; placements are the wrapper's spatial values, shared by the view and expand, so live and
  expanded render the same. Change `wrapperProps` / `instancePlacements` together and keep the expand-equals-live property green.
- Match keys of instances are `key~k`; never derive them from node ids (except `lk_<id>` for keyless sources, as B1 does).
- Every operation goes through `commitRepeatEdit` (or the capability) as one change set; handle drags preview in the session
  layer only and commit once.
- No `if` on lens, mode or flags: generators, handles, brick shifts and mirror axes are variant tables.
- Panel UI only from kit components under the theme; no colours in code.

## Test
`npx vitest run apps/instaflow/src/repeat` (needs `pnpm build` for the Wasm-backed suites): params and placements (fast-check:
instance count matches parameters, instance 0 identity, radial copies on the circle), the view (structure, nesting, locks,
invalidation, the count property), actions (one undo step, incremental projection, booleans and masks, expand → render equals
live and keys stable across re-expand as properties), hit queries, handles and drags, panel (a11y), contributions.
