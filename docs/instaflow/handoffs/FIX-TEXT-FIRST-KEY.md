# FIX-TEXT-FIRST-KEY handoff — 2026-10-26
**Commit:** see `git log claude/fix-text-first-key` (last: "FIX-TEXT-FIRST-KEY: handoff …")  ·  **State:** done

## Symptom
Studio smoke, both topologies, about 1 run in 16: the exported PDF reads "ello StudioH" after typing "Hello Studio" into a
new text element. The first character went in, the caret stayed before it, every later key went in front of it.

## Root cause (a race, older than B12)
Line numbers are from before the fix (`270d946`).
1. Text tool click → `creation.ts` commits the element → `canvas-tab.ts` `editText` → `startTextEditing`
   (`app/text-editing.ts:81`): host `open`, `createTextSession` (caret at the end = 0) pushes `state ("", [0,0])`, focus.
2. Key "H": EditContext inserts it, caret 1 (main), `textupdate` → `insert [0,0]` intent across the port
   (`surface/src/text-input.ts:293`, `workers/text-port.ts:240`).
3. Editor: `onIntent` → session `commit` (`text/text-session.ts:172`) → `target.commit` (`:178`) → `document.commitOps`
   twice (text, then box size; `text-editing.ts:137`, `:142`). **Each commit invalidates the element synchronously →
   `session.refresh()` (`text-editing.ts:157-160`) → `sync()` (`text-session.ts:144`) → `setState("H", [0,0])`**: the new
   text with the **old** caret, because the session sets the caret only after `target.commit` returns (`:188`), then
   syncs again with `[1,1]`. Three state commands per key, all with the same `seen`.
4. Main applies a state when no intent is in flight (`text-port.ts:202`, `seen === sent`). For the first key nothing
   else is in flight, so the stale `("H",[0,0])` is applied: `ec.updateSelection(0,0)` (`text-input.ts:357`).
5. If the next key arrives before the third command (the editor is still laying out between them), "e" goes in at 0;
   the editor follows the EditContext ranges, so the document becomes "eH", then "elH", … "ello StudioH".
Later keys are usually safe because a key is still in flight and the guard drops the stale states; the window is the
first key, or any key after a pause. A fast typist can hit it; it is not specific to the smoke.

**Evidence.** Main-side trace (bridge `receive` + EditContext caret) of a natural failure on `origin/main` (pre-B12,
colocated): `state ["H",0,0] seen=1 sent=1` moved the caret 1 → 0 at t=204.7 ms, key "e" at t=209.1 went in at 0.
Deterministic in a browser: holding the follow-up state commands of the first commit for 300 ms (as a slower layout
would) gives "ello StudioH" every time, on `origin/main` and on B12, both topologies; 0/10 with the fix.

**B12 did not cause it.** `origin/main` has the same three-states-per-key pattern and failed naturally (stock smoke 1 of
3 runs, instrumented 1 of 34) and deterministically. B12's coalescing and the IME relayout change are not involved.

## Second bug: the smoke never waited
Playwright's `page.waitForFunction` does not await an async predicate (the returned Promise is truthy), so all 12
`waitForFunction(async () => …inspect()…)` waits in `studio.smoke.mjs` ended at once. The "typed Hello Studio" check
passed on "ello StudioH" and the failure surfaced only at the PDF step. They now go through `waitAsync` (polls in Node).

## Fix
- `text/text-session.ts`: `refresh()` during the session's own `target.commit` only sets `refreshDue`; the commit
  rereads, lays out and pushes once with the caret after the edit (a failed commit still refreshes if part of it
  landed). Tab indent pushes once with the kept selection (it used to push the caret at `a`, then the selection).
- `test/smoke/studio.smoke.mjs`: `waitAsync`; the typing step reports the text it read on timeout.
- LIFECYCLES §35 WRK-9 (one text state per handled intent, caret after the edit).

## Tests
- `app/text-editing.first-key.test.ts` (real document, text layer, remote host, bridge, EditContext fake, both message
  queues stepped by the test): "e" typed between the editor's messages for "H" → `'elloH'` before the fix, `'Hello'`
  after; every handled key posts exactly one state with the caret after it.
- Smoke (both topologies per run, with the waits now real): 20/20 pass on the fix (two loops of 10 in parallel, so
  under CPU contention). Before: `origin/main` stock 1 failure in 3 runs, instrumented 1 in 34 (colocated).
- Checks: `pnpm build`, `pnpm typecheck`, vitest `apps/instaflow/src/{text,app/text-editing.first-key,app/canvas-tab,
  workers/text-port}` (84 tests), `lint:boundaries`, `lint:sf`, `size` (text 18.2 / 18.25 KB), `errors:check`.

## Decisions
- Fixed at the source (the session), not in the port: the port's rule (apply when nothing is in flight) is right if the
  editor posts one state per intent; WRK-9 now says so. No protocol change, no new IDs besides WRK-9.

## Traps
- Never `waitForFunction(async …)` in Playwright; use `waitAsync`.
- Anything that calls `session.refresh()` synchronously inside `target.commit` is deferred to the commit's own push.
