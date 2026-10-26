# Instaflow UX gap audit (2026-10-25)

> Status: **working document for the owner.** An inventory of every surface, flow and primitive against what the
> specs cover and what the code builds; a short market analysis; the gaps ranked by how much a person would feel them;
> which were filled in this pass and where; a ranked backlog; and the owner questions, each with the recommendation
> first. Written from the specs in this folder, the `apps/instaflow/src/` tree, and the owner's direction of
> 2026-10-25 (three density modes thought through; progressive controls; Export answers; custom size everywhere).
>
> Reading rule for the **Reference** column: it names the product whose version of that area is the best *starting
> point*, not the one to copy. §2 says where Instaflow should be better than the reference and why.

## 1. Inventory

Status: **worked** (specified end to end: anatomy, states, keyboard, errors, flow) · **frame only** (named, a row or a
line, not enough to build without inventing) · **missing** (not in any spec) · **built** (in code today, per
STUDIO §13 and Appendix A). "Spec" says where it is or should be specified.

### 1.1 Surfaces

| Surface | Status | Reference | Spec |
|---|---|---|---|
| Home (`/`) hero, formats, Jump back in, templates, projects | worked | Canva Home (fast start), Linear (calm) | HOME-FILES §1 |
| **New design** (`/new`): sizes, presets, orientation, **custom size**, start from template | frame only → **worked this pass** | Canva "Custom size", Figma frame presets | HOME-FILES §1.3 (new), F-54 |
| **First run / onboarding** | missing → **worked this pass** | Linear (no tour, one card), Claude artifacts (quiet) | HOME-FILES §1.4 (new), F-59 |
| Files (`/files`), project view, trash, bulk bar | worked | macOS Finder, Canva Projects | HOME-FILES §2–3 |
| **Import** (Home and Studio; images, SVG, `.iflow`, PDF, fonts; drop, picker, paste) | frame only → **worked this pass** | Figma (drop anywhere), Canva Uploads | HOME-FILES §3.1 (new), F-55 |
| Settings (General, Shortcuts, Storage, Assistant, About) | worked at section level; fields frame only | Linear settings (one column, commit as you go) | STUDIO §2.4, DENSITY-DISCLOSURE §7 |
| Studio top bar, lenses, save status, View menu, overflow | worked | Figma UI3 | STUDIO §2 |
| Studio dock: Layers, Pages, Assets, Milestones | worked | Figma (layers), Canva (pages strip) | STUDIO §3 |
| **Brand panel** (kits, tokens, fonts, logos) | missing (M2) | Canva Brand Kit | backlog B-4 |
| Canvas model, tools, handles, snapping | worked | Figma, Keynote (rotate) | STUDIO §1, §4.1, §6 |
| Contextual HUD + inspector (one control model) | worked | Canva (pill), Figma (inspector) | STUDIO §4.2, §5 |
| **Text and fonts** (creation and boxes, editing comfort, every inline and block control with tiers, presets and styles, font picker, adding fonts, missing fonts, fidelity, actions, errors; checklist against Docs · Notion · Figma · Canva · InDesign · Pages; outlet + flow for every deferred feature) | frame only (a pill row, a picker paragraph, five shortcuts) → **worked, text pass 2026-10-25** | Docs (editing comfort), Figma (boxes, fidelity), Canva (presets, picker), InDesign (overflow mark) | TEXT-FONTS-UX-SPEC (new), F-60…F-64 |
| **Appearance, transforms and structure** (fill stack, colour popover depth, gradient editor, image fills and crop, strokes, effects and bevel, layer blend, page background decision, copy/paste style, styles and tokens; every transform gesture and field; groups vs frames, components M2, booleans, masks, corners, repeat, snapping, rulers, guides, grids, align, layer order, lock scopes, hide; checklist against Figma · Canva · Illustrator · Photoshop · Sketch; outlet + flow for every deferred feature) | frame only (pill rows, a stack paragraph, handle rules) → **worked, appearance pass 2026-10-25** | Figma (stacks, handles), Canva (document colours, visible rotate handle, photo ratio), Illustrator (key object, repeats), Photoshop (bevel) | APPEARANCE-TRANSFORM-UX-SPEC (new), F-65…F-72 |
| Command palette | worked | Raycast, Linear | FOUNDATIONS §4.16, STUDIO §4.4 |
| **Find and replace** (text, fonts, colours across pages) | missing → **worked this pass** | Figma plugin "Find and replace", Google Docs | STUDIO §9.1 (new), F-56 |
| **Keyboard cheat sheet** (`?`) | frame only → **worked this pass** | Figma `?` panel, Linear `?` | STUDIO §2.3.1 (new), F-57 |
| Export dialog (+ Share tab, M2) | worked | Figma export, Canva download | OVERLAYS §2.3 |
| Milestones list, preview, Compare, open as new | worked | Figma version history (read-only preview) | OVERLAYS §2.3 |
| Settings dialog over Studio | worked (shell) | — | STUDIO §2.4 |
| **Density modes** Focus / Standard / Pro per surface | frame only → **worked this pass** | Claude artifact UI (calm), Figma/Adobe (dense) | DENSITY-DISCLOSURE (new) |
| **Clutter audit**: what folds per panel and dialog | missing → **worked this pass** | Framer (menus), Apple (disclosure) | DENSITY-DISCLOSURE §8 |
| DevTools tray | worked | Chrome DevTools | DEVTOOLS |
| Chat surface, mini editors, proposals, provider setup | worked (M2) | Claude.ai (artifact cards), Cursor (accept/reject) | CHAT |
| **Configurable mini editors** (which tools a mini editor exposes, who decides, how a person pins) | frame only | — (nobody does this) | backlog B-6 |
| **Motion and timeline** (Timeline lens and the tray per density, every gesture and key, presets with in-place previews, keyframes and the curve picker, Smart move with visible matches, transitions for pages and clips, audio levels / fades / meters, captions and edit by transcript, the Export dialog's `Video` chip with pause / resume, presentation and presenter view, errors, fidelity, performance, a11y; checklist against CapCut · Premiere · Final Cut · DaVinci · Descript · Keynote · Figma · Canva · After Effects · Rive/Lottie; outlet + flow for every deferred feature) | missing (D5) → **worked, motion pass 2026-10-26** (all (c): M3 Timeline, M4 Motion & presentation, M5 captions and media) | CapCut (clarity), Premiere (precision, JKL, Q/W), Final Cut (magnetic story track, fade handles), Keynote (Magic Move, presenter view), Descript (transcript edit) | MOTION-TIMELINE-UX-SPEC (new), F-73…F-81 |
| **Pixel lens** (brush, heal, crop, adjustments) | missing (M2) | Photoshop, Adobe Express quick actions | backlog B-2 |
| **Flow lens** (steps, edges, run, batch, lineage) | missing (M2/M3) | FigJam (calm nodes), n8n (run state) | backlog B-3 |
| Presentation mode (`▶ Present`, builds, presenter window, reduced motion) | frame only (UX.md §4) → **worked, motion pass 2026-10-26** (M4) | Keynote, Pitch | MOTION-TIMELINE-UX-SPEC §11, F-75 |
| Unsupported-browser screen, not-found page | worked | — | OVERLAYS §3.1, NAV §4 |

### 1.2 Flows

| Flow | Status | Reference | Spec |
|---|---|---|---|
| First design, versions, return (F-01) | worked | — | FLOWS |
| Draw / transform / style / text / layers (F-02…F-11) | worked | Figma | FLOWS |
| Clipboard in and across documents (F-06, F-07) | worked | Figma | FLOWS, STUDIO §8.1 |
| Templates, milestones, export (F-16…F-18, F-48, F-53) | worked | — | FLOWS |
| Home file operations (F-30…F-38) | worked | Finder | FLOWS |
| Chat (F-40…F-46), assistant setup (F-51) | worked (M2) | Claude.ai | FLOWS |
| **New design with a custom size** | missing → F-54 | Canva | FLOWS |
| **Import a file from Home and Studio** | frame only (F-14 images only) → F-55 | Figma | FLOWS |
| **Find and replace across pages** | missing → F-56 | Docs | FLOWS |
| **Learn the shortcuts** | missing → F-57 | Figma | FLOWS |
| **Switch density mode** | frame only (F-24 step 2) → F-58 | — | FLOWS |
| **First run** | partly F-01 → F-59 | Linear | FLOWS |
| **Resize design** (change page size with content re-layout) | missing | Canva Magic Resize, Figma "Resize to fit" | backlog B-5 |
| **Trash and recover an asset or a page** (not a design) | frame only | — | backlog B-9 |
| **Animate a title with a preset; Auto Animate between two pages; transitions and present; cut a 30 s clip with music and captions and export MP4; keyframes by hand; trim family by keyboard; audio; codec and render errors; edit by transcript** | missing → **F-73…F-81** (motion pass) | Canva, Keynote, CapCut, Descript | FLOWS section I |
| **Offline session end to end** | worked (F-22 step 1, OVERLAYS §3.3) | — | — |
| **Storage pressure** (full, ~2 GB, persist refused) | worked (F-37, HOME-FILES §4) | — | — |
| **Big document, slow machine** (perf states) | missing → **worked this pass** | Figma (progressive tiles) | STUDIO §9.2 (new) |
| **Permissions later** (links, roles) | worked as Share step 1 (M2+) | Figma share | OVERLAYS §2.3 |
| **Collaboration hooks** (cursors, presence, comments) | frame only (D11, IF-12.6) | Figma multiplayer | backlog B-8 |
| Notifications | not needed (see §2) | — | §2 |

### 1.3 Primitives

| Primitive | Status | Reference | Spec |
|---|---|---|---|
| Button, icon button, switcher, field, slider, tag | worked | Clean Pop | FOUNDATIONS §4 |
| Scrubbable number, colour popover, font picker, align popover | worked | Figma / Canva | FOUNDATIONS §4.5–4.6, STUDIO §4.2.5–7 |
| Menu, context menu, popover, tooltip, dialog, sheet, takeover | worked | macOS / Figma | OVERLAYS §1–2 |
| Toast, banner, inline/section/blocking error, progress | worked | Linear | OVERLAYS §3 |
| Tree, card, empty states, inline rename, drag and drop | worked | Figma / Finder | FOUNDATIONS §4.13–4.19 |
| First-use hints (no tours) | worked | Canva | OVERLAYS §5 |
| Deep links, copy link, fallbacks | worked | Figma / Linear | NAVIGATION-DEEPLINKS |
| **Disclosure row** (`More ▾`, `Advanced ▸`, section ▸) as one block with memory rules | frame only → **worked this pass** | Apple (disclosure triangles) | DENSITY-DISCLOSURE §2 |
| **Size field pair** (W × H, lock, orientation, unit, presets menu) | missing → **worked this pass** | Figma frame presets | HOME-FILES §1.3, OVERLAYS §2.3 Export |
| **Search field with scopes and results list** (Find) | missing → **worked this pass** | VS Code find widget | STUDIO §9.1 |
| **Cheat sheet grid** | missing → **worked this pass** | Figma | STUDIO §2.3.1 |
| **Localisation rules** (strings, numbers, RTL, dates) | missing → **worked this pass** | — | FOUNDATIONS §5.12 |
| **Keyboard shortcut customisation** | missing | VS Code | backlog B-10 |
| Icons (`<sf-icon>`, Lucide + custom) | worked | — | STUDIO §10.2 |

## 2. Market analysis: where to be better, where to match

Method, per the owner: for each area ask *what the best possible version is*, then keep convention only where it
genuinely serves people (muscle memory, a gesture everyone already knows), and say why each time.

| Area | Leaders | Instaflow: the best version | Convention kept, and why | **Departure, and why it is better** |
|---|---|---|---|---|
| **Saving and versions** | Figma autosaves + version history list; Canva autosaves silently | Latest + named milestones only (D2). A person never wonders "which version is live". | `Mod+S` is caught and explained (muscle memory). | No automatic version list to scroll. Figma's history is long and nameless; people never find the one they want. Milestones are few, named and comparable side by side with a shared camera (Compare takeover), which Figma does not have. |
| **Export** | Figma: per-layer export settings in the inspector; Canva: one download dialog | One dialog with four decisions on the main step, memory per design, a preview card with a size estimate, zip by default, background export with a toast. | `Mod+Shift+E` (Figma). | Export settings are **not** scattered per layer in the inspector (Figma's biggest export complaint); and the dialog says the result size before you press Export, which neither leader does. **Custom size** is a first-class row (§2.3 Export), not a hidden "W" field. |
| **Density** | Figma UI3 has one density; Adobe has workspaces; Claude artifacts have one calm layout | Three modes that are *designed*, not padded: Focus hides chrome, Standard explains, Pro reveals numbers. Each surface has its own table (DENSITY-DISCLOSURE). | Panel toggles `Mod+\` (Figma). | Nobody offers a calm mode and a dense mode of the **same** editor with the same control model behind both. Adobe's workspaces rearrange; ours only reveal. A first-timer and a professional share one tool without either feeling it was made for the other. |
| **Clutter** | Figma inspector shows ~40 controls at rest; Canva hides almost everything behind "Edit image" | Everything is a declared control with a rank and a section; the HUD shows six, Standard shows the essentials with `More ▾`, Pro shows all. | Disclosure triangles (Apple, decades of muscle memory). | Disclosure state is remembered **per section per device**, and Pro simply ignores it (everything open). A person tunes Standard once; Pro never needs tuning. |
| **Starting a design** | Canva: huge template wall; Figma: an empty file | Formats first (one row), **custom size** inline with a lock and orientation, templates second, blank always one click. | Preset names people know (Post, Story, A4). | The size field is on Home, in Export and in the Page section, and it is the **same block** (size field pair) everywhere. Canva's custom size lives in a different place from its resize feature; ours does not. |
| **Onboarding** | Canva: a questionnaire and a tour; Figma: a tutorial file | No tour, no questionnaire. One quiet card on first Home, one first-use hint per tool, an empty state that teaches, Standard density so the model is visible. | Hints (Canva). | A person makes something in the first minute. Tours are skipped; a questionnaire is friction; the owner's own first run showed that seeing Layers and the inspector teaches the model faster than a tour. |
| **Find** | Figma: a plugin; Canva: none in-editor; Docs: `Mod+F` bar | `Mod+F` find bar across pages for text, with Replace, and **Find same** for fonts and colours (replace a colour or a font everywhere in one step). | `Mod+F`, Enter / Shift+Enter (every editor). | A design tool that can replace "Fraunces → Inter" across 20 pages in one dialog is rare (it is a paid plugin in Figma). |
| **Trash** | Figma: deleted files restore from a list; Canva: 30 days | Trash with Undo toasts, 30 days, restore from the toast or the Trash page. | Undo toasts (Linear/Gmail). | Nothing new: convention serves. |
| **Offline** | Figma degrades (banner); Canva mostly stops | Local-first: offline is not an error. No banner until an action needs the network. | — | Most tools show an offline banner at once; ours stays silent because nothing is lost. That is only possible because the data is here. |
| **Storage** | Nobody shows it | A storage line in the footer, persistence state, a folder mirror, a one-time nudge at 2 GB. | — | Owning your files in a folder is the departure (Excalidraw-style). |
| **Keyboard** | Figma: `?` panel with tabs; Linear: `?` list | `?` opens a cheat sheet grouped as the person works (Tools, Selection, Edit, Arrange, View), searchable, with Mac/Windows, printable. | Figma's shortcuts where they exist (`Mod+D`, `Mod+G`, `Alt+A…`): muscle memory for Figma natives, learnable for others. | Shortcuts are **registered** values with conflict checks in CI and one Help source, so the sheet is never stale (Figma's sheet is hand-maintained and lags). |
| **Command palette** | Raycast, Linear, Figma "Quick actions" | One palette for capabilities, tools, View entries, and later natural language. Results the selection cannot run are hidden. | `Mod+K`. | The palette and the HUD's More menu are the **same engine** filtered by the selection; a person learns one list. |
| **Agent** | Canva Magic, Adobe Firefly: buttons that call a vendor | Provider-agnostic, optional, visible as a collaborator with autonomy modes; nothing assistant-shaped renders without a provider. | Accept/Reject (Cursor). | The agent is **absent** until invited, and when present it is a peer with an undo stack of its own. Leaders put the magic button in the way of people who did not ask for it. |
| **Collaboration** | Figma multiplayer | Local-first first; co-editing designed in (CRDT), shipped later. Agents are the first "other actors". | Cursors and presence chips (Figma) when it lands. | People and agents share one presence model, so the comments and cursor UI built for agents in M2 is the human one later. |
| **Timeline (M2)** | CapCut (clear, few tracks), Premiere (dense, precise) | A timeline that is **a lens on the same document**: pages are clips, the HUD acts on ranges, Focus shows CapCut's clarity and Pro shows Premiere's numbers. | J/K/L, Space, `Mod+B` split, ripple delete (muscle memory from every NLE). | One document, no "turn this into a video" export step; the same text, the same colours, animated. |
| **Flows (M2/M3)** | FigJam (calm), n8n (run state) | Record steps → a flow → a unit in the HUD. The graph is read from what the person did, not drawn first. | Node/edge gestures (FigJam). | Nobody records authoring steps into a reusable capability a person can pin to a toolbar. |
| **Notifications** | Figma: inbox of comments and mentions | **None in M1/M2.** Toasts are the only notification; a local-first single-user app has nothing to notify about. An inbox arrives with comments and people (D11, accounts), inside Home, not as a bell. | — | A bell with nothing behind it is clutter. |

## 3. Top gaps, ranked by how much a person would feel them

| # | Gap | Who feels it, when | Filled? | Where |
|---|---|---|---|---|
| 1 | **New design has no custom size** and no orientation; Export has no custom pixel size | Everyone, first minute ("I need 1200 × 628") | **yes** | HOME-FILES §1.3, OVERLAYS §2.3 Export, F-54 |
| 2 | **Density modes are padding, not personalities**; nothing says what each hides per surface | Everyone who switches; first-timers who feel overwhelmed; pros who feel slowed | **yes** | DENSITY-DISCLOSURE §1–7, F-58 |
| 3 | **Clutter**: inspector and dialogs show everything at Standard; no rule for what folds | Everyone, every selection | **yes** | DENSITY-DISCLOSURE §8 |
| 4 | **Import** is images-only and dock-only; no Home import, no drop on Home, no `.iflow`/SVG/PDF/font path spelled out | Anyone bringing work in | **yes** | HOME-FILES §3.1, F-55 |
| 5 | **First run** is implicit; nothing asks for storage persistence or shows the one card that orients | Every new person | **yes** | HOME-FILES §1.4, F-59 |
| 6 | **Find and replace** across pages (text, font, colour) | Anyone with > 3 pages; brand changes | **yes** | STUDIO §9.1, F-56 |
| 7 | **Shortcut cheat sheet** is "a searchable table" with no design | Keyboard users, Figma natives | **yes** | STUDIO §2.3.1, F-57 |
| 8 | **Performance states**: what the canvas shows while tiles render, while a 200-page document loads, when the GPU is lost | Anyone on a slow machine or a big file | **yes** (short) | STUDIO §9.2 |
| 9 | **Resize design** (change page size; content follows) | Canva natives, every social-format job | no → backlog B-5 | — |
| 10 | **Timeline lens UX** (D5 must-have, nothing specified) | Everyone in M3 | **yes** (motion pass) | MOTION-TIMELINE-UX-SPEC §2–§3, §8–§10; engine follow-ups V-1…V-9, V-19 |
| 11 | **Brand panel** (kits, tokens as a surface) | Brand-led users, M2 | no → backlog B-4 | — |
| 12 | **Localisation rules** (none; British English hard-coded in copy rules) | Non-English users, later | **yes** (rules only) | FOUNDATIONS §5.12 |
| 13 | **Pixel lens UX**, **Flow lens UX**, **comments**, **presence** (presentation mode moved to #16) | M2+ | no → backlog B-2, B-3, B-8 | — |
| 14 | **Text had no spec**: no presets, no lists UI, no strikethrough / sub-superscript, no overflow rule, per-keystroke undo, no missing-font flow, no font-adding flow, Mac word/line keys wrong, CJK invisible without a font | Everyone who types a headline; every brand with its own font | **yes** (text pass) | TEXT-FONTS-UX-SPEC §2–§9; engine follow-ups T-1…T-25 (§11.2) |
| 15 | **Appearance had no spec**: the engine renders gradients, image fills, per-side strokes, dashes, glows and blurs that no UI can edit (the panel prints `Linear gradient`); the colour popover was hex-only; no gradient editor, no eyedropper fallback, no contrast check; the page background was one colour; no bevel; no group/ungroup, z-order, hide, rename, copy/paste style actions; no decision on components; the mask rule in F-12 was inverted | Everyone who styles a shape or a page; every brand with a gradient | **yes** (appearance pass) | APPEARANCE-TRANSFORM-UX-SPEC §2–§4, §10; engine follow-ups A-1…A-19 (§10.2) |

| 16 | **Motion had no spec**: no presets, no keyframe UI, no Auto Animate, no transition UI, no audio or caption design, no video export, presentation a paragraph; the owner asked for animate and transition presets, the Auto Animate equivalent and timeline video editing flows | Everyone in M3–M5; every social video job | **yes** (motion pass) | MOTION-TIMELINE-UX-SPEC §4–§7 (presets, keys, Smart move, transitions), §8–§11 (audio, captions, Video export, presentation); engine follow-ups V-1…V-31 (§17.2) |

## 4. Backlog (ranked, for a later pass)

| Id | Item | Depth needed | Reference | Notes |
|---|---|---|---|---|
| B-1 | ~~**Timeline lens**~~ → **worked** 2026-10-26 as `MOTION-TIMELINE-UX-SPEC.md` (tray and lens per density, every gesture and key, presets, keyframes, Smart move, transitions, audio, captions, `Video` export chip, presentation); what remains is the build: engine follow-ups **V-1…V-31** (§17.2: M3 timeline core and MP4, M4 presets / transitions / Smart move / presentation / WebM-GIF, M5 captions / ducking / cutout / Extend) | — | CapCut, Premiere, Final Cut, Keynote, Descript | D5, IF-8, IF-9. Owner questions in the spec §18 (milestone numbering Q1, tray Q2, ripple rule Q3, no trim tools Q4, Space Q5, keyframes Q6, Smart move matches Q7, Video chip Q8, reduced motion Q9, captions Q10, timecode Q11, routes Q12). |
| B-2 | **Pixel lens**: brush, heal, crop UI, adjustments as a stack, "Edit image" entry from the HUD, non-destructive layers, person cutout | Layer 2 section in STUDIO or own file | Photoshop, Adobe Express | IF-8.8 matte UI belongs here. |
| B-3 | **Flow lens**: record-to-flow, step cards, run state, App view form, batch grid, lineage | Layer 2 file | FigJam, n8n | IF-11. |
| B-4 | **Brand panel** (dock tab `Brand`): kit picker, tokens (colours, fonts, logos, spacing), apply token, unresolved-token repair, import a kit from a design | STUDIO §3.5 | Canva Brand Kit | Colour popover's Brand row already specified. |
| B-5 | **Resize design**: Page › Size change with `Keep layout / Scale content / Reflow` and a preview; the Export item-9 question depends on it | OVERLAYS §2.3 sibling | Canva Magic Resize | Needs engine work (constraints). |
| B-6 | **Configurable mini editors** (Chat): which tools a spec exposes, pinning a slot, the person's overrides vs the assistant's spec | CHAT §4.1 | — | D16 pinning rules exist in data, not UX. |
| B-7 | ~~**Presentation mode**~~ → **worked** 2026-10-26 in `MOTION-TIMELINE-UX-SPEC.md` §11 (`▶ Present ▾`, builds and `Builds ▸` order, show keys, presenter window `/s/:asset/presenter`, reduced motion, viewer HTML release); build = V-18 (M4); NAV §2 needs the presenter route and `?present=` row when V-18 is briefed (Q12) | — | Keynote | UX.md §4; F-75. |
| B-8 | **Collaboration hooks**: presence chip model shared by people and agents, cursors, held-element highlight, comments panel and `comment=` | Layer 1 `PRESENCE-COMMENTS.md` | Figma | D11, IF-12.6. |
| B-9 | **Asset and page trash**: deleted media and pages recoverable from the dock (not only designs) | HOME-FILES §2.4, STUDIO §3.2–3.3 | — | Pages already toast with Undo. |
| B-10 | **Shortcut customisation**: rebind in Settings › Shortcuts with conflict warnings, export/import a map | STUDIO §2.3.1 | VS Code | Read-only in M1 by decision. |
| B-11 | **Multi-select on Home** (not only Files): drag-select cards, bulk bar on Home | HOME-FILES §1 | Finder | Files has it. |
| B-12 | **Permissions later**: role matrix for Share, release visibility, read-only link UI | OVERLAYS §2.3 Share | Figma | Needs accounts (D3). |
| B-13 | **Settings field-level spec**: every field's control, default, hint, validation | STUDIO §2.4 | Linear | Sections exist; fields are one-liners. |
| B-14 | **Text engine follow-ups** T-1…T-9 (M1: fixed box + vertical align, undo coalescing, platform caret keys, tofu for missing glyphs, sub/superscript, soft break, WOFF2, Tab in lists, IME bounds bug) and T-10…T-24 (M2: lists markers and levels, highlight, case mark and small caps, OpenType and axes, linked styles, truncate / auto-fit / hyphenation / direction, text on a path, outlines, text stroke, colour emoji, SVG text embed + `missingFonts`, Google Fonts, page number and assistant text actions, drop cap) | TEXT-FONTS-UX-SPEC §11 | Figma, InDesign | Outlets and flows are designed (§11.1); only the build is sequenced. |
| B-15 | **Threaded text boxes, drag-to-move selection, data fields in text, local spelling dictionary** (T-25) | TEXT-FONTS-UX-SPEC §11.1 | InDesign, Docs | M3 / backlog. |
| B-16 | **Appearance and structure engine follow-ups** A-1…A-3 (M1: page fill stack, hidden elements, image crop) and A-4…A-18 (M2: radial aspect, arrowheads, sibling-angle snap, scale tool, constraints, bevel & emboss, image adjustments, gradient text, components and per-instance overrides, named styles, pass-through blend, auto layout, guides, smart spacing handles, pixel snapping) | APPEARANCE-TRANSFORM-UX-SPEC §10.2 | Figma, Photoshop | Outlets and flows are designed (§10.1); only the build is sequenced. A-1 and A-3 are the owner's "page backgrounds like shapes" request. |
| B-17 | **Noise/texture effects, repeat along a path and scatter, gradient interpolation space, colour-blindness preview, mesh gradients** (A-19 and Appendix A M3 rows) | APPEARANCE-TRANSFORM-UX-SPEC Appendix A | Figma 2025, Illustrator | M3 / backlog. |

## 5. Owner questions (recommendation first, then the question)

**Answered 2026-10-25: the owner accepted every recommendation (Q-A to Q-H). Build them as written.**

**Q-A. Export item 9, rewritten in plain words.**

*The situation.* The Export dialog has a row of **presets**: ready-made bundles like `Screen 2×` (a PNG at double
size) or `Social story · 1 080 × 1 920` (a JPG sized for an Instagram story). A preset only chooses the **file type
and the scale**. It never changes the design. Now imagine your page is a **square post, 1 080 × 1 080**, and the
preset row contains `Social story · 1 080 × 1 920`, which is a tall rectangle. What should happen if you press it?

- Option 1 (**recommended**, what the spec says today): the `Social story` chip is **not shown** for this design,
  because the page is not a story. You see only presets that fit the page as it is: `Current size`, `Screen 2×`,
  `Social post`. Nothing ever surprises you; what you export is what you see.
- Option 2: show every preset, and pressing `Social story` **resizes the content** to 1 080 × 1 920 during export,
  stretching, cropping or re-laying-out your square design into a tall one. That is a different feature (**Resize
  design**, backlog B-5): the engine cannot do it yet, and the result would be a guess (what goes in the extra 840
  px of height?).

*Recommendation.* Keep option 1 for M1. Add one visible bridge so people are not confused by a preset "missing": when
at least one preset is hidden because of size, the preset row ends with a muted link `Other sizes…` that opens the
**Page › Size** section (so the person can change the page, then export). When **Resize design** exists (B-5), the
same link reads `Resize design…` and the hidden presets return as `Social story · resize to 1 080 × 1 920`.

*Question back to you.* Is option 1 plus the `Other sizes…` link acceptable for M1, or do you want Resize design
pulled forward so social presets always show? (Resize design is engine work: constraints or scaling rules per
element; roughly an M2 WP.)

**Q-B. Custom size: one block, three homes.** Recommend one **size field pair** (W × H, lock, unit menu `px · mm ·
in · pt`, orientation toggle, `Presets ▾` menu) used on **New design**, in **Page › Size**, and in **Export** (as
pixel output size). In Export the pair never changes the page: typing 2 400 × 2 400 on a 1 080 page sets the scale
(2.22×) and in M1 snaps to the nearest of 1× / 2× / 3× with a hint until arbitrary scale lands. Question: agreed that
export "custom size" means **output pixels at the page's ratio**, and that a different ratio is Resize design, not
Export? (Canva conflates these; we think separating them is clearer.)

**Q-C. Where density lives, in words people read.** The three modes stay (Focus · Standard · Pro). Recommend the
visible names stay as they are, with these one-liners: Focus "Just your work." · Standard "Your work, with the
panels that explain it." · Pro "Everything, with numbers." Alternative names considered and not recommended: "Calm /
Standard / Dense" (Calm sounds like a theme; Dense sounds like a complaint). Question: keep the names?

**Q-D. Density per surface on Home and Chat.** Recommend Home ignores Focus (there is no canvas to focus on) and
has only two looks: Standard and Pro (Pro = list view default, meta columns, smaller cards); Chat honours all three
(Focus hides the threads rail and the header chips). Question: fine to have Home with two looks while the setting
still says three?

**Q-E. First run asks for storage persistence with one sentence.** Recommend the first-run card on Home carries
`Keep my designs on this device` as its one button, which requests `navigator.storage.persist()` on a gesture (Chrome
grants it more often on a gesture), rather than asking silently at boot. Question: acceptable to make the very first
button about storage? The alternative (ask silently, show the state in Settings) risks Chrome evicting a workspace.

**Q-F. Find and replace scope.** Recommend `Mod+F` finds **text** in the whole design (all pages, loose elements),
and the same bar has a `Kind ▾` menu with `Text · Font · Colour`, so replacing a font or a colour everywhere is the
same gesture. Question: should `Mod+F` be stolen from the browser's page find? (Figma does; Canva does not. In Studio
there is no page text to find, so we recommend yes.)

**Q-G. Import of a PDF.** Recommend importing a PDF as **pages of images** in M1 (one page per PDF page, each a
raster image at 2×), with a line saying so, rather than refusing. True vector import is M2 engine work. Question:
acceptable?

**Text pass questions (Q1–Q10, 2026-10-25) are in `TEXT-FONTS-UX-SPEC.md` §12** (Tab while editing, spelling, OCR, font
library and licences, overflow, presets vs linked styles, columns, shadowed shortcuts, zoom to edit, default text).

**Appearance pass questions (Q1–Q11, 2026-10-25) are in `APPEARANCE-TRANSFORM-UX-SPEC.md` §11** (page background as a
page property vs a locked layer, bevel preset vs real effect, components M1/M2, image ratio by default, one popover with
three tabs, the `⌘⌥C` copy-style vs copy-link collision, eyedropper fallback, lock scopes, where effects stop, opacity
keys, rulers in Standard).

**Motion pass questions (Q1–Q12, 2026-10-26) are in `MOTION-TIMELINE-UX-SPEC.md` §18** (milestone numbering M2 vs M3/M4, the
tray under Canvas and Pages, pages ripple while element clips do not, no trim tools, `Space` and focus, explicit first
keyframe, Smart move's visible matches, Video as an Export chip not a tab and pause / resume across reload, reduced motion
never touches export, captions as text presets and on-device transcription, seconds vs timecode, presentation routes).

**Q-H. Cheat sheet shows Mac or Windows, not both.** Recommend the sheet shows the person's own platform with a
small switch `Mac · Windows` at the top (both columns at once double the width and halve the readability).
Settings › Shortcuts keeps both columns as a table. Question: agreed?
