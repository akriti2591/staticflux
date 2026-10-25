# apps/instaflow/src/versioning — AGENTS.md

**Work package:** Instaflow M1 **B5 Versioning** (D2, D9, D10; IF-5.1–5.11; IF-22.1–22.16). **Layer:** app.
**Entry points:** `@instaflow/app/versioning` (headless services; run next to the `DocumentRepo`, editor worker or main
thread) and `@instaflow/app/versioning/ui` (the contributions; main thread only).
**Depends on:** `@staticflux/document/v2` (repo, store port, canonical parts), `@staticflux/stage` (actors; slot marks go
through the undo service), `@staticflux/capabilities` (the command), `@staticflux/kit` + `@staticflux/ui` + `@staticflux/i18n`
(UI), `@staticflux/core`. Tests also use `@staticflux/document/loro-crdt` and `@staticflux/testkit/a11y`.
**Budgets:** services 9.5 KB, UI 3.75 KB brotli (framework, lit and kit excluded; `.size-limit.json`).
**Evidence:** `spikes/s6-store/README.md` (milestone of 5/200 pages ≈ 254 ms, 56 KB written), `spikes/s4-crdt/README.md`
(rebuild from canonical parts; shallow snapshots keep source peers, so they are not a detached baseline).

## Purpose
Exactly two kinds of state per tree asset (D2): **Latest** (saved continuously, no save button) and named, immutable
**Milestones** (full snapshots of canonical parts shared by digest; never diff chains). No restore: **New document
from milestone** makes a new asset with a detached baseline; templates are that plus slot filling. Exports render from
a **frozen snapshot** that leaves no record (D10). Costs scale with document size, never with age (IF-5.9).

## Public API (by file)
- `latest.ts` — `createLatestService({ doc, mirror?, clock?, stallAfterMs = 2000, retryMs = 1000 })` → `state()` (reactive
  `SaveState { status: 'saving' | 'saved' | 'offline-mirror-behind', stalled, cause?, since }`), `onChange`, `flush`,
  `dispose`; `deriveSaveState`, `LatestSaveMachine` (`instaflow/latest-save`), `LatestSource`, `MirrorStatusSource`
  (structurally `@staticflux/blob` `FolderMirror`), `SaveClock`.
- `milestones.ts` — `createMilestoneService({ doc, store, capture, registry?, treeSchema?, now?, mirror?, onCreateState? })` →
  `list()` (reactive, newest first), `refresh`, `create({ name, note?, actor })` → `{ entry, record, written, bytesWritten,
  mirrored }`, `record`, `pin`, `rename`, `open` (read-only), `dispose`; `validateMilestoneName`, `MilestoneCreateMachine`
  (`instaflow/milestone-create`), `MilestoneEntry`, `MilestoneSource`, `MirrorFlush`.
- `parts.ts` — `createPartCapture({ store, registry?, treeSchema? })` → `capture(doc, signal, { known? })` (canonical parts;
  frontier cache, only changed parts encoded and written), `forget(asset)`; `UNCAPTURED_PARTS` (`comments`), `PartSource`.
- `readonly.ts` — `openReadOnlyDocument({ store, asset, source, treeSchema, parts, registry? })` → `ReadOnlyDocument`
  (`partIds`, lazy cached `part(id)` → `ReadOnlyPart { node, children, forEachNode, size, canonical }`);
  `indexCanonicalPart`, `readCanonicalPart` (`parse → migrate`).
- `compare.ts` — `openComparison({ milestones, snapshots }, left, right, signal)` → `CompareSession { left, right, parts() }`
  (side by side, visual only); `CompareSide = MilestoneId | 'latest'`, `LATEST`.
- `snapshot.ts` — `createExportSnapshotService({ doc, store, capture, registry? })` → `freeze(signal)` → `FrozenSnapshot
  { id: sn_…, ref, manifest }`, `open(snapshot)`; `ReleasePort` (the Release hook), `unavailableReleasePort` (IF-VER-009).
- `new-document.ts` — `createDocumentFromMilestone({ store, engine, registry?, undoHorizon?, now?, peer? }, { asset, kind?,
  actor, source: { milestone, record, title }, transform?, check? }, signal)` → `{ asset, head, record, recordRef }`.
- `templates.ts` — `SlotComponent` (`slot.name|accepts|target|required|maxChars`; add it to the app registry), `SLOT_KINDS`,
  `SLOT_TARGETS` (data: default target path and fitting node kinds per kind), `markSlot`, `unmarkSlot` (commits through a
  `SlotWriter` = the stage undo service), `listSlots`, `validateFill`, `checkFills`, `fillPart` (pure),
  `createDocumentFromTemplate({ …, fills, keepSlots? })`.
- `head-state.ts` — `readVersioningState`, `withVersioningState`, `updateVersioningState` (CAS + retry, IF-VER-004),
  `VERSIONING_APP_KEY` (`head.app.versioning`), `VersioningState`, `MilestoneHeadEntry`.
