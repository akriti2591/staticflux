# Instaflow motion and timeline — UX specification (Layer 2)

> Status: **normative** for everything marked (a) or (b); **planned** for (c), which is most of this file, because nothing
> temporal is built yet. Written 2026-10-26 from the coordinator's capability table (`handoffs/CAPABILITY-COVERAGE.md`:
> Timeline, video, audio §8; Motion §9; the video slice of Export §29; media generative features §10; timeline and
> transcript agent views §6), backlog B-1 (Timeline lens) and B-7 (presentation mode), and the owner's three asks:
> **presets** for animate effects and page transitions, the **Auto Animate equivalent**, and **timeline-based video
> editing flows** ending in an MP4. Before this file these areas had UX.md §2–§4 and scenarios B–D, REQUIREMENTS §8–§9,
> DOCUMENT-FORMAT §3 (the model) and one GAP-AUDIT row. Those now point here. This file never redefines the model
> (`Temporal`, `Source`, `AudioMix`, `Motion`, `Animation`, `Transition`, `Track`); it says what a person sees and does.
>
> **Letters** (the Export, Text and Appearance convention): **(a)** the engine does it today · **(b)** UI only over an
> existing service · **(c)** engine or editor-worker work with a milestone from `PLAN.md` §2 (**M3** Timeline, **M4**
> Motion & presentation, **M5** Reaction & generative). FOUNDATIONS §5.6 applies: **a (c) control is not rendered before
> it lands** — no greyed row, no "soon" tag; the Timeline lens itself appears only with content (STUDIO §2.1). Every (c)
> has a milestone in §17.2 and, by the owner's standing rule, every feature, deferred or not, has its **outlet and its
> flow to completion and follow-up** in §17.1, so building it later never needs a redesign.
>
> Conventions kept and why: `Space` play/pause, `J`/`K`/`L` shuttle, `I`/`O` in and out, `M` marker, `S` split at the
> playhead, `←`/`→` one frame, `↑`/`↓` edit points, `Home`/`End`, `Shift+Delete` ripple delete, `N` snapping, `=`/`−`
> timeline zoom — the muscle memory of every NLE (Premiere, Final Cut, DaVinci, CapCut's desktop app all agree on these).
> Trim by dragging a clip edge, overlap blocks for transitions, diamonds for keyframes, a red playhead line: forty years of
> meaning. Departures are marked **Departure** inline and gathered in §1.2.

## 0. Reading map and the engine today

### 0.1 What exists (so nobody re-specifies it)

| Piece | Today | Letter |
|---|---|---|
| **Model** (DOCUMENT-FORMAT §3.2): `Temporal { start, duration }`, `Source { asset, in, out, speed, reverse, loop, freezeAt, crop }`, `AudioMix { volume, pan, fadeIn, fadeOut, muted, preservePitch }`, `Track { trackKind video · overlay · text · audio, muted, locked, volume }`, `Motion { in, emphasis, out, loop, text { unit, stagger }, matchKey }`, `Animation.channels[path].keys[id] = { t, value, interp hold · linear · bezier · spring, ease, spring }`, `Transition { from, to, preset, duration, alignment, params }`, `Page.advance auto · click`, `Composition.format.fps`; story time = page durations minus transition overlaps; motion presets are `motion-preset` tree assets with a `slug` | on paper (the document format), no component registry entries, no CRDT parts, no evaluator | (c) M3 (temporal, source, audio, keyframes), M4 (motion, transitions, presets) |
| `lineage.key` **match key** on every element, deterministic keys on repeat instances (`key~k`, IF-26.18), kept by duplicate and expand | `components.ts`, `repeat` | (a) — the one motion primitive that exists |
| Timeline **lens declaration**: id, label, blue `video` palette, shortcut `3`, tools `[select, split(S), hand]`, HUD `[animate, ask]`; the lens falls back to the Canvas arrangement (`lens-features.ts`) | `studio-contributions.ts`, `studio-spec.ts` | (a) declaration; the lens renders nothing timeline-shaped and is **not shown** in M1 (STUDIO §2.1, F-23) |
| `Animate` HUD action declared for Canvas, Pages and Timeline; `runHudAction` speaks "arrives in a later milestone" | `studio-contributions.ts`, `studio-app.ts` | (a) declaration; **VBDN** today, not rendered after B11b until M4 |
| Assets: video and audio **kinds** are classified at import (`MEDIA_TYPES`), listed with the blue / video lens mark; renditions table says posters and waveforms arrive with M3; no probe for duration or codec | `library/ingest.ts`, `renditions.ts` | (a) listing; (c) probe, proxy, filmstrip, waveform M3 |
| Export: PNG · PDF · SVG; one job at a time; frozen snapshot; `AbortSignal` per step; progress per page and chunk; `IF-EXP-001…008` | `export/` | (a); **video encode (c) M3** (MP4), M4 (WebM, GIF, sequence, audio-only) |
| Render: scene IR, Vello, tiles; `VideoFrame` external textures, the motion evaluator override and the audio ring are **architecture only** (ARCHITECTURE §2, E-6) | `render/` | (c) M3 |
| Reduced-motion preference fact; `motion.*` tokens; `withViewTransition` | `@staticflux/a11y`, `ui/theme`, `shell` | (a) for chrome; (c) for content preview (IF-9.7) |
| Agent views: `layout` codec exists; `timeline` and `transcript` codecs are defined (DOCUMENT-FORMAT §5: OTIO-shaped seconds; `[w101 11.20–11.48 "wait,"]`) | `@staticflux/agentview` | (c) M3 / M5 |

### 0.2 Reading rules

Implementers of the tray and the Timeline lens read §2 (anatomy per density), §3 (every gesture and its key), §5 (keyframes)
and §17.1 (every feature's outlet and flow); the pill and inspector read the control tables §3.6, §4.5, §7.4, §8.5; the
presets sheet reads §4; Smart move reads §6; the Export dialog reads §10; presentation reads §11; errors §12; fidelity §13;
performance §14; a11y §15. FLOWS F-73…F-81 are the acceptance tests. Appendix A is the exhaustive checklist (every control
CapCut, Premiere, Final Cut, DaVinci, Descript, Keynote, Figma, Canva, After Effects, Rive and Lottie offer: include ·
defer · reject); Appendix B maps the coordinator's capability rows.

## 1. Principles, market analysis and departures

### 1.1 Principles

1. **One document, one clock.** A page is a clip; a clip is a page with a duration. The same text, colours, fills and
   effects that F-65…F-72 edit are what moves. There is no "convert to video" step and no second document (UX.md §4, D4,
   D19). `evaluate(stage, t)` is the only truth for preview, scrub, thumbnails, export and agents (IF-8.3).
2. **Animate before keyframe.** A person animates with a **preset** in one click from the pill; keyframes are the Pro
   tier underneath, always reachable, never required (scenario C: "without touching a keyframe"). `Bake to keyframes` turns
   a preset into keys when someone wants to tune beyond its parameters.
3. **The tray answers "animate this"; the lens answers "edit this cut".** A one-strip **timeline tray** rides under the
   Canvas and Pages lenses so motion is edited where the layout is; the **Timeline lens** is the full editor with tracks.
   Same model, same keys, same playhead; nothing learned in one is different in the other.
4. **What you scrub is what you export.** Timing, layout, text animation and transitions are evaluated by the same pure
   function at the same frame grid. Preview may be softer (proxies) and may drop frames to keep audio honest (IF-8.3);
   it never shows a different frame *content* at a given `t` (§13).
5. **Everything is a selection with a pill.** A clip, a range, a gap between pages or clips, a keyframe, a transition,
   a caption word: each is a first-class selection (UX.md §2) with its own six actions and `⋯ More`. No modal tools
   beyond Split and Hand.
6. **Direct first, numeric always; keyboard everywhere.** Every drag has a field; every field has a key; every key is in
   `?` and Settings › Shortcuts. The transport is operable with one hand on `J K L Space I O S M`.
7. **Honest time.** Durations show as seconds with one decimal for people (`0:12.4`) and as timecode in Pro
   (`00:00:12:10` at the composition's fps). Snapping to the frame grid is always on for commits (a keyframe between frames
   cannot be exported), and the UI never shows a time that is not on the grid.
8. **Presets are assets** (IF-9.2): they live in Assets › Motion, carry a slug, travel with templates and brand kits, and a
   person can save their own. An agent applies the same slugs a person clicks.

### 1.2 Market analysis: where to match, where to be better

| Area | Leaders | Instaflow: the best version | Convention kept, why | **Departure, why better** |
|---|---|---|---|---|
| Timeline model | Premiere, DaVinci: media-first sequences of clips; CapCut: a main track plus overlays; Keynote, Canva: slides with durations and a separate "video" export | Pages are clips on one **story track**; element tracks (overlay, text, audio) live inside a page; story-level audio spans pages (DOCUMENT-FORMAT §3.1) | Main-track-plus-overlays reading order (CapCut), tracks stacked with audio below (every NLE) | The story track is **the Pages filmstrip laid in time**: reordering a page in Pages reorders the clip; a transition on the gap is the same node in both. Canva and Keynote keep two mental models (slides vs video); ours has one |
| Trimming | Premiere: tool-switching (ripple, rolling, slip, slide tools); Final Cut: magnetic timeline, one Trim tool with position-dependent cursors; CapCut: drag edges, auto-ripple | No trim tools. A clip edge drags; the **cursor and a modifier** choose ripple (default on the story track: pages are sequential), roll (`Alt` on a shared edge), slip (`Alt` inside a clip), slide (`Alt+Shift` inside a clip). A two-line label names the edit live | Edge-drag trims; Final Cut's magnetic story track; Premiere's `Q`/`W` ripple-to-playhead | **No tool mode for trimming**: the gesture reads from where you grab and what you hold, and the label under the pointer says which edit you are making (`Ripple trim · −0.4 s · 3 clips move`). Modifiers are the same three Studio already uses (Alt, Shift, Mod) |
| Keyframes | After Effects: stopwatch per property, graph editor; Premiere: effect controls lane; Figma/Canva: none; Rive: states and a timeline per artboard | A **diamond `◇` beside every animatable field** (click = key at the playhead); a keyframe strip under the clip in Standard, per-property lanes and a value graph in Pro | AE diamonds and lanes; graph editor shape | **No stopwatch**: the first key is explicit (click `◇` or apply a preset); after that any field change at a new time adds a key *and says so* in the field's hint (`Key added at 1.2 s`), so nobody animates by accident (AE's most common beginner error) |
| Easing | AE: bezier handles and Easy Ease; Rive: cubic picker with presets; CSS tooling: named curves | A **curve picker**: ten named curves with a live ball-drop preview, `Custom ▸` opens bezier handles or spring sliders | Named curves people know (Ease in/out), bezier handles | Springs are first-class and **pre-sampled deterministically** (IF-9.1), so a spring exports identically; AE has none, Rive's are not exportable to video |
| Presets | Canva: Rise, Pan, Fade, Pop, Wipe… per element with a style sheet and speed; Keynote: Build In/Out/Action with a preview; PowerPoint: a long list; CapCut: In/Out/Combo with a duration slider | A **preset sheet** with tabs `In · Emphasis · Out · Loop`, tiles that **preview on the element itself** when hovered, parameters (duration, delay, direction, distance, curve), text units (letter · word · line, stagger, order); page-level `Animate all` with stagger | Canva's words (`Rise`, `Pop`, `Wipe`), Keynote's In/Out split | Previews run **on the real element in place**, not on a thumbnail of a square; presets are **assets** you can save, share through a brand kit and address from chat by slug; `Bake to keyframes` is one click |
| Auto Animate | Keynote Magic Move (objects copied between slides tween; matching by object identity); Figma Smart Animate (matching by layer name); Canva Magic Animate (a style applied to the whole design) | **Smart move**, a page transition that tweens every element whose **match key** appears on both pages (IF-9.3, `lineage.key`). The gap pill shows `12 matched · 2 unmatched`; a `Match ▾` list lets a person link or unlink pairs | Keynote's gesture (duplicate the page, move things, pick the transition); Figma's name | Matching is **explicit and visible**: the pairing list is a thing you can see and fix, and duplicates, repeats (`key~k`) and expanded repeats carry keys deterministically, so the match never breaks because a layer was renamed (Figma's failure) or re-created (Keynote's) |
| Transitions | Premiere: a drag-in overlap icon with Effect Controls; Final Cut: overlap block with a preset browser; Canva: a per-page transition menu; CapCut: a `|` button between clips | A **gap** between pages or adjacent clips is a selection; its pill shows `Transition ▾ · Duration · Smart move` and the sheet's `Transitions` tab; the overlap draws as a block with trimmable duration | Overlap block (every NLE); `+` dot between clips (CapCut) for discoverability | The same sheet, preset model and node serve **pages and clips** (IF-9.3), and `Apply to all gaps` is one click; reduced motion turns every transition into a fade in the editor without touching the document |
| Scrubbing and playback | Premiere/Resolve: audio-master, JKL, frame-accurate; CapCut: snappy proxies | Audio-master preview (IF-8.3), proxies by default (IF-8.5), coarse-then-exact scrubbing (IF-8.4), `J`/`K`/`L` with rates ±1 · 2 · 4 · 8×, frame step, a **hover scrub** on the ruler that shows the frame in the preview without moving the playhead (`Alt`) | JKL, Space, frame step, red playhead | Scrub preview is **the canvas itself** (the page at `t`), not a separate program monitor: in the tray you see your layout animate under the real inspector |
| Audio | Premiere: mixer panel, rubber-band gain; CapCut: volume slider and fades; Descript: studio sound | Clip gain in the pill, track fader in the header, master meter in the transport bar, **fade handles** at clip corners, equal-power crossfade when clips overlap, `Auto-duck under voice` (M5) | Fade handles (Final Cut), rubber band (Pro), meters | Fades and crossfades need no effect to be dragged in; ducking is a toggle on the music clip, not a side-chain graph |
| Captions | Descript: transcript *is* the editor; CapCut: auto captions with bold styles; Premiere: speech-to-text + caption track with styles | A transcript asset with word timing (IF-8.9); a **Transcript** dock tab; a caption track rendered by the text pipeline with **caption style presets**; `Edit by transcript` (delete words = ripple cut) | Descript's text-edit-is-video-edit; CapCut's style tiles | Captions are **text elements** with every TEXT-FONTS control, keyed per word by the same animation model (karaoke highlight is a text animation, IF-9.4); styles are text presets, not a separate system |
| Export | Premiere: Media Encoder presets; CapCut: resolution/fps/bitrate; Canva: MP4 with a quality dropdown | A `Video` chip in the **existing Export dialog**: container, size (the page), fps, quality, range, captions, audio; an estimate of size and time **before** pressing Export; a pausable, resumable render (GOP checkpoints, IF-8.10) | MP4 (H.264 + AAC) default; fps from the composition | One dialog for stills and video (no "Download as video" elsewhere); **pause and resume** of a render survives a reload (nobody does this in a browser) |
| Presentation | Keynote: Play, presenter display, builds on click; Pitch: web present; Canva: present with timer | `▶ Present` full screen; pages with transitions and on-click builds; a presenter window (notes, next page, timer); reduced motion → fades; the same evaluator | Keynote's keys (arrows, Space, `B`, `W`, number + Enter, Esc) | A present session is **the Timeline paused at page starts**: the same transitions you exported; an `advance: click` page is a clip whose duration is its hold |

### 1.3 Vocabulary

| Word | Means |
|---|---|
| **Story** | The pages in order (Pages lens); in time, the **story track** |
| **Clip** | Anything with `temporal`: a page on the story track, or a video / image / text / audio element on a track inside a page |
| **Range** | A span of story time with in and out points, with or without clips under it (`I`/`O`, or a drag on the ruler) |
| **Gap** | The join between two adjacent pages or clips; selecting it edits the **transition** (or adds one) |
| **Edit point** | A clip boundary; `↑`/`↓` jump between them |
| **Playhead** | The red line and its time; the canvas shows the document at that time |
| **Preset** | A motion asset: an animate effect (in · emphasis · out · loop · text) or a transition |
| **Key** | A keyframe `◇` on one property channel |
| **Tray** | The one-strip timeline under the Canvas and Pages lenses (§2.2) |
| **Lens** | The Timeline lens: preview above, tracks below (§2.1) |

<!-- CONTINUE -->
