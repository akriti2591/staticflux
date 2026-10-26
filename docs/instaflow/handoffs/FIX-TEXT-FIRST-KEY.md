# FIX-TEXT-FIRST-KEY handoff — 2026-10-26
**Commit:** see `git log claude/fix-text-first-key` (last: "FIX-TEXT-FIRST-KEY: handoff …")  ·  **State:** done (3 items; 2 proposals)
Line numbers are from before the fixes (`270d946`). All three bugs were already on `origin/main`: B12 caused none of them.

## 1. First key: "ello StudioH" (a race across the TextInput port, since B9)
**Path.** Text tool click → `creation.ts` → `canvas-tab.ts` `editText` → `startTextEditing` (`app/text-editing.ts:81`):
host `open`, session start (caret 0) pushes `state("",[0,0])`, focus. Key "H": the EditContext inserts it (caret 1 on main)
and sends `insert [0,0]` (`surface/src/text-input.ts:293`, `workers/text-port.ts:240`). Editor: session `commit`
(`text/text-session.ts:172`) → `target.commit` (`:178`) → `document.commitOps` twice (text, box size; `text-editing.ts:137`,
`:142`). **Each commit invalidates the element synchronously → `session.refresh()` (`text-editing.ts:157-160`) → `sync()`
(`text-session.ts:144`) → `setState("H",[0,0])`**, the new text with the old caret: the session moves the caret only
after `target.commit` returns (`:188`). Three states per key, same `seen`. Main applies a state when no intent is in
flight (`text-port.ts:202`), which is true for the first key, so the caret jumps 1 → 0 (`text-input.ts:357`). If the
next key lands before the third state (the editor is still laying out), "e" goes in at 0, and so on.
**Evidence.** Trace of a natural failure on `origin/main` (colocated): `state ["H",0,0] seen=1 sent=1` moved the caret at
t=204.7 ms, "e" went in at 0 at t=209.1. Deterministic in Chromium (the commit's follow-up states held 300 ms, as a
slower layout would): "ello StudioH" every time on `origin/main` and on B12, both topologies; 0/10 after the fix.
**Smoke bug too:** Playwright's `waitForFunction` does not await an async predicate (the Promise is truthy), so all 12
`waitForFunction(async …)` waits in `studio.smoke.mjs` ended at once; the typing check passed on "ello StudioH" and the
failure surfaced at the PDF. They poll through `waitAsync` now.
**Fix.** `refresh()` during the session's own commit only marks `refreshDue`; the commit pushes once, caret after the edit
(a failed commit still refreshes). Tab indent pushes once. LIFECYCLES WRK-9.
**Test.** `app/text-editing.first-key.test.ts` (real document and layout, remote host, bridge, EditContext fake, both
queues stepped): `'elloH'` before, `'Hello'` after; one state per key with the caret after it.

## 2. Click, drag, Shift+arrows, Mod+A "don't work" (never wired, since B2/B8/B9)
**Path.** Presses on the text host were dropped on main (`app/studio-canvas.ts:72-80` filtered pointer events with the
keys; `:209` returned early), and nothing called `session.select` / `engine.hitTest` (the session's `select` existed,
`text-session.ts:77`). Nothing drew the caret or `selectionRects` (TEXT-FONTS §3.2: "(b) drawing"). Mod+A and
Shift+arrows *did* change the selection (EditContext 0..12; the canvas shortcut scope does not swallow Mod+A: the host's
keydown prevents default first, `a11y/src/shortcuts.ts:380`), but nothing showed it. Probe before: Ctrl+A changed no
pixels, a click left the selection at 0..12; after: the selection is drawn, the click puts the caret at 0.
**Fix.** Host pointer events go through the input ring (keys stay filtered; WRK-2 reworded). `TextEditing.pointer`
(page px → block → `hitTest`): click = caret, drag extends (above / below the text = start / end), Shift+click extends,
2/3/4 clicks = word (`wordAt`) / paragraph / all; a press outside ends editing as before. The double click that starts
editing puts the caret at the click (§3.1). `textEditBatch` draws the caret (ink, ≥ 1 screen px) or the selection rects
(accent at 24 %) in the overlay, transformed with the element. `inspect().editing.selection`. LIFECYCLES INT-8.
**Tests.** `text-editing.pointer.test.ts` (click, drag, drag back, above the text, Shift+click, double / triple /
quadruple, outside, Mod+A, Shift+arrows, overlay caret width at 25 %), `canvas-tab.test.ts` (routing; overlay batch; a
press outside ends editing). Smoke: Mod+A → `[0,12]`, click at the start → `[0,0]`, drag across → `[0,12]`.
**Not done (spec):** caret blink (static bar; blinking needs a timed overlay redraw); a second Mod+A selecting the
element; Shift+click and drag extend by grapheme only from a single click; right-click menu.