- `records.ts` — `MilestoneRecord`, `AssetRecord`, `SnapshotManifest`, `CreatedFrom`, ids (`milestoneIdOf`, `snapshotIdOf`,
  `digestOfId`, `isMilestoneId`, `isAssetId`), `encodeRecord`, `decode*`, `collectReferences`; schema constants.
- `command.ts` — `CreateMilestoneCapability` (`instaflow/create-milestone`, title "Milestone"), `CREATE_MILESTONE_SHORTCUT`
  (`Mod+Alt+S`), `implementCreateMilestone({ milestones, actorFor, prompt })` (no name → opens the form).
- `panel-model.ts` — `createMilestonesPanelModel({ milestones, snapshots, documents, host, actor, newAssetId, title, signal })`;
  `VersioningHost` port (`showReadOnly`, `showComparison`, `openDocument`: B0/C3 mount these).
- `tokens.ts` — `VersioningContext(Token)`, `VersioningServices(Token)`, `LatestServiceToken`, `MilestonesPanelModelToken`,
  `ReleasePortToken`, `MAX_MILESTONE_NAME` / `NOTE`. `units.ts` — `createVersioningServices(context, scope)`,
  `versioningServicesUnit` (feature scope), `latestServiceUnit`, `milestonesPanelModelUnit`, `releasePortUnit`, `versioningUnits`.
- UI (`ui.ts`): `milestones-panel.ts` — `<if-milestones-panel>` (`defineMilestonesPanel`, `milestoneNodes`, `promptCreate()`);
  `save-status.ts` — `<if-save-status>` (`defineSaveStatus`, `saveStatusView`); `contributions.ts` — the Milestones panel as a
  **B0 panel contribution** (`instaflow/milestones`, dock; reconciled by B8), the local `TopBarContribution` /
  `CommandContribution` shapes + tokens (B0 has no top-bar or command vocabulary yet; Studio shows the save status and runs
  the command from its Milestone button), and `versioningContributionUnits`; `messages.ts` — `versioningMessages` (`instaflow-versioning`), `versioningText`.
- `errors.ts` — `IF-VER-001` name · `002` unknown milestone · `003` record/part missing or malformed · `004` head CAS lost ·
  `005` slot mark · `006` slot fill · `007` required slot · `008` asset exists · `009` Release unavailable · `010` disposed.

## Semantics (do not regress)
- **Write only changed parts.** A capture re-encodes only parts whose CRDT frontier moved and writes only digests not known
  (the newest milestone's parts). A milestone right after an export snapshot writes no part.
- **Never O(age).** Creation reads the head and the newest record only; it does not load the list in a cold session. Open
  reads the record plus the viewed parts. New document reads each part once. `costs.test.ts` holds this at age 3/20/60. The
  head lists milestone ids (~85 B each; DOCUMENT-FORMAT §5.2 GC roots) — the only thing that grows.
- **Head fields:** milestones, pinned, names (renames) and the asset record ref live in `head.app.versioning`; updates are CAS
  with retry. The repo carries `app` through compaction (it adopts the newer head on a conflict).
- **Detached baseline:** one fresh peer, one commit of history, node ids kept, `createdFrom` label only; nothing in the new
  head names a source object (tested by making every source read fail).
- **Frozen snapshot:** captures what is applied in memory (durable or not); writes blobs only — no record, no head change.
- **Templates:** slots are markers on existing elements; one fill fills every slot of that name; markers are dropped unless
  `keepSlots`; invalid fills or missing required slots write nothing.
- **Panel:** kit components only, Clean Pop tokens only; variants `primary` (one), `secondary`, `ghost`. Keyboard: Enter
  in the name field creates; list ↑/↓, Space selects (two for compare), Enter opens read-only; toolbar ←/→; rename Enter
  / Escape. Results go to a polite live region.

## Lifecycles (docs/LIFECYCLES.md §23)
`instaflow/latest-save`: saved → saving → saved; saving → stalled → saving | saved; any → disposed.
`instaflow/milestone-create`: queued → flushing → capturing → recording → swapping → created; any non-terminal → failed.

## Rules
- Services take the open document structurally (`PartSource`, `LatestSource`, `MilestoneSource`); never import the repo
  implementation. App code never imports testkit; `test-helpers.ts` is excluded from the build.
- No structural diff in V1 (IF-5.11); no automatic milestones (IF-5.6, `kind: 'auto'` stays reserved); no restore (D2).
- Out of scope here: publish and Release UI, comments, the read-only renderer and HUD (C3), screen layout (B0).

## Test
`npx vitest run apps/instaflow/src/versioning` · bench (wall clock, not in CI):
`pnpm vitest bench --run --reporter=verbose apps/instaflow/src/versioning/versioning.bench.ts` (memory store, 200 pages ×
60 nodes, 4-core container: milestone of 5 changed pages ≈ 27 ms at age 1 and at age 50; open every part ≈ 50 ms for the
newest and the oldest; new document ≈ 2 s at both ages, dominated by rebuilding 12k nodes in Loro).
