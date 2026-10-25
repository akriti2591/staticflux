# UX-PRIMITIVES handoff — 2026-10-25
**Commit:** head of `claude/wip-ux-primitives`  ·  **State:** done (docs only; owner questions open)

## Scope status
- `docs/instaflow/ux/OVERLAYS-FEEDBACK.md` (new, Layer 1): overlay system (6 layers, nesting table, focus, Escape order,
  light dismiss, positioning, bottom sheets on Home < 720 px, one-at-a-time, roles), dialogs and sheets (types, Share
  and Milestones worked end to end, unsaved changes), feedback hierarchy with the `SfError` mapping, retry/offline/crash
  recovery, progress, toast queue, success, error-copy rules, tooltips, first-use hints (no tours), owner questions: done.
- `docs/instaflow/ux/NAVIGATION-DEEPLINKS.md` (new, Layer 1): URL scheme (paths, view/intent/sticky query, nowhere),
  history semantics, fallbacks, Copy link, cold boot order, map to `router` / `urlstate`: done.
- `STUDIO-UX-SPEC.md`: §4.2 rewritten (one control model for HUD + inspector, placement, inline/popover/More, per-kind
  table incl. mixed, locked, repeat instance, colour popover, font picker, alignment popover); §5 intro, §3.4, §2 overflow,
  §7 (two shortcuts), §8.2 (copy link rows, Milestones row), §9 and §12 rows: done.
- `CHAT-UX-SPEC.md` §7–§9 (provider setup, no-provider state, errors, empty thread, long turns, deep links): done.
- `DEVTOOLS-UX-SPEC.md` (new, Layer 2): done. `FOUNDATIONS.md` §4.8–4.11 summaries, new §4.21–4.23, §6 rows: done.
- `FLOWS.md` F-47…F-52 + coverage matrix; `ux/README.md` index: done.

## Decisions (and why) — all recommended, none reopen STUDIO §14
- Layers 3–6 live in the browser top layer, so order is enforced by the manager (close layer 3 before a dialog, re-show
  toasts above modals), not by z-index. One modal at a time; dialog-on-dialog forbidden; confirmations are inline rows,
  sub-tasks are steps of the same dialog. Popover never spawns a popover (expand or swap in place).
- Menus consume the outside click; HUD/inspector popovers let it through (Canva: one click to the next element).
- Toast width 420 (was 320) so message + fix fit; newest at the bottom; pause on hover/focus/hidden; Home `Mod+Z` undoes
  the newest toast with Undo; in Studio `Mod+Z` stays document undo.
- D2 kept: "restore" = `Open as new design`; milestone preview and Compare are full-screen takeovers with URLs.
- No tours; first-use hints only (seen once per device, max 2 per session, Settings switch). Empty states teach.
- Camera never in the URL; selection and inspector section are consume-once intents (`el=`, `inspect=`), matching
  urlstate's `hidden`/intent kinds; routable dialogs push in-app and replace from a link; fallbacks go one level up
  with a neutral toast and replace the URL.
- Worker crash: banner + one automatic restart + toast; second failure → blocking error with `Copy diagnostics`.
- DevTools: a bottom tray behind Settings › About › Developer tools (revealed by `?sf-debug`), zero cost otherwise.

## What B11a (building blocks) must build from this
Kit (StaticFlux, generic): `<sf-surface-layer>` rules (close layer 3 before 4, re-assert toasts, trigger-gone focus
fallback); `kit/menu` submenus, headings, filter field, consumed outside click, corner rule for context menus;
`kit/popover` pass-through dismiss option; `kit/tooltip` warm period, disabled-reason composition, long-press;
`<sf-color-popover>` (value row, document colours, brand, palette, recent, inline custom), `<sf-font-picker>`
(virtualised, in-face rows, hover-preview events), `<sf-align-popover>`; `<sf-toast>` pause and count; `<sf-banner>`,
`<sf-blocking-error>`, `<sf-progress-row>`; dialog wizard step frame, takeover frame, inline confirm row, bottom-sheet
placement under a container query; `<sf-hint>`; plus the already-listed `<sf-icon>`, `<sf-number-field>`,
`<sf-inline-edit>`. Each with the roles in OVERLAYS-FEEDBACK §1.8 and `expectNoA11yIssues`.
Instaflow (app): `src/app/feedback.ts` (error → level adapter, `ToastsToken`), `src/app/recovery.ts`, the URL contract
(`src/app/url-contract.ts`, `url.ts`, `links.ts`, all routes in `src/home/routes.ts`), the not-found page, the seen-store
adapter for hints.

