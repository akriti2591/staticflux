# Instaflow DevTools — UX specification (Layer 2)

> Status: **normative for the developer surface.** Composes `FOUNDATIONS.md` (the **Tabs**, **Tree**, **Tag**,
> **Status**, **Menu**, **Toast** blocks), `OVERLAYS-FEEDBACK.md` (the tray is a layer-2 floating region; errors keep
> their copy rules but may show codes here) and `NAVIGATION-DEEPLINKS.md` (`sf-debug` is the one sticky param). Built on
> `@staticflux/devtools` (collector, views, `<sf-devtools>` panel) with Instaflow tabs added. Never for normal users:
> nothing of it loads, renders or is mentioned unless it was asked for.

## 1. What it is for

Answer, in the running app, the questions agents and developers ask when a flow fails: *why is this control hidden or
disabled* (provenance), *what is in the document right now* (document inspector), *which worker is doing what*
(topology), *why was that slow* (perf), *what errored* (errors log). Everything is read-only except the explicit
controls (verbosity, worker restart, pause/resume).

## 2. Opening it (never in the way)

| Way | Behaviour |
|---|---|
| `?sf-debug` (or `?sf-debug=router/*:debug`) on any URL | The sticky param (urlstate) sets verbosity for the session and **makes the DevTools entry visible** in Settings › About for this device; it does not open the panel by itself. |
| Settings › About › `Developer tools` switch | Visible only when the build is a dev build or `sf-debug` was ever set on this device. On: a small `</>` ghost icon button appears at the far right of the top bar (Studio) and the header (Home); off: nothing. |
| `Mod+Shift+D` | Toggles the panel when the switch is on (the devtools package's default shortcut; registered in the shortcut registry so Help lists it only while on). |
| `Alt+Shift+click` on any control while the panel is open | Opens the **Explain** tab on that control (its capability or gate id). |

The panel is **not in the boot bundle** (`@staticflux/devtools/panel` is its own chunk, loaded on first open); its
strings are excluded from the forbidden-text test; codes and ids are allowed inside it and nowhere else.

## 3. The surface

A **tray** at the bottom of the surface (the region FOUNDATIONS §3.1 reserves for the Timeline in M2): 280 px by
default, resizable 200–520 by its splitter, collapsible to a 32 px bar showing the tab names and the live error count.
It never overlays the canvas: the canvas region shrinks (DevTools is the one exception to "floating things never push
the canvas", because a developer reads both at once). Tabs as a switcher at the top left; at the right: a filter field
(`Filter`), `Pause` / `Resume` (telemetry), `Copy diagnostics`, `×`.

| Tab | Shows | Reuses |
|---|---|---|
| **Explain** | A target (capability id, feature, route, surface) and `explain()`'s attributed answer as a tree: the decision, each policy that matched with its source, the facts it read with their current values and **where each value came from** (default · settings · URL param · flag · platform fact · document), and the final gate `fix`. Below: the control's declaration (section, HUD rank, shortcut) from the control model. A field at the top accepts an id; `Alt+Shift+click` fills it. | `gate.explain()`, `kit/tree`, mono `kit/tag` |
| **Document** | The open design: pages and elements as a tree (ids, kinds, names), the selected node's components as key → value rows (Geist Mono), the snapshot version, the CRDT peers (person, agents), undo stacks per actor with labels, the Latest write state (`acked v412 · pending 1`). Selecting a row selects on the canvas; the canvas selection follows into the tree. | `kit/tree`, `kit/inspector` rows, the `inspect` protocol the tests use |
| **Workers** | The topology (`colo` or `split`, D15), each worker as a row: name, state (`starting · ready · busy · crashed · restarting`), last message age, queue depth, a `Restart` button (destructive confirm inline: `Restart the editor worker? Unacked edits are lost · Restart · Cancel`). The crash log (`IF-WRK-*`) with timestamps. | `kit/status`, inline confirm row |
| **Perf** | Frame metrics (A7): input-to-frame p50/p95, frames over budget, time to sharp; the boot waterfall; the last navigation's stages; the export job timings. A `Record 5 s` button captures and shows a sparkline per metric. | `devtools` boot/journeys/metrics views |
| **Errors** | Every `SfError` seen this session, grouped by code: count, last message, `fix`, the level it was shown at (inline · section · toast · banner · blocking · none), and `details`. Clicking a row copies it as JSON. A filter by code family. | `devtools` violations view pattern, `kit/tree` |
| **Framework** | The devtools package's own tabs unchanged: boot, journeys, graph, lifecycles, decisions, stores, violations, metrics, settings (verbosity per subsystem, the `sf-debug` flag editor). | `<sf-devtools>` |

Keyboard: the tray is one landmark (`region` named `Developer tools`); `Mod+Shift+D` toggles; Escape inside collapses
it; tabs follow the Tabs block. Colours: the mist palette; no lens colours (it is not a lens); errors use the danger dot.

## 4. Rules

1. **Observe, don't change.** The only state DevTools writes: verbosity levels, pause/resume, the tray size and tab (per
   device), worker restart on explicit confirm.
2. **Codes are shown here and only here.** `Copy diagnostics` produces the same JSON as the blocking error's button, so
   bug reports from either path look the same.
3. **Same primitives.** Tabs, tree, tags, status, menus, inline confirm and toasts are the kit's; the tray is the
   kit's dock on the bottom side. No bespoke widgets; no second theme.
4. **Never costs normal users.** Zero bytes before the switch is on; zero DOM when closed; the collector's ring buffers
   are bounded; the forbidden-text test ignores the tray's subtree.
5. **Agents may read it.** The Document and Explain views are the human-readable forms of what the WebMCP tools (D12)
   expose; keep their shapes aligned so a person and an agent see the same facts.

## 5. Plumbing

| Need | Where |
|---|---|
| Install behind the switch; sticky `sf-debug` reveals the switch | `src/settings/` (About section), `src/app/devtools.ts` (`installDevtools` with Instaflow sources), `url-contract.ts` (`sf-debug` sticky) |
| Instaflow tabs (Explain, Document, Workers, Perf, Errors) | `src/app/devtools-tabs.ts` as `<sf-devtools>` extensions; Document over the `inspect` protocol and the mirrors; Workers over `src/workers/host.ts` states; Errors over a `FeedbackLog` kept by `src/app/feedback.ts` |
| Tray region | the Studio spec's `tray` slot (`src/spec/studio-spec.ts`), `kit/dock side=bottom` |
| `Alt+Shift+click` explain | a capture-phase listener in `src/app/studio-app.ts` active only while the panel is open |
