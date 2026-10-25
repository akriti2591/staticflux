# Instaflow UX documents — index

Three layers. Lower layers never redefine what a higher layer owns.

| Layer | File | Holds |
|---|---|---|
| 1 | [`FOUNDATIONS.md`](FOUNDATIONS.md) | Principles, vocabulary, layout primitives, every control and pattern (anatomy, states, keyboard, sizes, motion, accessibility, do/don't), and the **block → code map** (what `@staticflux/*` implements, what is missing and whether it belongs in StaticFlux or Instaflow). |
| 2 | [`STUDIO-UX-SPEC.md`](STUDIO-UX-SPEC.md) | Studio: canvas model, top bar (lens model, assistant entry, density, Settings), dock, tool picker, selection pill, inspector, direct manipulation, keyboard map, clipboard, context menu, conveniences and feedback, icon rules, plumbing, **gap table**, **open questions**, **live-vs-placeholder inventory** (Appendix A, Home and Studio). |
| 2 | [`HOME-FILES-UX-SPEC.md`](HOME-FILES-UX-SPEC.md) | Home, Files, projects, trash, storage, every file operation, plumbing. |
| 2 | [`CHAT-UX-SPEC.md`](CHAT-UX-SPEC.md) | Chat (M2): entry points, layout, mini editors, proposals and autonomy, handoff, and what M1 must not do. |
| 3 | [`FLOWS.md`](FLOWS.md) | End-to-end flows F-01…F-46 naming the surfaces and building blocks each exercises; the M1 must-pass set is the end-to-end suite. |

Rules of use for implementers: read `FOUNDATIONS.md` once; read the Layer 2 file of the surface you touch; take the
F-xx flows that name your area as acceptance tests. If a rule is missing, follow the named convention (Figma, Canva,
Keynote), say so in your report and propose the change here; never invent silently.