## What B11b (surfaces) must build from this
The control model `src/spec/controls.ts` and the pill as its ranked projection (STUDIO §4.2.1–4.2.4), pill placement
from selection bounds; the inspector over the same model; the Milestones list menu, preview and Compare takeovers;
Settings dialog/page with `section`; Export dialog with routable steps and `Copy link`; Home card `Copy link`; the
first-use hints and Settings switch; worker-crash banner wiring; DevTools tray and Instaflow tabs (can trail to C4).
Acceptance: F-48, F-49, F-50, F-52 (M1) and the existing M1 must-pass set; F-47 and F-51 are M2.

## IDs used
Framework: R7.10–R7.21 (urlstate/router), R13.4–R13.10 (messaging), R6.16 (client gating is UX), `SF-NAV-001/002/008`,
`SF-MSG-*`, `SF-AI-001/002/005`. Instaflow: `IF-WRK-*`, `IF-EXP-*`, `IF-LIB-*`, `IF-HOME-005`, `IF-PLAT-*`, D2, D3, D10,
D11, D13, D15, D17, D18. No new requirement rows were written (docs/instaflow/ux only); B11a/B11b add IF-35/IF-36 rows.

## Failing or untested
Docs only; nothing to run. Not verified against code: whether `kit/position` already shrinks lists, whether the
messaging manager refuses a second modal or queues it (the spec says refuse).

## Next steps
1. Owner answers the six questions at the end of OVERLAYS-FEEDBACK (toast width, restore, hints, pass-through, Compare
   takeover, Share designed now). Defaults are the recommendations.
2. B11a starts from FOUNDATIONS §6 "Missing (where)" rows marked StaticFlux kit.
3. B11b starts from STUDIO §12 rows added today (control model, routes, takeovers, recovery).
4. When comments (D11) are planned, fill `comment=` and the comments panel from the reserved shapes.

## Traps
- FOUNDATIONS §4.10 toast width changed to 420 px: tests written against 320 must move.
- STUDIO §4.2 renumbered into §4.2.1–4.2.7; anything linking "§4.2 table" means §4.2.4 now.
- `OVERLAYS-FEEDBACK.md` §2.3 Share is **not rendered in M1** (D3); do not build its UI before accounts, only its blocks.
- F-17 step 4 (Compare) is now a takeover with `?compare=`; keep F-17's wording compatible when writing tests.

## Addendum 2026-10-25 — Export tab worked end to end (owner: "download needs a share-like design")
- **Added:** `OVERLAYS-FEEDBACK.md` §2.3 "Export (the Export dialog's Export tab)": entry points, scope with a
  thumbnail page-range picker, presets, format and per-format options, file names, several formats (zipped), output
  size, main step (four decisions) vs `advanced`, memory per design, loose-elements line and disabled reasons,
  progress/background/toasts, errors, deep links, keyboard and a11y, and the **Export engine follow-ups** table.
  `NAVIGATION-DEEPLINKS.md`: new view keys `scope`, `pages`, `format` for dialog `export` (§2.2, §4, §5, §7).
  `FLOWS.md`: F-53 (12 steps + the quick-export variant), F-18 aligned to C1's file names, coverage matrix rows.
  OVERLAYS §6 items 7–9 (shortcut opens the dialog; zip by default; non-applicable presets not rendered).
- **Letters:** every option is (a) engine today, (b) UI/plumbing in B11b, or (c) engine work. (c) is **never rendered
  in M1**: no JPG chip, no `Print` PDF kind, no bleed/crop marks, no SVG `Text`/embed fonts, no arbitrary scale, no
  Social presets on pages of another size, no `missingFonts` warning. Target M2 for all six.
- **B11b builds:** the dialog over `ExportPanelPort` (no logic in the dialog); plumbing in `service.ts`/`job.ts` for a
  page subset (`pages`), a `fileName`, the ` - selection` suffix and a zip step on main (`@staticflux/blob`
  `createZipWriter`); sequential multi-format runs in the dialog; the background toast from the reactive `status`;
  memory under `instaflow/ui/export/<asset>`; `ExportShortcut` opens the dialog instead of exporting (pending §6 item 7).
- **Trap:** `ExportCapability.input` stays as C1 declared it; new fields (`pages`, `fileName`, later `quality`, `bleed`,
  `svgText`) are optional additions when their letter becomes (a), never renames. F-18 step 2's old file name
  `<title>-page-1@2x.png` is gone: names are `<Title>.png` / `<Title> - 01.png` (`exportFileName`).