## 3. Layer opacity (and blend, effects) on text does nothing (since B2)
**Path.** Text is not in the element projection (`elements/projection.ts:28`, no `text` kind): the text layer draws it
(`app/text-layer.ts` `changes`), and `textSceneNodes` (`text/text-scene.ts:129`) wrote a bare group with no opacity,
blend or effects. Shapes carry them on their node (`elements/scene.ts:188-189`, `:216`). Effects on text (drop / inner
shadow, glows, layer blur: TEXT-FONTS "(a)") were lost in render and all three exports for the same reason.
**Fix.** The text layer resolves the element (`resolveElement`) and the group gets opacity, blend (by index, as B1) and
effects: one layer, so glyphs don't double up. Canvas, PNG, SVG and PDF all read this IR (D21). LIFECYCLES INT-9.
**Tests.** `text/text-scene.layer.test.ts` (group fields; defaults left out); `export/job.test.ts` (SVG: the "Faded"
glyphs inside `<g opacity="0.4" style="mix-blend-mode:multiply">`, the shadowed text inside a filter; PDF: ExtGState
alpha 0.4 + `/BM /Multiply`, the shadow a raster patch). Failed before (`expected '' to contain 'mix-blend-mode…'`).

## Proposals (architectural: not built)
- **P1, platform ranges after an editor caret move.** Found by item 2's smoke: End (or a click) moves the caret in the
  editor; main's EditContext learns it only from the next state, so a key or composition typed within one round trip
  lands at the old caret ("Hello 日本語Studio"). Proposal: intents carry the seen count of the state main last applied;
  the editor rebases ranges older than its last own caret move onto its selection (text-port + session; WRK-4/WRK-9).
  The smoke waits for the caret to reach main before composing.
- **P2, text in the element tree.** Text groups are root nodes appended after the elements (`scene-ir.ts:453`,
  `SCENE_APPEND`): text draws above every shape, ignores its parents' opacity / effects / frame clip, and cannot be a
  mask. Proposal: project `text` as an element node (layer look, order key, parent) and parent the glyph group under it.

## Runs and checks
- Smoke (each run both topologies, waits now real; two loops in parallel, so under CPU contention): item 1 alone
  20/20; final tree (items 1–3, with the Mod+A / click / drag steps) 20/20. Before: `origin/main` stock 1 failure in 3
  runs, instrumented 1 in 34 (colocated).
- `pnpm build`, `pnpm typecheck`, vitest `apps/instaflow/src/{app,text,export,tools,workers,elements,render}` (332 pass),
  `lint:boundaries`, `lint:sf`, `size` (tools 27.97/28 KB, text 18.24/18.25 KB: tight), `errors:check`. Not run:
  `SF_GPU=1 pnpm test:gpu` (no corpus change), full `pnpm check`.

## Traps
- Never `waitForFunction(async …)` in Playwright; use `waitAsync`.
- `session.refresh()` called inside `target.commit` is deferred to the commit's own push.
- `textEditBatch` lives in `app/text-editing.ts`, not `tools/overlay.ts` (the tools entry is at its budget).
- Shared files: `docs/LIFECYCLES.md` (WRK-2 reworded, WRK-9, INT-8, INT-9).
