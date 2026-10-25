# Instaflow UX documents — index

Three layers. Lower layers never redefine what a higher layer owns.

| Layer | File | Holds |
|---|---|---|
| 1 | [`FOUNDATIONS.md`](FOUNDATIONS.md) | Principles, vocabulary, layout primitives, every control and pattern (anatomy, states, keyboard, sizes, motion, accessibility, do/don't), and the **block → code map** (what `@staticflux/*` implements, what is missing and whether it belongs in StaticFlux or Instaflow). §4.8–4.11 and §4.21–4.23 summarise the two files below. |
| 1 | [`OVERLAYS-FEEDBACK.md`](OVERLAYS-FEEDBACK.md) | The **overlay system** (six layers, nesting, focus, Escape order, light dismiss, positioning, roles), **dialogs and sheets** (types, the Share and Milestones flows worked end to end, unsaved changes), **feedback and errors** (one hierarchy, `SfError` mapping, retry, offline, crash recovery, progress, toasts, copy rules), **tooltips**, **first-use hints** and empty states; **owner questions** at the end. |
| 1 | [`DENSITY-DISCLOSURE.md`](DENSITY-DISCLOSURE.md) | The three **density modes** (Focus · Standard · Pro) as personalities: per surface (Studio chrome, inspector per selection kind, dock panels, HUD, Home, Chat, dialogs, Settings) what shows, tucks or hides; spacing and type tokens per mode; moving between modes and what is remembered; the **disclosure blocks** and the **clutter audit** (what folds in every panel and dialog). |
| 1 | [`NAVIGATION-DEEPLINKS.md`](NAVIGATION-DEEPLINKS.md) | One URL scheme for every addressable state (path vs query vs nowhere), history semantics (push/replace, Escape vs Back), missing or forbidden targets, "Copy link to this", cold boot order, and the map to `@staticflux/router` / `urlstate`. |
| 2 | [`STUDIO-UX-SPEC.md`](STUDIO-UX-SPEC.md) | Studio: canvas model, top bar (lens model, assistant entry, density, Settings), dock, tool picker, **the contextual HUD and its control model** (§4.2: per selection kind, colour popover, font picker, alignment), inspector, direct manipulation, keyboard map, **cheat sheet** (§2.3.1), clipboard, context menu, conveniences, **find and replace** (§9.1), **performance states** (§9.2), feedback, icon rules, plumbing, **gap table**, **owner decisions** (§14, settled), **live-vs-placeholder inventory** (Appendix A). |
| 2 | [`HOME-FILES-UX-SPEC.md`](HOME-FILES-UX-SPEC.md) | Home, **New design** (sizes, presets, custom size, start from template), **first run**, Files, projects, trash, every file operation, **import** (every file kind, every drop target), storage, plumbing. |
| 2 | [`CHAT-UX-SPEC.md`](CHAT-UX-SPEC.md) | Chat (M2): entry points, layout, mini editors, proposals and autonomy, handoff, **provider setup**, the no-provider state, **chat errors**, the empty thread, long turns and cancel, deep links, and what M1 must not do. |
| 2 | [`DEVTOOLS-UX-SPEC.md`](DEVTOOLS-UX-SPEC.md) | The developer surface: Explain (value provenance), Document, Workers, Perf, Errors tabs over `@staticflux/devtools`; how it opens (sticky flag, About switch) and why normal users never see it. |
| 3 | [`FLOWS.md`](FLOWS.md) | End-to-end flows F-01…F-59 naming the surfaces and building blocks each exercises; the M1 must-pass set is the end-to-end suite. F-47…F-53 exercise the primitives (Share, milestone restore, deep link to a missing element, worker crash, assistant setup, HUD recolour, Export); F-54…F-59 the product basics (custom size, import, find and replace, cheat sheet, density modes, first run). |
| — | [`GAP-AUDIT.md`](GAP-AUDIT.md) | **Working document for the owner** (2026-10-25): the inventory of every surface, flow and primitive with status and reference product; the market analysis (where to be better than convention, and why); the ranked gaps and what was filled; the backlog for later passes (Timeline, Pixel, Flow lenses, Brand panel, Resize design, presence…); the owner questions with recommendations. |

Rules of use for implementers: read `FOUNDATIONS.md` once, then `OVERLAYS-FEEDBACK.md` and `NAVIGATION-DEEPLINKS.md` if
you touch any overlay, feedback or URL; read the Layer 2 file of the surface you touch; take the F-xx flows that name
your area as acceptance tests. If a rule is missing, follow the named convention (Figma, Canva, Keynote, macOS, Linear),
say so in your report and propose the change here; never invent silently. Handoff for the primitives work:
`../handoffs/UX-PRIMITIVES.md`.
