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

## 2. Anatomy: the Timeline lens and the tray, per density

### 2.1 The Timeline lens (`3`)

The lens appears in the switcher once the document holds motion, a video or audio asset, or a second page with a
transition (STUDIO §2.1); it also appears the moment a person presses `Animate` for the first time (the preset sheet opens
and the lens slides in behind it), so the path from "animate this" to "see it in time" is one key.

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ top bar: logo · title · ● Saved · [Canvas · Pages · Timeline]  View ▾  Milestone  ⋯  ▶ Present  Export │ 56
├──────────┬──────────────────────────────────────────────────────────────────┬──────────────────┤
│ dock     │  PREVIEW = the canvas, camera fitted to the current page,        │ inspector        │
│ Layers   │  showing the document at the playhead time; handles, pill and    │ Clip · Timing    │
│ Pages    │  inspector work exactly as in Canvas; the page edge is the frame │ Audio · Motion   │
│ Assets   │                                                                  │ Keys (Pro)       │
│ Transcript│                                                                 │                  │
│ Milestones│  ┌ pill ───────────────────────────────────┐                     │                  │
│          │  │ Text · Headline  Aa ▾  Colour  Animate ▾ ⋯ │                   │                  │
├──────────┴──┴──────────────────────────────────────────┴─────────────────────┴──────────────────┤
│ transport: ⏮ ◀◀ ▶ ▶▶ ⏭   0:12.4 / 0:30.0   [in 0:03.0 · out 0:18.5]   ◉ snap  🔊 ▁▃▅ meter  −  ●──  +  fit │ 40
├───────────────┬──────────────────────────────────────────────────────────────────────────────────┤
│ track headers │ ruler  0:00 ····· 0:05 ····· 0:10 ····· 0:15 ····· 0:20 ···  ▼ markers         │
│ ▣ Story       │ [ Page 1 · 5.0 s     ]⟋[ Page 2 · 6.0 s  ]⟋[ Page 3 ····· ]     ◆ keys strip     │
│ ▢ Overlays  ◉ │        [ reaction.mp4 ····· ]        [ logo.png ]                                │
│ T  Text     ◉ │   [ Headline ]      [ Caption · karaoke ····· ]                                  │
│ ♪  Audio    ◉ │ [ music.mp3 ▁▂▃▅▃▂▁▂▃▅▃▂▁▂▃▅▃▂▁ ·········· fade ⟍ ]  ────── gain line ──────    │
│ CC Captions   │   [ "wait, what?!" ][ "that's the one" ]                                         │
└───────────────┴──────────────────────────────────────────────────────────────────────────────────┘
                                             ▲ playhead (red, full height, with a time flag on the ruler)
```

| Region | What it is | Rules |
|---|---|---|
| **Preview** | The Canvas lens's surface with the camera fitted to the current page (the page whose clip is under the playhead), everything else dimmed to 20 % (loose elements and other pages are still selectable). Shows `evaluate(stage, t)`. | Handles, the pill, the inspector, snapping and text editing work unchanged (principle 1). Editing while the playhead is inside an animated range edits the **value at that time**: with keys on that property it adds or moves a key (§5.3); without keys it edits the base value. The preview never writes the CRDT during playback (E-6). |
| **Transport bar** (40 px) | `⏮` to start · `◀◀` (`J`) · `▶`/`⏸` (`Space`) · `▶▶` (`L`) · `⏭` to end · the **time** `0:12.4 / 0:30.0` (click = type a time; Pro: timecode `00:00:12:10`) · the in/out chip when a range exists (`I`/`O`) · `◉ Snap` toggle (`N`) · the **master meter** (stereo, peak hold, red over −1 dBFS) with a mute · timeline zoom `−` `●──` `+` and `Fit` (`Shift+Z`) · `⋯` (loop playback, audio scrubbing, preview quality, frame rate). | Shared by the lens and the tray. Keyboard: `F6` cycles regions (STUDIO §11), the bar is a `toolbar`. |
| **Ruler** | Story time in seconds (ticks every frame at high zoom, every 1 s · 5 s · 10 s as you zoom out); the playhead's flag; **markers** `▼` (`M`); the in/out range as a tangerine band; transition overlaps as hatched bands. | Click = move the playhead (snaps to frames); drag = scrub; `Alt`+hover = **hover scrub** (the preview follows the pointer, the playhead stays). Right-click: `Add marker`, `Set in`, `Set out`, `Clear range`, `Go to…`. |
| **Track headers** (176 px) | One row per track: kind icon, name (inline rename), **eye** (video / overlay / text) or **mute** `◉` and **solo** (audio), **lock**, and for audio a 60 px **fader** (track volume) with a mono dB value on hover. Story track: the lens mark, `Story`, no eye (it is the document), a `fps · size` mono tag in Pro. | Drag a header to reorder tracks; `+ Add track ▾` at the bottom (`Overlay · Text · Audio`); height handle between rows; double-click a header to toggle tall / short. |
| **Story track** | Pages as clips in order with their name, duration and a filmstrip of their first frame; the `⟋` **gap** between two pages (a 12 px hit zone that widens on hover with a `+` dot) is the transition selection; an existing transition draws as an overlap block labelled with its preset (`Smart move · 0.6 s`). | A page's clip always ripples (pages are sequential). `advance: click` pages show a hand glyph at their end (§11). Dragging a page clip reorders the story, which is **the same edit** as dragging a Pages thumbnail (IF-23.21). |
| **Element tracks** | Inside the current page's time span (pages are the containers, DOCUMENT-FORMAT §3.1): video and image clips show a filmstrip; text clips show the text; audio clips show the waveform (multi-resolution peaks) with the **gain line** and **fade handles**; captions show their words. A clip with motion shows a small `◆` strip under it (its keys, §5.2). Clips outside the current page are drawn at 40 % so the story's whole time stays legible. | Tracks of other pages are visible but folded to 8 px lines until the playhead or the selection enters that page (the page is the scope, like Final Cut's compound clip opened in place). |
| **Keys strip** (Standard) / **Key lanes** (Pro) | Standard: one strip of `◆` under a clip when it has keys or a preset (`In · Fade up` labels at the key cluster). Pro: a disclosure on the clip header opens one lane per animated property (`Opacity`, `X`, `Scale`…), with the value graph toggle. | §5. |
| **Transcript** dock tab | Appears when a transcript asset exists (M5). Words in paragraphs with speaker labels; the current word highlighted during playback; selecting words selects the matching range (and vice versa). | §9. |
| **Inspector** | Sections per selection kind (§3.6 control tables): `Clip` (name, source, in/out, speed, reverse, loop, freeze), `Timing` (start, duration, delay for element clips), `Audio` (gain, pan, fades, mute, pitch), `Motion` (in · emphasis · out · loop presets with parameters; text units), `Keys` (Pro: the keyed properties with their curves), plus every section from APPEARANCE and TEXT for the element itself. Page selected: `Page` gains `Duration`, `Advance ▾ (Auto · On click)`, `Notes` (for the presenter). Gap selected: `Transition` (preset, duration, alignment, params; Smart move's `Matches`). | DENSITY tiers in §2.3. |

### 2.2 The tray (under Canvas and Pages)

The **tray** is the Timeline lens's story track and transport without the element tracks: one strip, 112 px (Standard), docked
to the bottom of the canvas region above the command bar. It shows the story in time, the playhead, the keys strip of the
**selected element** (not every clip), markers, and transitions. Why: a person animating a headline in the Canvas lens wants
to scrub and see it move without leaving their layout; nobody needs five tracks for that. `Shift+T` toggles it; it opens by
itself the first time a page gets a duration, a transition or a preset, and when `Animate` is pressed. In the Pages lens the
tray and the filmstrip are **the same strip**: the filmstrip's thumbnails become clips with durations when the tray is open
(the story is one thing seen two ways, principle 1). A person who wants more drags the tray's top edge up: past 200 px it
becomes the full track area, and the lens switcher moves to Timeline (`3`), which is how most people will first meet the lens.

### 2.3 Per density

| Part | Focus | Standard | Pro |
|---|---|---|---|
| Lens chrome | Preview edge to edge; the transport bar floats as a pill (`▶ 0:12.4` + meter) bottom-centre over the preview; tracks hidden until summoned (`Shift+T` opens them as a floating sheet that leaves on the next preview click) | Transport bar docked; track area 240 px (resizable 160–480), **one row per kind**: `Story`, `Overlays`, `Text`, `Audio`, `Captions`; several tracks of a kind fold into one row and unfold on click of the header chevron | Track area 320 px default; **every track its own row** with heights remembered; key lanes available; the ruler shows frames at high zoom; timecode `00:00:12:10`; a mono `fps` tag; the keys strip shows values on hover; the value graph toggle in the clip header |
| Tray (Canvas / Pages) | Hidden; `Shift+T` shows a floating strip for the session | 112 px docked; story clips with filmstrips, the selected element's keys strip, transport | 136 px; also the selected element's property lanes folded (chevron), timecode |
| Clip labels | Name only | Name · duration (`Page 2 · 6.0 s`) | Name · in–out · speed when ≠ 1× · a `◆ 7` key count |
| Pill (clip, range, gap, key) | The same six | same | same + second tooltip line + units |
| Inspector | Rail: Clip · Motion · Audio icons | `Clip`, `Timing`, `Motion` at rest; `Audio` and `Keys` ▸ with summaries (`Audio · −6 dB · fades`) | Everything open; `Keys` lists every channel with its curve glyph and an inline curve picker |
| Transport time | `0:12.4` | `0:12.4 / 0:30.0` | timecode + frame counter + dropped-frame dot during playback (DevTools has the numbers) |
| Preset sheet | Tiles only, parameters behind `Tune ▸` | Tiles + Duration and Direction visible; the rest behind `More ▾` | Everything open, curve picker inline, `Bake to keyframes` visible |
| Curve picker | Named curves | Named curves + `Custom ▸` | Open on the bezier editor with handles' values as mono fields |

What a mode never does (DENSITY §1): move a control, change a gesture, change a key, change colour. A clip's edge trims the
same way in every mode.

## 3. Every gesture and its keyboard path

Scope rule: the keys below act when **focus is in the tray, the track area or the transport bar**, when the **Timeline lens**
is active (whatever has focus, unless it is a text field or the text editor), or when the pointer is over the tray. In the
Canvas / Pages lens with the tray open and focus on the canvas, `Space` keeps its canvas meaning (hold to pan) and the
transport is reached by `F6` or a click; this is the one place a key's meaning depends on focus, and the transport's `▶`
tooltip says so (`Play · Space · when the timeline has focus`). Letters never fire while typing (FOUNDATIONS §5.7).

### 3.1 Playhead, transport and navigation

| Action | Pointer | Key (Mac = Win unless noted) | Notes |
|---|---|---|---|
| Play / pause | `▶` | `Space`; `K` also pauses | Playback is audio-master; on pause the preview snaps to the exact frame |
| Shuttle back / stop / forward | `◀◀` · `▶▶` | `J` · `K` · `L` | Repeated `J`/`L` steps 1 → 2 → 4 → 8×; `K` stops; `K`+`J`/`L` held = slow 0.25× (Premiere) |
| Frame back / forward | — | `←` / `→` | 1 frame. **Departure:** `Shift+←/→` = **1 second** (Premiere's 5 frames is for frame-accurate editors; one second is what non-editors reach for). `Alt+←/→` = previous / next **key** of the selection |
| Previous / next edit point | — | `↑` / `↓` | Clip boundaries on every visible track; with a selection, that clip's boundaries only |
| Start / end | `⏮` · `⏭` | `Home` / `End` | Of the story, or of the in–out range when one exists |
| Go to time | click the time | `Alt+G` | Opens the time field; type `12.4`, `1:02`, `+2s`, `-10f`, Enter (`Mod+G` stays Group) |
| Set in / out | drag on the ruler; right-click | `I` / `O` | Range band on the ruler; `Shift+I` / `Shift+O` go to in / out |
| Mark clip as range / clear range | pill `Range` | `X` / `Alt+X` | `X` on a clip sets in–out to it (Premiere) |
| Loop playback | transport `⋯` | `Alt+L` | Loops the range, else the story (`Mod+Shift+L` stays Lock) |
| Scrub | drag the playhead or the ruler | `J`/`L` at 0.25× | Coarse frames while moving fast, exact on settle (IF-8.4); audio scrubbing off by default (`Shift+S` toggles) |
| Hover scrub | `Alt`+hover on the ruler or a clip | — | Preview follows the pointer; the playhead stays; releasing `Alt` snaps back |
| Zoom timeline | `−` `+` slider; `Mod`+wheel over tracks; pinch | `=` / `−`; `Shift+Z` fit; `Alt+Shift+Z` fit range | Zoom centres on the playhead (keyboard) or the pointer (wheel); wheel alone scrolls time, `Shift`+wheel scrolls tracks |
| Marker | ruler right-click; `▼` click to select | `M` add at the playhead; `Shift+M` add with a name; `Alt+M` / `Alt+Shift+M` next / previous marker | Markers carry a name and a colour chip; they export as chapters in MP4 when `Chapters` is on (§10) and never render |
| Snapping | transport `◉ Snap` | `N` | Snaps the playhead, clip edges and keys to: edit points, markers, the playhead, in/out, the frame grid (always), other tracks' edges within 6 px; hold `Mod` to suspend (the canvas convention) |
| Preview quality | transport `⋯ › Quality` | — | `Auto` (proxies during playback, originals when paused), `Full`, `Draft` (half resolution). Never changes what is exported (§13) |
| Full-screen preview | `⤢` on the preview edge | `Shift+F` | A chrome-free preview with the transport pill; Escape returns. Not presentation mode (§11): this plays the story as video |

### 3.2 Selection

| Target | Pointer | Keyboard | The pill shows (≤ 6, then `⋯`) |
|---|---|---|---|
| **Clip** (page or element) | Click; `Shift+click` adds; `Mod+click` toggles; marquee over tracks | `Tab` / `Shift+Tab` next / previous clip on the track; `Alt+↑/↓` track above / below at the same time; `Mod+A` all clips on the track, twice for all | Page clip: `Duration` · `Transition ▾` (the gap after it) · `Advance ▾` · `Duplicate` · `Delete`. Video clip: `Speed ▾` · `Volume` · `Split` · `Animate ▾` · `Duplicate` · `Delete`. Image / shape / text clip: the element's own pill with `Animate ▾` in slot 4 (UX.md §2) |
| **Range** | Drag on the ruler or across empty track space | `I`/`O`; `X` | chip `0:03.0 – 0:18.5 · 15.5 s` · `Split at edges` · `Speed ▾` · `Zoom here` · `Export range…` · `Delete` (ripple) · M2+: `✦ Regenerate`, `✦ Extend from here` |
| **Gap** (between pages or adjacent clips) | Click the `⟋` zone / the `+` dot; click an existing overlap block | From a selected clip: `Mod+→` / `Mod+←` selects the gap after / before it | chip `Gap · Page 2 → 3` · `Transition ▾` (preset) · `Duration` · `Smart move` (one-click apply) · `Apply to all gaps` · `Remove` |
| **Key** | Click a `◆`; `Shift+click` adds; marquee in a lane | `Alt+←/→` jumps the playhead between keys; `Shift+K` adds a key at the playhead for the focused field | chip `Opacity · 1.2 s` · value field · `Curve ▾` · `Hold` toggle · `Duplicate` · `Delete` |
| **Transition** (an overlap block) | Click | as Gap | chip `Dissolve · 0.6 s` · `Preset ▾` · `Duration` · `Align ▾` · `Apply to all` · `Remove` |
| **Caption** (a caption clip or a word) | Click the caption clip; double-click a word to edit | `Tab` between captions; arrows between words when editing | `Style ▾` · `Font ▾` · `Size` · `Colour` · `Split caption` · `Delete` (§9) |
| **Track** | Click the header | `F6` to headers, arrows | header actions only (eye / mute / solo / lock / fader / rename / delete) |

Selection persists across lenses (UX.md §4): select a headline in Canvas, press `3`, and its clip is selected with the
playhead unchanged.

### 3.3 Trim, move, split and the edit family

No tool modes. The cursor names the edit before you press, and a two-line label follows the pointer while you drag (`Trim end ·
6.4 s (+0.4)` / `Ripple · 3 clips move`). All times snap to frames; `N` snapping applies; `Mod` suspends snapping; Escape
cancels the drag; every drag is one undo step named after the edit.

| Edit | Gesture | Keyboard | On the story track (pages) | On element tracks |
|---|---|---|---|---|
| **Move** | Drag the clip body | `,` / `.` nudge 1 frame; `Shift+,` / `Shift+.` 1 second; `Alt+↑/↓` to another track | Reorders pages (the clip drops between neighbours; never overlaps) | Moves in time; dropping over another clip **overwrites** by default with a hatched preview; `Shift` while dropping **inserts** (ripples the track); dropping on a gap snaps to edges |
| **Trim** (edge) | Drag a clip's start or end edge | Select the edge (`[` / `]` from a selected clip), then `,` / `.` | Changes the page's duration; everything after **ripples** (pages are sequential). Minimum 1 frame; a page can be longer than its content | Changes in/out; neighbours stay (a gap opens or the clip stops at the neighbour); `Shift` while dragging = ripple |
| **Trim to playhead** | — | `Q` (start to playhead) / `W` (end to playhead) | Ripple | Ripple (Premiere's `Q`/`W`) |
| **Extend edit** | — | `E`: the nearest edge of the selected clip moves to the playhead | | |
| **Ripple delete** | pill `Delete` on a page; `Shift+Delete` on an element | `Shift+Delete`; `Delete` on a page | Delete always ripples (no empty page time) | `Delete` leaves a gap; `Shift+Delete` closes it. Deleting a **range** (`X` then `Delete`) ripple-cuts across every unlocked track with a confirm chip when more than 3 clips are touched |
| **Roll** (move the join, both clips) | `Alt`+drag the shared edge | `Alt+,` / `Alt+.` on a selected edge | Moves the join between two pages (one shortens, the next lengthens; total unchanged) | Same, for touching clips |
| **Slip** (change what plays, not where) | `Alt`+drag the clip body | `Alt+,` / `Alt+.` on a selected clip | — (pages have no source) | The filmstrip slides under the clip; the label shows `in 2.0 s → 2.4 s`; preview shows the first and last frame side by side in the preview (Premiere's slip display) |
| **Slide** (move the clip, neighbours absorb) | `Alt+Shift`+drag the body | `Alt+Shift+,` / `.` | — | The clip moves; the previous clip lengthens and the next shortens by the same amount |
| **Split** | Tool `S` then click a clip; or pill `Split` at the playhead | `S` splits every selected clip at the playhead (no selection: every clip under the playhead on unlocked tracks) | Splits a page into **two pages** with the same content and the animation split by time (keys before the cut stay, keys after move to the new page with times rebased); the Pages panel shows both | Splits the clip; a transition on the cut edge is removed with a 1.5 s toast |
| **Join** (undo a split) | pill on two adjacent clips from one source `Join` | pill only (`Mod+J` is Chrome's downloads) | Two pages from one split with no edits between them re-join | Adjacent clips from one asset with continuous in/out |
| **Duplicate** | `Alt`+drag; pill | `Mod+D` | Duplicates the page after itself (keeps match keys, §6) | Duplicates after itself on the same track |
| **Lift** (remove, leave a gap) | pill `⋯ › Lift` | `Delete` on element clips | — | Standard behaviour of `Delete` |
| **Link / unlink audio and video** | pill `⋯ › Unlink audio` | `Alt+Shift+L` (Lock stays `Mod+Shift+L`) | — | A video clip's audio is **linked** (one clip, waveform under the filmstrip) until unlinked; then an audio clip appears on the Audio row, selected together while linked (Premiere's linked selection) |
| **Detach audio** | pill `⋯ › Detach audio` | — | — | Unlink and mute the video's own audio in one step (Final Cut) |
| **Speed** | pill `Speed ▾` (0.25 · 0.5 · 1 · 1.5 · 2 · 4×, `Custom…`); speed has **no key** (menu + field; `R` is a tool, `Shift+R` rulers) | — | A page's duration is its speed (there is no source); the menu is not rendered | Constant speed changes the clip's duration in place (ripple with `Shift`); pitch preserved by default (`Pitch ▾ Preserve · Follow`); `Reverse` toggle; speed ramps are M5+ (Appendix A) |
| **Freeze frame** | pill `⋯ › Freeze frame` | `Alt+F` | — | Splits at the playhead and inserts a 2 s hold of that frame (`freezeAt`); the hold's duration trims like any clip |
| **Zoom here / punch-in** | range pill `Zoom here`; or `Z` then drag a rectangle on the preview | `Z` enters "zoom here": drag a rectangle on the preview → eased scale + anchor keys over the range (IF-9.5) | Applies to the page's camera (a page-level `scale`/`anchor` channel) | Applies to the clip |
| **Lock / unlock a track** | header lock | `Mod+Shift+L` with the header focused | Story cannot be locked (it is the document) | Locked tracks ignore ripple and marquee |
| **Add track** | `+ Add track ▾` | `+` button and palette only (`Mod+N` is browser-reserved) | — | Overlay · Text · Audio |
| **Reorder tracks** | drag a header | `Alt+↑/↓` with the header focused | — | Z-order of overlays follows track order (top row = front), the same as Layers |

Cursor set: trim `⇤|⇥`, roll `⟷|`, slip `⇆` (with `Alt`), slide `⇄` (`Alt+Shift`), ripple adds a small tail glyph, snap shows
a tangerine line across all tracks at the snap target (the canvas smart-guide colour), overwrite shows the covered range hatched.

### 3.4 The keyboard map (added to STUDIO §7 as a `Timeline` group)

All keys are registered through the shortcut registry with scope `timeline`; `?` lists them under `Timeline` and `Presentation`.
Conflicts checked against STUDIO §7: `S` (split) shadows nothing in Timeline scope (the canvas has no `S`); `Z`, `Q`, `W`, `E`,
`X`, `N`, `M`, `I`, `O`, `J`, `K`, `L`, `,`, `.`, `=`, `−`, `[`, `]` are unbound on the canvas; `Alt+F`, `Alt+G`, `Alt+L`,
`Alt+M`, `Alt+X`, `Shift+F`, `Shift+K`, `Shift+T`, `Shift+Z` are unbound; `Alt+Shift+L` is unbound (Lock is `Mod+Shift+L`).
`Mod+→/←` for the gap selection is Timeline scope only. `Alt+←/→` (keys) shadow nothing. The text editor keeps every key while
editing (`S` types an `s`). Presentation keys are §11.3.

| Group | Keys |
|---|---|
| Transport | `Space` · `J` `K` `L` · `←` `→` · `Shift+←/→` (1 s) · `↑` `↓` · `Home` `End` · `Alt+G` go to time · `Alt+L` loop · `Shift+S` audio scrub |
| Range and markers | `I` `O` · `Shift+I/O` · `X` · `Alt+X` · `M` · `Shift+M` · `Alt+M` / `Alt+Shift+M` |
| View | `3` lens · `Shift+T` tray · `=` `−` · `Shift+Z` · `Alt+Shift+Z` · `N` snap · `Shift+F` full-screen preview |
| Edit | `S` split · `Q` `W` trim to playhead · `E` extend · `,` `.` nudge (`Shift` 1 s, `Alt` roll / slip) · `[` `]` select edge · `Shift+Delete` ripple delete · `Alt+Shift+L` unlink · `Alt+F` freeze · `Z` zoom here · `Mod+→/←` gap |
| Keys | `Shift+K` add key · `Alt+←/→` previous / next key · `Delete` on a key |
| Presentation | `▶ Present`: `Mod+Alt+P` (`Mod+P` is the browser's print) · in the show: `→` `Space` `PageDown` next · `←` `PageUp` previous · `Home` `End` · number + `Enter` · `B` black · `W` white · `Esc` |

### 3.5 Drag and drop into time

| Dropped | Where | Result |
|---|---|---|
| A video or audio file (from the OS, Assets, Home) | On a track at a time | Imported (HOME-FILES §3.1), placed at the drop time on that track (`insert` with `Shift`, else overwrite into empty space; never over another clip without the hatched preview); a video with audio lands linked; proxies and waveforms build in the background with the clip's filmstrip filling in (§14) |
| A video or audio file | On the **story track** or an empty tray | A **new page** of the video's size and duration holding the clip, after the current page (scenario C's "drop the background clip"); the Timeline lens appears |
| An image | On a track | An image clip of 5 s (the page default) at the drop time |
| An image | On the preview | A plain image element on that page (the Canvas behaviour) spanning the page's duration |
| A motion preset (Assets › Motion) | On a clip or element | Applied as its kind (in / emphasis / out / loop / transition); a transition dropped on a gap or a clip edge binds there |
| A page thumbnail (Pages panel) | On the story track | Reorders (the same as dragging the clip) |
| An `.srt` / `.vtt` file | Anywhere on the timeline | A caption track from the file (§9) |
| A Lottie `.json` | On a track or the preview | M5+: a `lottie` asset clip (Appendix A); until then the import question toast says what it is and offers nothing |

### 3.6 Control tables (normative): clip, range, gap, key

`HUD n` = pill slot; `S / M / P` = inspector tier (Standard at rest / behind `More ▾` or a row's second line / Pro only); letter
and milestone per §0.1. Every control maps to one capability (`instaflow/clip-*`, `instaflow/transition-*`, `instaflow/key-*`,
`instaflow/motion-*`), so the pill, the inspector, the context menu, the palette and agents run the same thing.

| Selection · control | HUD | Inspector | Key | Letter |
|---|---|---|---|---|
| **Page clip** · Duration | 1 | Page · S `Duration` (seconds, min 1 frame; `Fit content` link when a clip inside is longer) | edge trim | (c) M3 |
| Page clip · Transition after ▾ | 2 | Transition section when the gap is selected | `Mod+→` then pill | (c) M4 |
| Page clip · Advance ▾ (Auto · On click) | 3 | Page · S | — | (c) M4 |
| Page clip · Notes | — | Page · M (presenter notes textarea) | — | (c) M4 |
| Page clip · Duplicate · Delete | 4 · 5 | — | `Mod+D` · `Delete` | (a) pages exist; (c) time |
| **Video clip** · Speed ▾ | 1 | Clip · S `Speed` field + `Pitch ▾`, `Reverse` toggle | — | (c) M3 |
| Video clip · Volume | 2 | Audio · S gain slider (−∞…+12 dB) | — | (c) M3 |
| Video clip · Split | 3 | — | `S` | (c) M3 |
| Video clip · Animate ▾ | 4 | Motion · S | — | (c) M4 |
| Video clip · Duplicate · Delete | 5 · 6 | — | | (c) M3 |
| Video clip · In / Out / Source / Replace… | — | Clip · S `In` `Out` (timecode fields), `Source` name with `Replace…`; Clip · M `Loop`, `Freeze at`, `Crop` (the image crop block, APPEARANCE §2.4) | slip | (c) M3 |
| Video clip · Fit ▾ · Fill · Crop | — | Image section (an image clip is an image element) | | (c) M3 |
| Video clip · Unlink / Detach audio · Freeze frame · Reverse · Zoom here · Export range… | More | — | §3.3 | (c) M3 / M4 |
| Video clip · Cutout (matte) | More `✦ Cut out person` → `Cutout` section | Cutout · S `Shape ▾`, `Feather`, `Outline`, `Shadow`, position presets | | (c) M5 |
| **Audio clip** · Volume · Fade in · Fade out · Mute | 1 · 2 · 3 · 4 | Audio · S gain, fades (seconds), `Mute`; Audio · M `Pan`, `Pitch ▾`, `Normalise to −14 LUFS`, `Duck under voice` (M5) | fade handles | (c) M3 (M5 ducking) |
| Audio clip · Split · Delete | 5 · 6 | | `S` | (c) M3 |
| **Range** · Split at edges · Speed ▾ · Zoom here · Export range… · Delete | 1–5 | — | `S` on both edges; `Z` | (c) M3 (Zoom here M4) |
| **Gap** · Transition ▾ · Duration · Smart move · Apply to all gaps · Remove | 1–5 | Transition · S `Preset ▾`, `Duration`, `Align ▾ (Centre · Start · End)`; preset params on the second line; `Matches` list for Smart move (§6) | | (c) M4 |
| **Key** · value · Curve ▾ · Hold · Duplicate · Delete | 1–5 | Keys · P lane row: time, value, curve glyph | `Shift+K`, `Delete` | (c) M3 |
| **Track header** · eye / mute · solo · lock · fader · rename · delete | header | — | `Mod+Shift+L` lock | (c) M3 |
| **Element clip (any element)** · the element's own pill + `Animate ▾` in slot 4 | 4 | Motion · S (`In ▾ Emphasis ▾ Out ▾ Loop ▾` rows with a summary each); Timing · S `Start` `Duration` (`Whole page` link); Keys · P | | (c) M4 |

## 4. The presets library: animate effects

### 4.1 What a preset is

A **motion preset** is an asset (`motion-preset`, IF-9.2) with a slug (`fade-up`), a **kind** (`in` · `emphasis` · `out` ·
`loop` · `text` · `transition`), a set of **channels** it drives (opacity, position, scale, rotation, blur, mask, clip-path,
colour…) expressed as relative keyframes over a normalised duration, and **parameters** with defaults (duration, delay,
direction, distance, curve, and for text: unit, stagger, order). Applying one writes a `PresetUse { preset, params }` into the
element's `motion.in` (etc.); the evaluator expands it at render time. **Bake to keyframes** replaces the use with real keys
(a capability, one undo step `Bake Fade up`). A person never sees the expansion unless they bake.

Why presets and not only keyframes: scenario B's "select the title → Animate → Fade up" must be one click; Canva and Keynote
prove people stop at presets and stay there. Why assets and not a hard-coded list: brand kits ship their own motion (a
"house" in/out), templates carry them, and agents address them by slug (`motion-in="fade-up 0.6s"`, DOCUMENT-FORMAT §5).

### 4.2 The preset sheet (what `Animate ▾` opens)

Anchored to the pill's `Animate ▾` item (or the inspector's Motion rows), a 360 × 440 px **popover** (layer 1, light dismiss,
OVERLAYS §1) — not a dialog, so the canvas stays live behind it:

```
┌ Animate · Headline ─────────────────────────────── ✕ ┐
│ [ In ] [ Emphasis ] [ Out ] [ Loop ]        (tabs)    │
│ ┌ filter chips ┐ Simple · Text · Bold · Brand · Saved │
│ ┌────┐ ┌────┐ ┌────┐ ┌────┐                            │
│ │None│ │Fade│ │Fade│ │Rise│    tiles 72 × 56,          │
│ │    │ │    │ │ up │ │    │    looping line-drawing;   │
│ └────┘ └────┘ └────┘ └────┘    hover = preview on the  │
│ ┌────┐ ┌────┐ ┌────┐ ┌────┐    real element, in place  │
│ │Pop │ │Wipe│ │Mask│ │Blur│                            │
│ └────┘ └────┘ └────┘ └────┘                            │
│ ─────────────────────────────────────────────────────  │
│ Duration  ●────○──  0.6 s     Delay  0.0 s            │
│ Direction  ↑ ↓ ← →      Distance  40 px               │
│ Curve  Ease out ▾    [ More ▾ ]    (Pro: everything)  │
│ Text  Letter · Word · Line   Stagger 0.04 s  Order ▾  │
│ ─────────────────────────────────────────────────────  │
│ ▶ Preview     Bake to keyframes     Remove            │
└──────────────────────────────────────────────────────┘
```

| Part | Behaviour |
|---|---|
| Header | `Animate · <element name>`; with several elements selected `Animate · 3 elements`; on a page `Animate · Page 2` (page-level presets: `Animate all` with a stagger between children in Layers order, and the page's own camera moves `Ken Burns`, `Zoom in`, `Pan`) |
| Tabs | `In · Emphasis · Out · Loop`. Each tab shows a dot when the element has a preset of that kind. A text element's `In`/`Out` tiles include the text units (§4.4); other kinds hide them. Transitions are **not** here (they belong to the gap, §7), except the sheet's footer link `Transition to the next page…` when the selection is a page |
| Filter chips | `Simple` (the eight everyone needs), `Text`, `Bold` (big moves), `Brand` (presets from the brand kit, only with a kit), `Saved` (the person's). The search field appears on typing (`/`) |
| Tiles | 72 × 56 px, name under a looping 1.2 s line-drawing of the motion (a grey rounded rectangle doing the move), `None` first. **Hover (or focus for 400 ms) previews the preset on the real element in place**, once, then the element returns to its state (a 60 % tangerine ring marks the live element during the preview). Click applies (one undo step `Animate · Fade up`) and keeps the sheet open for tuning; Enter on a focused tile applies; double-click applies and closes |
| Parameters | `Duration` slider 0.1–3 s (snapped to frames, mono value, scrubbable), `Delay` 0–5 s, `Direction` (four arrows, only for directional presets), `Distance` (px or `%` of the element), `Curve ▾` (the curve picker, §5.4), `More ▾` (preset-specific: `Blur amount`, `Rotation`, `Scale from`, `Overshoot`, `Mask shape`). Changes preview live while the sheet is open (the playhead loops the preset's span) |
| Text row | Only for text: `Letter · Word · Line` switcher, `Stagger` (seconds between units; `Total` toggle shows the whole duration instead), `Order ▾` (`Forward · Backward · Centre out · Random` — random is seeded per element so it exports identically, IF-9.4) |
| Footer | `▶ Preview` plays in / emphasis / out in sequence for this element; `Bake to keyframes` (Pro visible; Standard behind `More ▾`); `Remove` clears this tab's preset |
| Several elements | Tiles apply to all; `Stagger between elements` appears (0–1 s, order = Layers order or `Left to right · Top to bottom · Random`) |
| Density | Focus: tabs + tiles, parameters behind `Tune ▸`; Standard: as drawn; Pro: `More ▾` open, the curve picker inline, mono values with units |

Departures: previews on the real element (Canva previews a thumbnail; Keynote previews the slide after a delay); presets as
assets with slugs; one sheet for every kind with the text units inside (CapCut separates "text animation" into its own panel).

### 4.3 The catalogue (ships with M4; every row an asset with a slug)

| Kind | Presets (slug) | Channels | Parameters beyond the shared ones |
|---|---|---|---|
| **In** | Fade (`fade`), Fade up / down / left / right (`fade-up`…), Rise (`rise`, 40 px + fade), Drop (`drop`, from above with a small overshoot), Pop (`pop`, scale 0.6 → 1 with overshoot), Scale in (`scale-in`, 0 → 1), Wipe (`wipe-<dir>`, clip-path), Mask reveal (`mask-reveal`, a rounded-rect mask grows), Blur in (`blur-in`), Spin in (`spin-in`), Flip in (`flip-in`, skewX + scale as a 2D stand-in), Bounce in (`bounce-in`, spring), Slide in (`slide-in-<dir>`, from off-page), Typewriter (`typewriter`, text), Letter cascade (`letter-cascade`), Word by word (`word-by-word`), Line reveal (`line-reveal`), Roll up (`roll-up`, per line), Ken Burns (`ken-burns`, images and pages: slow scale + pan), Zoom in (`zoom-in`, pages) | opacity, x/y, scale, rotation, skewX, blur, clip-path, mask | Overshoot %, Scale from, Blur px, Mask shape (`Rounded · Circle · Bar`), Ken Burns `Start / End` rectangles drawn on the canvas |
| **Emphasis** | Pulse (`pulse`), Breathe (`breathe`), Shake (`shake`), Wiggle (`wiggle`, ±3°), Bounce (`bounce`), Flash (`flash`, opacity), Spin (`spin`, 360°), Tilt (`tilt`), Jump (`jump`), Highlight (`highlight`, a colour wash on text), Pop (`pop-emphasis`), Underline sweep (`underline-sweep`, text) | scale, rotation, x/y, opacity, fill colour, decoration | Intensity, Repeats (1–5), Wash colour (the colour popover) |
| **Out** | Mirrors of every In preset (`fade-out`, `fade-down-out`… generated by reversing the In asset; `Sink`, `Shrink`, `Wipe out`, `Mask hide`, `Blur out`, `Slide out`, `Typewriter erase`, `Letter scatter` (text, random seeded)) | as In | as In |
| **Loop** | Float (`float`, ±6 px sine), Spin (`spin-loop`), Pulse (`pulse-loop`), Breathe, Marquee (`marquee`, text or any element scrolls across and wraps), Shimmer (`shimmer`, a highlight sweeps), Blink (`blink`), Wiggle loop | x/y, rotation, scale, opacity, mask | Speed (cycles per second), Amplitude |
| **Page** (the page's camera; in the page's sheet) | Ken Burns, Zoom in, Zoom out, Pan left / right / up / down, Parallax (`parallax`: background fills move slower than elements) | page scale / anchor, per-layer offsets | Amount, Start / End rectangles |

Presets that need an engine feature not in M4 are listed in Appendix A as **defer** (3D flip, particle, path-follow); nothing
in the catalogue needs more than the channels IF-9.1 keyframes already cover plus a clip-path / mask channel (V-10).

### 4.4 Text animation (IF-9.4)

Text presets are evaluated after layout as a pure function of `(t, glyph, word, line, seed)`, so the text stays editable while
animated, re-flows keep the animation, and export matches preview exactly. The unit switcher (`Letter · Word · Line`) and
`Stagger` apply to any In / Out preset on a text element: `Fade up` by word is `fade-up` with `text.unit = word`; there is no
separate "text animation" list, only the five text-only presets (Typewriter, Letter cascade, Word by word, Line reveal, Roll
up) and the karaoke highlight (§9). Mixed-style runs animate as units of their text, not of their style. A text element whose
content changes keeps its preset (the stagger re-distributes). Preview during editing: while the caret is in the text, the
animation is **paused at its end state** so the person can read what they type; the pill's `Animate ▾` chip reads `In · Fade
up · word`.

### 4.5 Timing of presets on a page (where in / emphasis / out sit)

Without a timeline open: In starts at the page start plus `Delay`; Out ends at the page end (or at the element clip's end);
Emphasis plays at the page's midpoint, or **on click** in presentation when the page's `Advance` is `On click` (the build order
is the Layers order, editable in the Pages panel's `Builds ▸` list, §11). Loop runs between In and Out. With the tray or lens
open, the element's clip shows the In span as a leading tangerine cap, the Out span as a trailing one, and the Emphasis as a
`◆` the person can drag in time; dragging the cap edges changes `Duration` (the field follows). This is the whole timing
model for people who never open a keyframe lane.

### 4.6 Saving, sharing, brand presets

| Action | Where | Flow |
|---|---|---|
| Save as preset | sheet `⋯ › Save as preset…`; Motion section `⋯` | Name it → an asset in Assets › Motion (`Saved` chip in the sheet); it carries the parameters as new defaults; appears in every design on this device |
| Preset from keyframes | Keys section `⋯ › Save keys as preset…` (Pro) | Normalises the selected channels' keys to a 0–1 duration; names it |
| Brand presets | Brand kit (B-4) `Motion` section | A kit may hold `in`, `out`, `emphasis`, `transition` defaults; the sheet's `Brand` chip lists them first; `Animate ▾` on a brand-bound element shows the kit's default as the first tile |
| Copy / paste motion | `Mod+Alt+C` / `Mod+Alt+V` include motion (APPEARANCE §2.9's copy style carries `motion`); ctx `Paste style ▸ Motion only` | |
| Apply to all | sheet header `Apply to all <kind>` (`all text`, `all images`) on a page | A bulk capability; the preview badges every target |

## 5. Keyframes and easing

### 5.1 The model, as a person sees it

Any numeric, vector, colour, rect, opacity, volume or effect parameter can hold keys (IF-9.1). A property with keys shows a
filled `◆` beside its field in the inspector when the playhead is on a key, a hollow `◇` when it has keys elsewhere, and a
small `◇` outline button when it has none. Times are relative to the clip's start, so moving a clip moves its animation. A
key has a time, a value, an interpolation (`hold · linear · bezier · spring`) and a curve. **Departure from After Effects:**
no stopwatch, no "set keyframe" mode. The first key is explicit; later ones are automatic *and announced* (§5.3).

### 5.2 Where keys show

| Place | Standard | Pro |
|---|---|---|
| Inspector field | `◇` button at the field's right edge (click = key at the playhead; `Shift+K` with the field focused); filled when on a key; a tiny tangerine dot on the section header when any field inside is keyed | same, plus the key's curve glyph beside `◇` and `◆ 3` count on hover |
| Clip (tray / lens) | One **keys strip** under the clip: every key of every channel as `◆` (overlapping ones draw once); preset spans as caps (§4.5); drag a `◆` to move it in time; `Shift`+drag moves every key after it | The clip header's chevron opens **lanes**, one per channel (`Opacity`, `X`, `Y`, `Scale`, `Rotation`, `Fill`…), each with its keys; `Graph` toggle on the clip header shows the **value graph** (curves) in place of the lanes; lane height drag |
| Canvas | A **motion path** for position channels when the element is selected: a tangerine curve through the key positions with a dot per key; drag a dot to move the key's value; `Alt`+drag a dot pulls bezier handles on the path | Same, plus handles always shown and the path's tangent values in the Keys section |
| Inspector `Keys` section | ▸ with a summary `4 channels · 11 keys` | Open: a row per channel with its keys as a mini strip, `Curve ▾` for the selected key, `Clear channel`, `Bake` |

### 5.3 Adding, editing, moving, removing keys

| Action | Pointer | Keyboard | Result |
|---|---|---|---|
| First key on a property | Click the field's `◇` | `Shift+K` with the field focused | A key at the playhead with the current value; the hint under the field reads `Animated · key at 1.2 s`; the clip grows a keys strip |
| Next keys | Move the playhead, change the field (or drag the element on the canvas) | arrows / type, Enter | A new key at the playhead **with a 1.5 s hint** `Key added at 2.0 s` (so a change at a new time is never silent); changing a value *on* a key edits that key; changing a value with the playhead between keys of that property adds a key (AE's rule, made visible) |
| Change a value without a key | `Alt`+edit the field | `Alt+Enter` to commit | Offsets the whole channel (every key shifts by the delta): the way to "move the whole animation 10 px" |
| Move a key in time | Drag the `◆` (snaps to frames, other keys, edit points) | select the key, `,` / `.` (`Shift` = 1 s) | Label `1.2 s → 1.4 s` |
| Scale keys | Select several, `Alt`+drag the last one | — | Stretches the span proportionally (a 2-line label `×1.3`) |
| Move the whole animation | `Shift`+drag any key | — | Every key after it follows |
| Copy / paste keys | `Mod+C` / `Mod+V` with keys selected | | Pasted at the playhead on the same channels of the target element (a toast names channels that do not exist on the target) |
| Delete | pill `Delete`; `×` on the lane row | `Delete` | One step `Delete key`; deleting the last key leaves the value as the base value |
| Hold | pill `Hold` toggle | pill only (`H` is the Hand tool) | The value jumps at the key (`hold` interp); the `◆` becomes a `◆|` |
| Reverse keys | pill `⋯ › Reverse` | | Mirrors the selected keys in time |
| Clear channel / all | Keys row `Clear`; Motion `⋯ › Remove all animation` | | Toast with Undo when > 5 keys go |
| Curve | pill `Curve ▾`; the lane's segment right-click; the Keys row | `Alt+Enter` on a key opens the picker | §5.4; applies to the segment **after** the selected key (a curve belongs to the span between two keys, drawn on the lane as a small curve glyph on that span) |
| Bake preset to keys | sheet / Motion `Bake to keyframes` | | The preset's expansion becomes keys on the element; the preset use is removed |

Editing on the canvas with a keyed property and the playhead between keys adds a key (the hint says so); dragging a position
with the playhead on a key moves that key's value; the motion path updates live. Undo granularity: one step per gesture
(`Move key`, `Key Opacity`), coalesced for a scrub of a field.

### 5.4 The curve picker (easing)

A 280 × 320 px popover from any `Curve ▾`:

| Part | Behaviour |
|---|---|
| Named curves (3 × 4 grid) | `Linear`, `Ease` (the default: `cubic-bezier(.2,.8,.2,1)`, the chrome motion curve), `Ease in`, `Ease out`, `Ease in-out`, `Snappy` (`.4,0,.1,1`), `Gentle` (`.3,.1,.3,1`), `Anticipate` (`.6,-.3,.3,1`), `Overshoot` (`.3,1.4,.4,1`), `Bounce` (sampled), `Spring` (sampled; the default spring), `Hold`. Each tile draws the curve and, on hover, a **ball drop** preview (a dot travels 100 px with that curve, 1 s), and previews on the real segment |
| `Custom ▸` | Opens below: a **bezier editor** (a 200 × 200 graph with two handles, the four numbers as mono fields, `Paste CSS` accepts `cubic-bezier(...)` and `linear(...)` strings) or, with `Spring` chosen, three sliders `Stiffness · Damping · Mass` with a live preview and a `Duration (settles in)` read-out, since springs have no fixed duration (the segment stretches to the settle time; the next key can cut it) |
| Apply to | `This segment` (default) · `All segments of this channel` · `Every key of this element` |
| Pro | The picker is inline in the Keys section; the value graph lets a person drag the handles directly on the lane |

Springs are pre-sampled deterministically at the composition's fps when written (IF-9.1), so preview, export and agents agree.
A curve on a `hold` key is ignored and the tile is dimmed with the reason in its tooltip.

### 5.5 What animates, and what does not

Every spatial value (x y w h rotation scale anchor skewX flips as a step), opacity, blend (step), every fill / stroke /
effect parameter (colour in linear light, stop positions, angle, blur, offsets), corner radii, image crop, text size / letter
spacing / line height / colour / fill (text content is not keyable: it is a `hold` change by splitting the clip or by a
second text element), clip-path / mask (V-10), volume / pan, the page camera (scale, anchor), transition parameters. Structure
(parent, order, boolean operation, mask mode, repeat parameters) is not keyable in M3–M4; Appendix A lists the asks.

## 6. Auto Animate: Smart move

### 6.1 The idea in one line

Duplicate a page, move or restyle things, select the gap between the two pages, pick **Smart move**: every element that
exists on both pages tweens from its first state to its second; everything else fades out or in. It is Keynote's Magic Move
and Figma's Smart Animate, built on the match key the engine already keeps (`lineage.key`, IF-26.18), expressed as a
**transition preset** (IF-9.3), so it lives on the gap like every other transition.

### 6.2 Matching

| Rule | Behaviour |
|---|---|
| Key | Two elements match when their `lineage.key` is equal. Duplicate page, `Mod+D`, copy/paste within a design, repeat instances (`key~k`) and expanded repeats all keep keys, so the ordinary way of making "the next state" (duplicate the page) always matches |
| Suggested matches | Elements without a key match (a new element on page B that looks like one on page A: same kind, same text or same image asset, nearest size) are **suggested** with a dashed link and listed under `Suggested` in the `Matches` list; a person confirms one by clicking `Link` (it writes a shared key) or ignores it (it fades) — **departure**: Figma matches by layer name silently and breaks on rename; Keynote matches copied objects silently; we show the pairs |
| Many to one | A key present once on A and twice on B (a repeat grew): the first instance tweens, the others fade in; the list says `+2 new instances` |
| Text | Same key, different text: the box tweens and the text crossfades by default; `Morph text ▾ Crossfade · By word · By letter` on the pair (by-word morphs matching words and fades the rest; by-letter is for short labels and numbers) |
| Colour, radius, effects | Tween (colour in linear light); a fill kind change (solid → gradient) crossfades |
| Groups and frames | Match as a whole when keyed; children match on their own keys inside |
| Unmatched | Out on A: fades out over the first 40 % of the transition; in on B: fades in over the last 40 % (`Unmatched ▾ Fade · Scale · None` on the transition) |
| Pages of different sizes | The camera tweens too (Resize design B-5 later); until then the smaller page is centred |

### 6.3 UI

| Place | What shows |
|---|---|
| Gap pill | chip `Smart move · 0.6 s` · `Duration` · `Curve ▾` · `Matches` (opens the list) · `Apply to all gaps` · `Remove`. Before applying: `Smart move` is slot 3 of every gap pill and a tile in the transition sheet (§7) |
| `Matches` list (a popover from the pill; the Transition section in the inspector) | Rows `Headline ⇄ Headline`, `Hero image ⇄ Hero image`, `Badge → (fades out)`, `Price (fades in)`, `Suggested: Card 3 ≈ Card 4 · Link`; hovering a row highlights both elements on the canvas (A at 50 %, B at 100 %, arrows between); `Unlink` on a row; `Link…` on an unmatched row enters a pick mode on the other page |
| Canvas, while the gap is selected | Both pages drawn: A ghosted under B (or side by side in the Pages lens), with tangerine arrows from each matched element's centre on A to its place on B (Keynote shows nothing; this is the departure that makes the feature legible) |
| Preview | Hover the Smart move tile or press `▶ Preview` on the pill: the transition plays in the preview; scrubbing the gap's overlap band on the ruler scrubs the tween |
| Pages lens | The gap `⟋` shows the preset's glyph; `Transition` badge on every gap after `Apply to all gaps` (scenario B step 4) |
| Chat (M2+) | `same transition between all pages` → the bulk capability; the preview badges every gap |

### 6.4 States (components) and interactions

Smart move between pages is M4. Smart move between **component states** (a card's default / hover) and prototype
interactions (Figma's click → navigate) are **deferred** (Appendix A): Instaflow's output is video and pages, not a clickable
prototype; the `advance: click` builds (§11) cover the deck case. When components land (A-12), a component's variants are
pages of its own composition and Smart move applies unchanged.

## 7. Transitions

### 7.1 Model

A transition is a node bound to two adjacent items (two pages on the story track, or two touching clips on one track) with a
preset, a duration, an alignment (centre on the join, start at the join, end at the join) and parameters (IF-9.3, DOCUMENT-FORMAT
`Transition`). Pages overlap by the duration (story time shrinks accordingly, DOCUMENT-FORMAT §3.1), so the ruler's hatched
band is honest about where the pages meet. A page shorter than the transition cannot take it (the tile is dimmed with the
reason `Page 3 is shorter than 0.6 s`).

### 7.2 The transition sheet

Opens from the gap pill's `Transition ▾` or the `+` dot on a gap (Pages filmstrip and story track) — the same popover body as
§4.2 with one tab row: `Transitions` and the filter chips `Simple · Motion · Wipes · Brand · Saved`.

| Tiles | `None`, `Dissolve`, `Dip to black`, `Dip to white`, `Dip to colour…` (the colour popover), `Push ←↑→↓`, `Slide ←↑→↓` (the next page slides over), `Wipe ←↑→↓`, `Zoom in`, `Zoom out`, `Blur`, `Luma wipe` (with `Pattern ▾` Radial · Linear · Diamond · Custom image…), **`Smart move`**, `Flip` (2D skew stand-in), `Spin`, `Cube` (deferred, Appendix A) |
|---|---|
| Parameters | `Duration` 0.1–3 s · `Align ▾ Centre · Start · End` · `Curve ▾` · preset params (`Direction`, `Softness` for wipes, `Colour`, `Zoom amount`) |
| Footer | `▶ Preview` · `Apply to all gaps` (one capability; toast `Transition applied to 4 gaps · Undo`) · `Remove` |
| Hover | Previews on the real pages in the preview region; the Pages lens shows both thumbnails animating in the filmstrip |

### 7.3 Clip transitions

Between two touching clips on an overlay, text or video track: the same sheet (video crossfade = `Dissolve`; audio-only
clips get `Crossfade` only, equal-power, IF-8.1). A clip transition needs **handles** (media beyond in/out on both sides);
without them the tile says `Not enough media · trim 0.3 s from each clip` with a `Trim for me` button that does the
trimming as one step (Premiere shows a "insufficient media" warning and repeats frames; we say it and fix it). Dragging a
clip away from its neighbour removes the transition with a 1.5 s toast and Undo.

### 7.4 Control table

| Selection · control | HUD | Inspector | Letter |
|---|---|---|---|
| Gap · Transition ▾ (sheet) | 1 | Transition · S `Preset ▾` | (c) M4 |
| Gap · Duration | 2 | S | (c) M4 |
| Gap · Smart move (one click) | 3 | — | (c) M4 |
| Gap · Apply to all gaps | 4 | S button | (c) M4 |
| Gap · Remove | 5 | — | (c) M4 |
| Transition · Align ▾, Curve ▾, params | More | S / M second line | (c) M4 |
| Smart move · Matches, Unmatched ▾, Morph text ▾ | More `Matches` | Transition · S `Matches` list; M `Unmatched ▾`, `Morph text ▾` | (c) M4 |
| Page · Advance ▾ (Auto · On click) | page pill 3 | Page · S | (c) M4 |

Reduced motion (§15): in the editor and in presentation, every transition previews as a 0.3 s dissolve and Smart move as a
dissolve; export is unaffected (IF-9.7); the gap's chip adds a small `⊘ motion` tag so the person knows why.

## 8. Audio

### 8.1 Where audio lives

Three kinds of audio clip: the **linked audio of a video clip** (drawn as a waveform strip under the filmstrip until unlinked),
**audio clips on a page's Audio track** (sound effects, a voice-over for that page) and **story audio** on the composition's
own audio track that spans pages (music, narration; DOCUMENT-FORMAT §3.1 `track` on the root). In the lens, story audio rows
sit at the bottom under a hairline labelled `Story audio` and are not scoped to the current page (they stay at 100 %).

### 8.2 Levels, fades, meters

| Control | Where | Behaviour |
|---|---|---|
| **Clip gain** | pill 1 `Volume` (a scrubbable dB number with a 16 px mini slider on hover); Audio · S slider −∞ … +12 dB, 0 at the detent; the **gain line** on the clip (drag it up or down) | Keyable (`◇`): dragging the line with keys adds a key at the pointer's time → rubber-band automation (Pro shows the line always; Standard shows it on hover and when keyed) |
| **Fades** | **Fade handles**: a small round handle at the top corners of every audio clip (and of a video clip's waveform strip); drag inward → a fade curve drawn on the waveform; Audio · S `Fade in` `Fade out` seconds; `Curve ▾` (Linear · Equal power (default) · S-curve · Fast in) | Dragging past a neighbouring clip turns the two fades into one **crossfade** (equal power, IF-8.1) drawn as an X over the overlap; a `Dissolve` on a video clip transition carries its audio crossfade automatically |
| **Track volume** | The header's 60 px fader (a `Slider` turned vertical when the row is tall, horizontal when short), mono dB on hover; double-click = 0 dB | Not keyable (clip gain is) |
| **Master** | The transport bar's meter has a `Master` fader in its `⋯` (Pro: inline); a limiter at −1 dBFS is always on (IF-8.6) and lights a small `LIM` tag when it works | |
| **Meters** | Transport bar: stereo peak meter, 60 fps, −60…0 dBFS scale, peak-hold line 2 s, red above −1; **per-track** meters in headers in Pro (6 px); per-clip peak lines are the waveform itself (peaks render at the clip's gain) | Meters are text for screen readers on demand: the meter's tooltip reads the current peak, and a `Read level` palette command announces it |
| **Mute / solo** | Header `◉` mute and `S` solo; clip pill 4 `Mute` | Solo mutes the other audio rows (never the document); muted clips draw hatched; mute and solo are **view state** for the session except the clip's `muted` field which is the document's (the pill edits the document, the header the mix) |
| **Pan** | Audio · M `Pan` −100 … +100 (a centred slider) | Keyable |
| **Pitch at speed** | Clip · S `Pitch ▾ Preserve · Follow` | Preserve is the default (0.25–4×, IF-8.1); Follow for the chipmunk/slow-mo effect |
| **Normalise** | Audio · M `Normalise ▾ −14 LUFS (streaming) · −16 (podcast) · −23 (broadcast) · Peak −1 dB` | A one-shot analysis job sets the clip gain; a hint shows the measured loudness |
| **Duck under voice** (M5) | Audio · M toggle on music clips; `Amount` −12 dB, `Attack / Release` behind `More ▾` | Analyses the voice tracks' speech (the transcript's word times when one exists, else an energy gate) and writes gain keys on the music clip, editable afterwards; the keys are tagged `auto` and re-generate when the voice clips move (`Freeze keys` detaches them) |
| **Waveform** | Multi-resolution peaks (IF-8.5), drawn in the track's kind colour at 60 %; stereo as two mirrored halves in Pro, mono mix in Standard; builds in the background with a shimmer until ready (§14) | |
| **Audio scrubbing** | Transport `⋯ › Audio scrub` · `Shift+S` | Off by default (most people find it noisy); when on, scrubbing plays 1-frame grains |
| **Detach / unlink / delete audio** | pill `⋯` on a video clip | Detach = unlink + mute the video's own audio; `Delete audio` removes the linked audio for good (one step) |
| **Record voice-over** (M5) | Transport `⋯ › Record voice-over…`; Assets `Import ▾ › Record…` | A 3-2-1 count-in, records onto a new Audio track clip from the playhead while the story plays muted; a level meter in the record pill; `Esc` stops and keeps; `Mod+Z` removes |
| **Music from the library** (M2 Assets) | Assets › Audio; drag to the story audio row | Trims to the story length with a 2 s fade out by default (toggle in Settings › General › Media) |
| **Beat markers** (defer) | Appendix A | |

### 8.3 Audio-only pages and audio-only export

A page may hold only audio (a podcast cover with a waveform visualiser is a page with a `Waveform` element bound to the clip —
deferred, Appendix A). Export `Audio only` (M4) writes the mix as AAC in an `.m4a` (§10).

### 8.4 Playback and sync

Preview is audio-master (IF-8.3): the AudioWorklet's sample clock drives `t`; video frames may drop to stay in sync, never the
other way around. A dropped-frame dot in the Pro transport time flashes when frames drop; DevTools › Perf keeps the counts.
Latency is corrected by `outputLatency` so a caption keyed to a word lands on the word. On a stall (decoder starvation) the
preview holds the last frame and audio keeps playing; a stall over 1 s pauses both with a 1.5 s mist toast `Paused · media
still loading` and resumes when ready.

### 8.5 Control table

| Selection · control | HUD | Inspector | Letter |
|---|---|---|---|
| Audio clip · Volume | 1 | Audio · S | (c) M3 |
| Audio clip · Fade in · Fade out | 2 · 3 | Audio · S | (c) M3 |
| Audio clip · Mute | 4 | Audio · S | (c) M3 |
| Audio clip · Split · Delete | 5 · 6 | — | (c) M3 |
| Audio clip · Pan · Fade curve ▾ · Pitch ▾ · Normalise ▾ | More | Audio · M | (c) M3 |
| Audio clip · Duck under voice | More | Audio · M | (c) M5 |
| Track · fader · mute · solo · lock · rename | header | — | (c) M3 |
| Master · fader · limiter tag · meter | transport | — | (c) M3 |
| Record voice-over | transport `⋯` | — | (c) M5 |

## 9. Captions and subtitles

### 9.1 Model

A **transcript asset** (IF-8.9) holds words with times and speakers for one media clip; a **caption track** (`trackKind: text`
with the `captions` role) holds caption clips, each a text element with a range of words, rendered through the text pipeline
with every TEXT-FONTS control available, placed by a **caption style preset** (position, box, font, size, colour, highlight).
Burn-in at export is the ordinary render; sidecar export writes `.srt` / `.vtt` from the same clips.

### 9.2 Getting captions

| Path | Where | Flow |
|---|---|---|
| **Generate captions** (M5) | pill on a video or audio clip `⋯ › Captions ▾ › Generate…`; range pill; Transcript tab empty state `Transcribe this video`; chat | A sheet: `Language ▾ Auto`, `Where ▾ On this device · <provider>` (on-device is the default when the model is installed; the provider when configured; neither → the sheet says `Set up an assistant or install the on-device model` with the Settings link, FOUNDATIONS §5.6 keeps the entry rendered because the sheet itself is the explanation), `Style ▾` (a caption style), `Max words per caption` (4 default for social, 10 for subtitles). Runs as a job (IF-10.7) with progress on the clip (`Transcribing · 40 %`); captions appear as they stream; one undo step when done |
| **Import** | Drop an `.srt` / `.vtt`; Assets `Import` | A caption track from the file; timings kept; style = the default caption style |
| **Type them** | `+ Add track ▾ › Captions`, then `Alt+C` adds a caption at the playhead; type; `Tab` ends it at the playhead and starts the next | A manual flow for short clips; `Enter` commits |
| **From the text on the page** | A text element's pill `⋯ › Make caption` | Moves the text into the caption track at the playhead for 3 s |

### 9.3 The Transcript tab (dock; appears with a transcript)

Paragraphs of words with speaker labels (`Speaker 1 ▾` rename), word confidence as a faint underline below 60 % (hover shows
the alternatives), the current word highlighted during playback, click a word = playhead there, drag across words = a **range**
selection (the range pill: `Zoom here`, `Delete` (ripple cut), `Split`, `Emphasis caption`, `✦ Sound effect` (M2+)). Typing in
the transcript **edits the words** (fixes a mis-hear); the matching caption updates and the word keeps its time. `Mod+F` finds
in the transcript (the Find bar gains `Kind ▾ Transcript`). A `Filler words` filter chip highlights `um`, `uh`, repeated words
and silences > 0.7 s with a `Remove all · Review` row (M5's silence and filler removal, IF-8.9 / PLAN M5): `Review` steps
through each cut with the range selected and `Keep · Cut` in the pill.

**Edit by transcript** (Descript's model, kept because it is the best way a non-editor cuts speech): selecting words and pressing
`Delete` ripple-cuts the clips under those words on every unlocked track; the transcript shows a `‖` cut mark; undo restores. The
timeline and the transcript are two views of one cut.

### 9.4 Caption styles (text presets with a layout)

| Style (slug) | Look | Where |
|---|---|---|
| `plain-subtitle` | Bottom, two lines max, white with a 2 px dark outline, 4 % safe margin | the default for `Subtitle` captions |
| `bold-pop` | Centre-low, one line, 3–4 words, Bricolage 800, uppercase, a solid rounded box, the **active word** scales 1.1× (scenario C's "big bold style") | social default |
| `karaoke` | Words fill with colour as they are spoken (IF-9.4 karaoke highlight: a text animation keyed to word times) | |
| `lower-third` | Bottom-left bar with a name line (speaker) and the caption | interviews |
| `word-by-word` | One word at a time, centred, Pop in | reels |
| `brand` | From the brand kit's caption style (B-4) | |

`Style ▾` on the caption pill applies to the track (all captions) by default, `This caption only` in the menu. Every value is a
text and appearance control (font, size, colour, box fill, outline = text stroke T-18, radius), edited in the inspector like any
text element and saved as a text preset. Position: a 3 × 3 grid picker in the Captions section plus drag on the preview
(snaps to the safe-area guide). Safe area: `View › Safe areas` overlays title-safe and action-safe at 90 % / 80 % plus the
platform's UI (Reels, TikTok, YouTube Shorts) as mist shapes; the caption position picker avoids them.

### 9.5 Editing captions on the timeline

Caption clips trim like any clip (their words re-flow); dragging a caption edge past a word boundary snaps to the word;
`Split caption` at the playhead splits the word list; `Merge with next`; double-click a word to edit text; `Max words` in the
Captions section re-chunks the whole track (one step). Overlapping captions on one track are not allowed (the later one
pushes). Sidecar timing uses the clip's start/end, burn-in uses the style's animation.

### 9.6 Control table

| Selection · control | HUD | Inspector | Letter |
|---|---|---|---|
| Caption · Style ▾ · Font ▾ · Size · Colour · Split caption · Delete | 1–6 | Captions · S style, position grid, `Max words`, `Apply to track`; Text · S (TEXT §4.2) | (c) M5 |
| Caption · Merge with next · Make subtitle (plain) · Export captions… (.srt/.vtt) | More | — | (c) M5 |
| Clip · Captions ▾ › Generate… · Import… | More | — | (c) M5 |
| Transcript tab · speakers · filler filter · Remove all · Review | dock | — | (c) M5 |
| View · Safe areas ▾ | View | — | (c) M3 (an overlay only) |

## 10. Video export

### 10.1 One dialog

Video is a **`Video` chip in the Export dialog's Format row** (OVERLAYS §2.3 Export), next to `PNG · JPG · PDF · SVG`, rendered
once the composition has any duration, motion or media; `.gif` and `Image sequence` are its containers, not separate chips.
The brief said "a tab": a tab would split "export this design" into two places; Canva's `Download ▾ MP4` beside its image
formats is the convention people know, and the dialog's memory, preset row, name line, progress row and background toast then
apply unchanged. Deep link: `/d/export?format=video`.

### 10.2 Rows when `Video` is chosen

| Row | Control and default | Letter |
|---|---|---|
| **Preset** (the shared preset row) | `Social · 1080 × 1920 · 30 fps`, `HD · 1920 × 1080 · 30 fps`, `4K · 60 fps`, `GIF · 480 px · 15 fps`, `Audio only`; a preset only fits when the page's ratio matches (OVERLAYS §2.3's rule), with `Other sizes…` → Page › Size | (c) M3 (MP4) · M4 (GIF, audio) |
| **Container** (main) | Chips `MP4` (H.264 + AAC, default) · `WebM` (VP9 / AV1 + Opus; rendered only when `isConfigSupported` says yes) · `GIF` · `Image sequence` (PNG, zip) · `Audio only` (`.m4a`). A chip whose codec the device cannot encode is **not rendered** (IF-8.10), and the Advanced step says why in a muted line `WebM: this device cannot encode VP9` | MP4 (c) M3; others (c) M4 |
| **Size** (main) | The size field pair (output pixels, page ratio locked), presets `1080 × 1920 · Story`, `1920 × 1080 · HD`, `3840 × 2160 · 4K`, `720 × 1280 · small`; a hint `Encoder limit on this device: 4096 × 4096` when relevant | (c) M3 |
| **Frame rate** (main) | Chips `24 · 25 · 30 · 60`, default = the composition's fps (30); changing it here does **not** change the document (keyframes are re-sampled on the new grid; the hint says `Document is 30 fps · export re-samples`) | (c) M3 |
| **Quality** (main) | Chips `Standard · High · Best`; Pro adds `Bitrate` (Mbps, mono) and `Codec ▾` (H.264 profile, AV1 when supported) | (c) M3 |
| **Range** | `Whole story` (default) · `In–out` (shown when a range exists, with its times) · `Pages ▾` (the page-range picker, same as stills) · `Selection` (a clip or range selected) | (c) M3 |
| **Audio** | Switch, default on; off removes the audio track (a GIF has none; the switch is not rendered) | (c) M3 |
| **Captions** | `Burned in` (default when a caption track exists) · `Sidecar file (.srt)` · `Both` · `None`; a hint `Captions use the Bold pop style` | (c) M5 |
| **Transparent** (Advanced) | Only for `WebM` (VP9 alpha) and `Image sequence`; the preview shows a checkerboard; with MP4 the row is not rendered | (c) M4 |
| **Loop** (Advanced, GIF) | Switch, default on; `Colours 256 · 128 · 64`, `Dither` | (c) M4 |
| **Chapters** (Advanced) | Switch: markers become MP4 chapters | (c) M4 |
| **Preview quality note** | A muted line `Preview used proxies · export renders the originals` when any proxy is in use | (c) M3 |
| **Estimate** | The preview card shows a **poster frame** (the frame at the playhead; drag the card's scrubber to pick another), the duration `0:30.0`, the estimated size `≈ 24 MB` (bitrate × duration) and the estimated time `≈ 1 min on this device` from a rolling per-device encode speed | (c) M3 |
| **Name line** | `teaser.mp4`; with a sidecar `teaser.mp4 + teaser.srt (zip)`; GIF `teaser.gif`; sequence `teaser.zip (900 frames)` | (b) names (a) zip |

### 10.3 Running the render

| Stage | What shows |
|---|---|
| Start | The primary reads `Export MP4`; pressing it turns the dialog's footer into the **progress row**: a determinate bar `Rendering frame 240 of 900 · 0:08.0 · ≈ 40 s left`, `Pause`, `Cancel`. Rendering happens in the export worker from a frozen snapshot (IF-29.5) with the same evaluator at the export fps (IF-8.3), originals not proxies, audio mixed offline (IF-8.6); the editor stays usable |
| Leaving the dialog | The row becomes the sticky toast `Exporting teaser.mp4 · 27 % · Pause · Cancel`; completion `Exported teaser.mp4 · Show in folder`; the Export button in the top bar shows a thin progress ring while a render runs |
| **Pause / resume** | `Pause` stops at the next GOP checkpoint (IF-8.10) and keeps the partial stream; `Resume` continues; **a reload resumes** the job from the checkpoint (IF-10.7): Studio opens with the toast `Export paused by reload · Resume · Discard`. Departure: no browser video tool survives a reload mid-render |
| Cancel | Within one frame; the partial file is deleted; no toast (OVERLAYS §3.4) |
| Long render | Over 2 minutes the toast adds `Keep this tab open`; the tab title gets a `▶ 27 %` prefix; when the tab is hidden the render continues (workers) but the toast says `Rendering in the background` and the estimate is recomputed on return |
| Output | Streams to the save-picker file or the store with backpressure (IF-8.10); `Show in folder` when the folder mirror is on; a `Play` action opens the file in a new tab |
| Several outputs | Several formats at once (a PNG poster and the MP4) run in sequence as OVERLAYS §2.3; the zip rule applies |

### 10.4 Releases (D10)

`Publish a release ▸ Video` (the Share tab, M2+) renders the same way and stores the MP4 as a release asset with its link; the
viewer HTML release (M4, `IF-13.2`) plays the story with the same evaluator in a page. Specified in OVERLAYS §2.3; nothing
here changes it.

## 11. Presentation mode

### 11.1 Entry and exit

| Entry | Where | Behaviour |
|---|---|---|
| `▶ Present` | Top bar, left of `Export`, rendered once the document has more than one page or any motion (STUDIO §2 gains the slot; in Focus it folds into `⋯`); `Mod+Alt+P`; palette `Present from start`, `Present from this page`; Pages row `⋯ › Present from here` | Full screen (the Fullscreen API) on the current display; the story starts at the current page (`Present from start` at page 1). URL `?present=<page>` is an **intent** key (NAV §2.2: consumed once; reload returns to Studio, not to the show) |
| Presenter window | `▶ ▾ › Present with presenter view` | Opens a second window (`/s/:asset/presenter`, a route reserved here and to be added to NAV §2.1) that shows **current page · next page · notes · timer · page counter**, with its own controls; the two windows share state through a `BroadcastChannel`; closing either ends the show. Prefers the second display for the show when `getScreenDetails` allows |
| Exit | `Esc`; the end-of-show card `End of story · Esc to leave · ← to go back` | Returns to Studio on the page where the show stopped, same selection as before |
| In a window | `▶ ▾ › Present in this window` | A chrome-free takeover (OVERLAYS §2.1 takeover) for people who present over a video call without full screen |

### 11.2 What plays

The show is **the Timeline paused at page starts**: each page's In builds play on arrival (or on click, per its `Advance` and
the `Builds ▸` order), loops run, the page holds, and the person advances; the transition to the next page plays as the gap
specifies (Smart move included); a page's video and audio clips play from the page's start. A page with `Advance: Auto` advances
after its duration (a `▶ auto` glyph on its Pages row). Story audio plays across pages. Reduced motion (OS or Settings) turns
every transition and build into a 0.3 s fade (IF-9.7); the person can override for the show in `▶ ▾ › Play motion anyway`.

**Builds** (`Advance: On click` pages): the Pages panel row gains a `Builds ▸` disclosure listing every element with an In /
Emphasis / Out preset in order (`1 Headline · In`, `2 Price · Emphasis`, `3 Badge · Out`); drag to reorder; `With previous` toggle
groups a build with the one before; a click in the show advances one group. Elements without a preset are visible from the
start. A page whose builds are all `With previous` behaves as `Auto` for its builds and waits for one click to advance.

### 11.3 Keys and gestures in the show

| Action | Keys | Pointer |
|---|---|---|
| Next build / page | `→` `Space` `PageDown` `Enter` `N` | click, wheel down, a presenter remote's forward |
| Previous | `←` `PageUp` `P` `Backspace` | wheel up |
| First / last | `Home` / `End` | |
| Go to page | type a number, `Enter` (a small mono chip shows the typed number) | the presenter view's page strip |
| Black / white screen | `B` / `W` (press again to return) | |
| Pause / resume motion and media | `K` or `.` (full stop) | |
| Pointer | The cursor hides after 2 s of stillness; a laser pointer is deferred (Appendix A) | |
| Mute | `M` | |
| Exit | `Esc` | the `✕` that appears on pointer movement top-right |

### 11.4 Presenter view

A 16:9 window at Standard density tokens, dark mist background (`#16151A`) because presenters sit in dim rooms: current page
(large), next page (small, labelled `Next`), notes (the page's `Notes`, 18 px Geist, scrollable, `+`/`−` text size), a timer
(elapsed; click to reset) and a clock, the page counter `3 / 8`, the build counter `build 2 of 3`, and a
transport (`◀ ▶`, `B`, `End show`). Notes are also the agent's input for `✦ Write speaker notes` (M2+, CHAT).

### 11.5 Control table

| Control | Where | Letter |
|---|---|---|
| Present · Present from start · from this page · with presenter view · in this window · Play motion anyway | top bar `▶ ▾`; palette; Pages row `⋯` | (c) M4 |
| Page · Advance ▾ · Duration · Notes · Builds ▸ (order, With previous) | Page section; Pages row disclosure | (c) M4 |
| Show keys (§11.3) | registry scope `presentation` | (c) M4 |
| Presenter window | `/s/:asset/presenter` | (c) M4 |
| Viewer HTML release | Share › Publish (D10) | (c) M4 |

## 12. Errors and edge states

Copy follows OVERLAYS §3.7 (what happened · what to do; no codes in the surface; `Copy diagnostics` carries them). One error,
one place: a clip's problem shows **on the clip** (a hatched clip with a one-line label and the fix as its pill) and in the
Assets row; a job's problem in its progress row or toast; a device problem as a banner.

| Situation | Code | What a person sees | Fix offered |
|---|---|---|---|
| Unsupported source codec (HEVC without hardware decode, ProRes, an exotic container) | `IF-MEDIA-001` | Import lists the asset with a warning tag; placing it draws a **placeholder clip** (mist, the file name, `Can't play this format here`) that keeps its duration so the cut can continue; audio still plays when only the video codec is unsupported | `Convert on this device` is not offered (no ffmpeg.wasm in V1, IF-8.11). Fix text: `Re-export it as H.264 MP4 from the camera app or a converter, then Replace…`; the pill has `Replace…` |
| Decode failure mid-file (corrupt GOP) | `IF-MEDIA-002` | The frames hold the last good frame with a thin red tick on the clip at that time; export skips to the next keyframe and the result line counts `2 frames repeated` | `Trim around it` link selects the bad range |
| Media missing on this device (pasted from another workspace, folder moved) | `IF-MEDIA-003` | Hatched clip `reaction.mp4 isn't on this device`; waveform and filmstrip absent; the cut and timing are intact | `Locate…` (file picker, matched by hash) · `Replace…`; Export refuses with a section error listing the clips |
| File too large for the store (> 4 GB or storage pressure) | `IF-LIB-002` | Import toast with the size and the storage state | `Move the workspace to a folder` (D8), `Free up space` |
| Proxy or waveform job failed | `IF-LIB-006` | The clip shows the original (slower scrubbing) with a small warning dot; Assets row `Proxy failed · Retry` | `Retry`; the cut is never blocked |
| Encoder unsupported (no H.264 encode on the device) | `IF-EXP-009` | The `Video` chip stays rendered; `MP4` is not rendered and `WebM` is the first container; a muted line explains `This device cannot encode H.264 · WebM is available` | — |
| Encoder failed mid-render | `IF-EXP-010` | The progress row turns into a section error `Couldn't finish rendering at 0:12.4 · the encoder stopped`; the partial output is kept if `Pause`-style checkpoints exist | `Resume`, `Try a lower quality`, `Export the first 0:12 instead` |
| Long render | — | §10.3: estimate first, progress with the frame count, `Pause`, background toast, tab title progress, reload resumes | — |
| Out of memory / GPU device lost during playback | — | Playback pauses; the last frame holds; a mist banner `Graphics restarting…` (STUDIO §9.2); on recovery playback does not auto-resume (a person presses play) | If it happens twice in a minute: a toast `Playback is heavy for this device · Preview quality: Draft` with `Use Draft` |
| Export too large for the device (pixel limit, > 4K on an iGPU) | `IF-EXP-001` | The Size chips over the limit are disabled with the reason (dialog rule) | `Use 1080p` |
| Transition too long for a page | — | The tile is dimmed with the reason; the Duration field clamps with a hint `Max 2.4 s · Page 3 is 2.4 s long` | `Lengthen Page 3` link |
| Not enough media for a clip transition | — | §7.3 `Not enough media · trim 0.3 s from each clip · Trim for me` | `Trim for me` |
| Keyframe off the frame grid (from an agent) | `IF-CS-011` | Refused by validation; the agent gets the fix (`snap t to the grid`); people never see it | — |
| Agent places a clip over another | `IF-CS-011` | Refused unless `mode: overwrite`; the proposal preview shows the hatched overwrite | — |
| Caption generation without a model | — | The sheet explains (§9.2) with the Settings link; nothing else assistant-shaped renders | `Open Settings › Assistant` · `Install on-device model` |
| Transcription failed or timed out | `IF-JOB-*` | The clip's progress chip becomes `Transcription failed · Retry`; partial words are kept | `Retry`, `Try the other engine` |
| Audio permission refused (voice-over) | — | Toast `Microphone isn't allowed · Allow in site settings` | `Allow in site settings` (OVERLAYS §3.3) |
| Fullscreen refused (presentation) | — | Falls back to `Present in this window` with a 1.5 s toast | — |
| Second display missing (presenter view) | — | Both windows open on the same display; the presenter window says `Drag this window to your screen` once | — |
| Dropped frames in preview | — | Nothing textual for people (STUDIO §9.2 rule); the Pro transport shows the dot; DevTools counts | `Quality ▾ Draft` in the transport `⋯` |
| Flashing content (> 3 flashes/s from a `Flash` or `Blink` preset) | — | A warning tag on the preset tile `May trigger seizures above 3 flashes/s` and a section warning in Export when a flashing span exists | `Slow it down` sets the rate to 2/s |
| Reload mid-render | — | §10.3 `Export paused by reload · Resume · Discard` | |
| Offline | — | Nothing (local-first); only `Where ▾ <provider>` transcription needs the network and says so inline | |

## 13. Fidelity: what you scrub equals what exports

| Rule | How |
|---|---|
| **One evaluator** | Preview, scrub, hover scrub, thumbnails, presentation, export and the agent's timeline view all call `evaluate(stage, t)` (IF-8.3). There is no second interpolation code path in the UI: the tray's keys strip, the motion path and the field values at `t` are read back from the same evaluation |
| **Frame grid** | Every stored time is on the composition's fps grid; the UI never shows or accepts an off-grid time (fields round and say `Snapped to 1.233 s · frame 37`); export at another fps re-samples from the stored keys, not from preview frames |
| **Springs and random** | Pre-sampled deterministically and seeded per element (IF-9.1, IF-9.4): the same file exports the same bytes twice |
| **Proxies** | Preview may use 720p proxies; export uses originals (IF-8.5). The difference is sharpness only; crop, position and timing are identical because both run through the same `Source` and `Spatial`. The Export dialog's note says when proxies were in use (§10.2) |
| **Text** | Text animation runs on the GPU after layout for preview and export alike (IF-9.4); glyphs are the same outlines as PNG/PDF (D21); captions burned in are the same text pipeline |
| **Audio** | The offline mixer is the same DSP as the live one (IF-8.6); the limiter and fades match within float rounding; loudness normalisation is applied to the document's gain, never only at export |
| **Transitions and effects** | WGSL passes with declared parameters (ARCHITECTURE §2); the preview runs the same passes at preview resolution |
| **Reduced motion** | Changes the editor preview and presentation only (IF-9.7); the Export dialog's poster and estimate ignore it; a muted line in the dialog says `Export includes full motion` when reduced motion is on, so nobody is surprised |
| **Milestones and thumbnails** | A page thumbnail is `evaluate` at the page's poster time (its start by default; `Set as thumbnail` on the playhead's time in the page pill `⋯`); a milestone preview plays the story read-only with the same evaluator |
| **Agents** | The timeline view (OTIO-shaped seconds, DOCUMENT-FORMAT §5) rounds to 2–3 decimals; compile snaps to the grid; a proposal's **timeline diff** (IF-12.5: added clips hatched, cut ranges red) is drawn on the same tracks a person edits |
| **Checked by** | A fidelity suite: for a corpus of motion scenes, the frame rendered by the preview at `t` and the frame encoded at `t` (decoded back) meet the D21 metric (SSIM ≥ 0.98 after the codec's own loss is calibrated on a static frame); audio exported vs mixed live within −60 dBFS difference; text animation glyph positions equal to the pixel |

## 14. Performance states

Rule from STUDIO §9.2: performance states are **spatial**, never textual, except countable jobs and stops.

| Situation | What shows | Never |
|---|---|---|
| Media just imported | The clip appears at once with a mist filmstrip and a shimmer; the filmstrip and waveform fill in from the left as the proxy and peaks build (IF-23.5 provisional id, IF-8.5); Assets shows a progress ring | A blocked drop, a toast |
| Scrubbing faster than decode | Coarse frames (nearest keyframe) then the exact frame on settle (IF-8.4); the preview never goes blank | A spinner, a black frame |
| Playback with frames dropping | Audio stays continuous; video drops; the Pro transport's dot flashes; after 2 s of a streak the transport `⋯` `Quality` shows `Auto → Draft` as a suggestion chip for 5 s | "Performance mode" dialogs |
| Decoder pool saturated (many clips) | Clips far from the playhead show their poster frame instead of live frames; nearest clips are exact | — |
| Long story (200 pages, 30 min) | Tracks virtualise; filmstrips render at the visible zoom only; the ruler coarsens; the keys strip aggregates (`◆ 24` clusters) | "Loading timeline…" |
| Export running | The editor stays interactive; the Export button ring; the toast; a second export queues (`1 export waiting`) | A frozen UI |
| Transcription / matte / proxy jobs | Progress chip on the clip (`Transcribing · 40 %`), a ring in Assets; resumable after reload (IF-10.7) | A modal |
| GPU lost during playback | Last frame holds, mist banner, playback paused (§12) | A blocking error (worker rules apply to the worker) |
| Low memory | Far tiles and far proxies are dropped silently; DevTools › Perf records | A banner |
| Hover scrub on a heavy page | The hover preview renders at Draft quality; releasing `Alt` renders the exact frame | — |
| Opening a design with video on a device with no WebGPU | D1: the unsupported-browser screen already covers it; a device with WebGPU but no hardware decode plays at reduced resolution with the `Quality` note | — |

Budgets (REQUIREMENTS §15 applies): playhead move → frame on screen ≤ 1 frame + 4 ms p95 for a page without video; scrub
to exact frame ≤ 120 ms p95 with proxies; preset hover preview starts within 100 ms; the preset sheet opens in 0 ms with tiles
drawn by the next frame.

## 15. Accessibility, including reduced motion

| Area | Rule |
|---|---|
| Reduced motion (OS `prefers-reduced-motion` or Settings › General) | Editor **chrome** follows FOUNDATIONS §5.10. **Content** preview: transitions and Smart move become 0.3 s dissolves; emphasis and loop presets are paused at rest and play once on `▶ Preview`; auto-play of hover previews is off (click the tile to preview); the Pages lens filmstrip does not animate thumbnails; presentation follows the same rule with `Play motion anyway` per show (IF-9.7). Export is unaffected and the dialog says so (§13). The clip's chip shows `⊘ motion` while reduced |
| Flashing | Presets that flash above 3 Hz carry the warning (§12); the preview respects it; the a11y audit flags exported spans > 3 flashes/s |
| Keyboard-only editing | Every gesture in §3 has a key path; the tray, track area, headers and transport are `F6` regions; clips are a listbox per track (roving tabindex), keys a listbox per lane; `Alt+Enter` focuses the pill; the ruler is a slider (`role=slider`, `aria-valuetext="12.4 seconds of 30"`, arrows = frames, `Shift` = 1 s, `PageUp/Down` = 10 s) |
| Screen reader | Announcements (polite): `Playing`, `Paused at 12.4 seconds`, `Clip Headline, 2.0 to 6.4 seconds, track Text`, `Key added at 1.2 seconds`, `Transition Smart move, 0.6 seconds, 12 matched`, `Export 27 percent`; the meter announces on request; captions' text is in the a11y tree as the caption clips' names; during playback announcements are suppressed except errors (the audio is the content) |
| Time fields | Accept `12.4`, `1:02.5`, `00:01:02:15`, `+2s`, `-10f`; `aria-describedby` says the format; mono |
| Captions as a11y output | Burned-in captions, sidecar `.srt`/`.vtt`, and the viewer HTML release carries `<track kind="captions">`; a video with speech and no captions shows a one-time hint in Export `Add captions so everyone can follow · Generate…` (never blocks) |
| Audio descriptions | Deferred (Appendix A); a `Notes` field per page is the hook |
| Colour | Track kinds use the lens colour with text labels and icons, never colour alone; the playhead is red with a flag shape; keys are diamonds, holds have a bar; muted clips are hatched not merely dimmed; contrast of clip labels over filmstrips is guaranteed by a label plate |
| Pointer size and precision | Trim zones are 8 px with a 16 px hit area; keys are 10 px diamonds with a 16 px hit; the gap hit zone widens to 16 px on hover; everything also works at 200 % browser zoom |
| Auto-play | Nothing plays on open; the story never auto-plays in Studio; presentation auto-advances only on `Advance: Auto` pages with a visible glyph |
| Presenter view | Dark background, 18 px notes with text size controls, timer readable from a metre away; keys announced by the presenter window's live region, not the show's |
| Agents | Every timeline capability has the same a11y name as its pill action; agent timeline edits announce as `Ava moved 3 clips` (UX.md §9) |

## 16. Plumbing (where each piece lives)

| Piece | Where | Milestone |
|---|---|---|
| `Temporal`, `Source`, `AudioMix`, `Track`, `Motion`, `Animation` channels, `Transition`, `Page.advance/notes/duration`, `Composition.format.fps` as components with validation (IF-CS-011) | `src/elements/components.ts` (motion components beside the element ones), DOCUMENT-FORMAT §3.2 | M3 (temporal, source, audio, animation), M4 (motion, transition, advance) |
| `@staticflux/motion`: ticks, channels, easing (bezier, steps, hold, sampled springs), interpolators (linear-light colour), `evaluate(stage, t)`, text unit function, seeded PRNG, lint against ambient time | new vertical package (PLAN Δ15) | M3 core, M4 presets and text units |
| `@staticflux/media`: `MediaClock` (audio · wall · offline · scrub), `DecoderPool`, `MediaIndex`, Mediabunny port, `ExportJob` with checkpoints, AudioWorklet host, mixer, offline render | new vertical package (Δ16) | M3 |
| Proxies, filmstrips, waveform peaks as renditions; media probe (duration, codec, fps, channels) | `src/library/renditions.ts`, `ingest.ts` | M3 |
| Motion presets as `motion-preset` assets with slugs; the catalogue shipped as workspace assets on first run; brand kit `motion` section | `src/library`, `brand-kit.ts`, a `presets/motion/` data folder | M4 |
| Timeline lens feature (arrangement = current page fitted, others dimmed), the tray, track area, ruler, transport, headers, clip rendering (filmstrip, waveform, keys strip, lanes, graph) as kit components (`<sf-timeline>`, `<sf-track>`, `<sf-clip>`, `<sf-ruler>`, `<sf-transport>`, `<sf-meter>`, `<sf-curve-picker>`, `<sf-preset-sheet>`) | StaticFlux kit (generic timeline widgets) + Instaflow `src/timeline/` (the lens feature, bindings) | M3 (M4 for the sheet and curve picker) |
| Edit capabilities: `clip-move`, `clip-trim`, `clip-ripple-trim`, `clip-roll`, `clip-slip`, `clip-slide`, `clip-split`, `clip-join`, `clip-speed`, `clip-freeze`, `clip-reverse`, `clip-unlink`, `range-delete`, `track-add/remove/reorder/lock/mute/solo`, `marker-*`, `key-set/move/delete/curve/bake`, `motion-apply/remove/save-preset`, `transition-set/remove/apply-all`, `smart-move-link/unlink`, `zoom-here`, `caption-*`, `present-*` | `src/timeline/capabilities.ts` with `plan()` for proposals (IF-10.2) | per milestone |
| Shortcut scopes `timeline`, `presentation`; conflict check | `src/tools/keyboard.ts`, registry | M3 / M4 |
| Control declarations for clip, range, gap, key, caption, track selection kinds with HUD ranks and tiers | `src/spec/controls.ts` | M3 / M4 / M5 |
| Export: `video` format family in `formats.ts` (containers as data), encoder probes, `ExportJob` checkpoints, resume slot, estimate from a per-device speed record | `src/export/` | M3 (MP4), M4 (others) |
| Presentation: fullscreen takeover, `/s/:asset/presenter` route, `BroadcastChannel` sync, builds model | `src/present/`, NAV §2.1 row | M4 |
| Transcript asset, caption track role, caption styles as text presets, `.srt`/`.vtt` import and export, on-device transcription worker, filler detection | `src/captions/`, `src/library` | M5 |
| Matte (cutout), ducking analysis, voice-over recording | `src/media/` | M5 |
| Agent views `timeline` and `transcript` codecs | `@staticflux/agentview` | M3 / M5 |
| Fidelity suite (§13) | `src/timeline/fidelity.gpu.test.ts`, export corpus | M3 |
| Reduced-motion content rule, flashing guard | `@staticflux/a11y` facts, evaluator option `reducedMotion` (preview only) | M4 |

## 17. Every feature: its outlet, its flow to completion and follow-up, and the (c) schedule

Standing rule (owner, 2026-10-25, `CAPABILITY-COVERAGE.md`): UX designs **every** feature now, deferred ones included — its
**outlet** (exactly where it lives, per density) and its **flow** (how the person finishes, and what comes next). A deferred
feature's outlet is **reserved** and not rendered until built (FOUNDATIONS §5.6). Vocabulary: `HUD n` = pill slot, `More` = the
pill's `⋯`, `Clip · S / M / P` = the inspector section at rest in Standard / behind `More ▾` / Pro only, `tray` = the strip under
Canvas and Pages, `lens` = the Timeline lens, `sheet` = the preset sheet, `transport`, `header`, `ctx` = context menu, `pal` =
palette, `View`, `Export` = the Export dialog. Every row's undo is one step named after the control unless it says otherwise.

### 17.1 Outlets and flows

| Feature (letter · milestone) | Outlet | Flow to completion | Follow-up and what comes next |
|---|---|---|---|
| **Timeline lens appears with content** (c · M3) | Lens switcher slot 3, key `3`; appears on first motion / media / transition / `Animate` | Drop a video on the story track → the lens slides in; `3` opens it | Leaves when the content is gone and the person is elsewhere (STUDIO §2.1) |
| **Tray under Canvas / Pages** (c · M3) | Bottom of the canvas region, `Shift+T`; opens itself on first duration / preset / transition | Scrub, see the layout move, trim a page | Drag its top edge past 200 px → the lens |
| **Page duration (pages as clips)** (c · M3) | Page pill 1 `Duration`; Page · S `Duration`; story clip edge; Pages row mono tag | Type `6`, Enter, or drag the clip edge; everything after ripples | `Fit content`; `Apply to all pages` in Page `More ▾`; the ruler's total updates |
| **Reorder pages in time** (a story · c time) | Drag a story clip; Pages panel drag; `Alt+↑/↓` | Drop between neighbours | Transitions stay with their gaps where both pages remain adjacent, else are removed with a toast |
| **Import video / audio** (a kinds · c probe, proxies) | Assets `Import`; drop on a track, the story track, the preview, Home | Drop → placed; proxy and waveform fill in | `Replace…`; `Locate…` when missing |
| **Place a clip on a track** (c · M3) | Drag from Assets; `Enter` on an asset places at the playhead on the first free track | Drop at a time (overwrite into empty; `Shift` insert) | Trim, move, split |
| **Add / remove / reorder / rename tracks** (c · M3) | `+ Add track ▾`; header `⋯ › Remove track`; header drag; inline rename | Pick the kind; `Remove` with clips asks inline `Remove track and 4 clips? · Remove` | Track order = z-order of overlays |
| **Lock / mute / solo / hide a track** (c · M3) | Header icons; `Mod+Shift+L` on a focused header | Click | Locked tracks ignore ripple |
| **Playhead, scrub, hover scrub** (c · M3) | Ruler, transport, `J K L Space ← →`, `Alt`+hover | Click the ruler, drag, step frames | The time field; `Alt+G` go to time |
| **Transport** (c · M3) | Transport bar (docked; floating pill in Focus) | `Space`; `J`/`L` rates | Loop `Alt+L`; quality `⋯` |
| **In / out range** (c · M3) | Ruler drag; `I` `O` `X`; right-click | Set in, set out → band | Range pill: Split at edges, Speed, Zoom here, Export range…, Delete |
| **Markers** (c · M3) | `M`; ruler right-click; `▼` click | `M` at the playhead; `Shift+M` with a name; colour chip | `Alt+M` jumps; Export `Chapters` (M4) |
| **Snapping** (c · M3) | Transport `◉ Snap`, `N`; `Mod` suspends | Toggle | Snap targets listed in the tooltip |
| **Zoom the timeline** (c · M3) | `=` `−`, slider, `Mod`+wheel, `Shift+Z` fit | | Wheel scrolls time; `Shift`+wheel tracks |
| **Move a clip** (c · M3) | Drag; `,` `.`; `Alt+↑/↓` to another track | Drop (hatched overwrite preview) | Undo `Move clip` |
| **Trim** (c · M3) | Edge drag; `[` `]` then `,` `.`; Clip · S `In` `Out` | Drag with the two-line label | Ripple with `Shift` (default on the story track) |
| **Ripple trim to playhead / extend** (c · M3) | `Q` `W` `E` | Press | Label in the Pro undo line |
| **Roll · slip · slide** (c · M3) | `Alt`+edge, `Alt`+body, `Alt+Shift`+body; `Alt+,/.` | Drag; slip shows first/last frames | — |
| **Split** (c · M3) | Tool `S`, pill `Split`, ctx | `S` at the playhead | `Join` on the pieces |
| **Delete · ripple delete · lift** (c · M3) | `Delete`, `Shift+Delete`, pill, ctx | Press; range deletes confirm inline when > 3 clips | Undo toast when > 5 clips |
| **Duplicate a clip / page** (a page · c time) | `Mod+D`; `Alt`+drag | | Match keys kept for Smart move |
| **Speed · reverse · pitch** (c · M3) | Pill 1 `Speed ▾`; Clip · S | Pick 2× → the clip halves (ripple with `Shift`) | `Pitch ▾`; speed ramps (M5+, A.2) |
| **Freeze frame** (c · M3) | Pill `⋯`, `Alt+F` | 2 s hold inserted | Trim the hold |
| **Link / unlink / detach audio** (c · M3) | Pill `⋯`, `Alt+Shift+L` | | Audio clip appears on the Audio row |
| **Filmstrip · waveform · proxies** (c · M3) | On the clip; Assets ring; transport `Quality ▾` | Automatic | `Retry` on failure |
| **Clip gain · fades · crossfade** (c · M3) | Pill 1–3; Audio · S; gain line; fade handles | Drag a fade handle; drag past a neighbour → crossfade | Keyable gain; `Curve ▾` |
| **Track fader · master · limiter · meters** (c · M3) | Header fader; transport meter + `⋯ › Master` | Drag; double-click = 0 dB | Pro per-track meters |
| **Pan · normalise** (c · M3) | Audio · M | Pick `−14 LUFS` | Hint shows the measured value |
| **Duck under voice** (c · M5) | Audio · M toggle on music clips | Toggle → auto gain keys | `Freeze keys`; edit keys |
| **Record voice-over** (c · M5) | Transport `⋯`; Assets `Import ▾ › Record…` | Count-in, record, `Esc` | Trim; `Normalise` |
| **Audio scrubbing** (c · M3) | Transport `⋯`, `Shift+S` | Toggle | — |
| **Keyframes: first key, next keys, move, scale, copy, delete, hold** (c · M3) | Field `◇`, `Shift+K`; keys strip; Pro lanes; motion path; Keys · P | §5.3 | `Bake`, `Clear channel`, `Save keys as preset…` |
| **Rubber-band automation (gain, any channel on the clip)** (c · M3) | The gain line; Pro lanes | Drag the line with keys | — |
| **Curve picker** (c · M3 bezier · M4 springs catalogue) | `Curve ▾` on a key / segment / preset; Pro inline | Pick `Overshoot`; `Custom ▸` handles or spring sliders | `Apply to ▾ all segments`; paste CSS |
| **Value graph (graph editor)** (c · M4, Pro) | Clip header `Graph` toggle | Drag handles on the lane | — |
| **Motion path on canvas** (c · M4) | Automatic for position channels when selected | Drag a dot; `Alt` pulls tangents | — |
| **Animate presets: in / emphasis / out / loop** (c · M4) | Pill 4 `Animate ▾`; Motion · S rows; sheet; Assets › Motion drag | Hover tiles → preview in place; click → applied; tune Duration / Direction / Curve | `Bake to keyframes`; `Save as preset`; `Apply to all <kind>`; copy style carries motion |
| **Text animation by letter · word · line** (c · M4) | Sheet text row; Motion · S summary `In · Fade up · word` | Pick `Word`, set stagger, `Order ▾` | Typewriter, cascade, roll up; karaoke (M5) |
| **Page-level presets (Ken Burns, zoom, pan, parallax, Animate all)** (c · M4) | Page pill `Animate ▾`; Page · S Motion | Pick `Ken Burns` → draw start / end rectangles | Stagger children |
| **Preset timing on the page (caps, emphasis diamond)** (c · M4) | Tray / lens clip caps | Drag a cap edge | Duration field follows |
| **Save / share / brand presets** (c · M4; brand B-4) | Sheet `⋯ › Save as preset…`; Assets › Motion; brand kit `Motion` | Name → an asset | `Saved` chip; template carries it |
| **Transitions between pages** (c · M4) | Gap `⟋` / `+` dot (filmstrip and story track); gap pill; Transition · S; sheet | Select the gap, pick `Push ←`, set 0.5 s | `Apply to all gaps`; reduced motion → fades |
| **Transitions between clips** (c · M4) | Same on touching clips | Pick `Dissolve`; `Trim for me` when media is short | Dragging apart removes with a toast |
| **Smart move (Auto Animate)** (c · M4) | Gap pill 3; sheet tile; `Matches` list; canvas arrows | Duplicate the page, move things, select the gap, `Smart move` | `Link…` / `Unlink`; `Morph text ▾`; `Unmatched ▾`; apply to all |
| **Match keys visible** (a keys · c UI) | `Matches` list; Pro Layers mono tag `key` on hover; Explain in DevTools | Read the pairs; link a suggestion | Rename never breaks a match |
| **Zoom here / punch-in** (c · M4) | Range pill; transcript range pill; `Z` + drag on the preview | Draw a rectangle → eased keys | Keys editable afterwards; `Reset zoom` |
| **Builds (on click) and build order** (c · M4) | Page · S `Advance ▾ On click`; Pages row `Builds ▸` | Reorder; `With previous` | Presentation advances per group |
| **Presentation mode** (c · M4) | Top bar `▶ Present ▾`; `Mod+Alt+P`; pal; Pages row `⋯` | Full screen; arrows; `Esc` | Presenter view; viewer HTML release (D10) |
| **Presenter view** (c · M4) | `▶ ▾ › Present with presenter view`; `/s/:asset/presenter` | Second window with notes, next, timer | `✦ Write speaker notes` (M2+) |
| **Speaker notes** (c · M4) | Page · M `Notes`; Pages row disclosure | Type | Presenter view; agents read them |
| **Export MP4** (c · M3) | Export `Video` chip; `Mod+Shift+E`; range pill `Export range…`; pal | Pick container, size, fps, quality, range; estimate; `Export MP4` | Pause / resume; background toast; `Show in folder`; `Play` |
| **Export WebM · GIF · image sequence · audio only** (c · M4) | Container chips (rendered when encodable) | As MP4 | GIF loop / colours in Advanced |
| **Transparent video** (c · M4) | Advanced `Transparent` (WebM / sequence only) | Toggle | Checkerboard preview |
| **Chapters from markers** (c · M4) | Advanced switch | Toggle | — |
| **Export estimate (size · time · poster)** (c · M3) | Export preview card | Read before pressing | Scrub the poster |
| **Resume a render after reload** (c · M3) | Toast on boot | `Resume` | `Discard` deletes the partial |
| **Captions: generate** (c · M5) | Clip pill `⋯ › Captions ▾ › Generate…`; Transcript tab; chat | Pick where and style → job → captions stream in | Fix words; restyle; export sidecar |
| **Captions: import / type / from text** (c · M5) | Drop `.srt`; `+ Add track ▾ › Captions`, `Alt+C`; text pill `Make caption` | | Same track afterwards |
| **Caption styles** (c · M5) | Caption pill `Style ▾`; Captions · S; brand kit | Pick `Bold pop` for the track | `This caption only`; every TEXT control |
| **Caption position and safe areas** (c · M3 overlay · M5 captions) | Captions · S grid; `View › Safe areas ▾`; drag on preview | Pick bottom-centre; snaps to the safe guide | Platform overlays (Reels, Shorts) |
| **Edit by transcript** (c · M5) | Transcript tab: select words, `Delete` | Ripple cut across tracks; `‖` marks | Undo; `Keep · Cut` review |
| **Filler and silence removal** (c · M5) | Transcript `Filler words` chip; range pill `✦`/`Remove silences`; chat | `Remove all · Review` | Review steps each cut |
| **Speakers** (c · M5) | Transcript `Speaker 1 ▾` | Rename | `lower-third` style uses it |
| **Export captions as `.srt` / `.vtt`** (c · M5) | Export `Captions ▾ Sidecar`; caption pill `⋯ › Export captions…` | | — |
| **Cutout (matte)** (c · M5) | Video pill `✦ Cut out person` (M2 slot 6); Cutout section | Live mask at once, baked matte as a job | `Shape ▾`, `Feather`, `Outline`, `Shadow`, position presets; `✦ Fix edges` |
| **Extend / regenerate a clip or range** (c · M5) | Range pill `✦ Extend from here`, `✦ Regenerate range`; clip pill `Lineage` | Inline sheet, prompt prefilled, 8 s | Lineage badge; `Regenerate` new seed |
| **Generate clip / audio / sound effect** (c · M5) | Chat; range pill `✦ Sound effect`; Assets `Generate ▾` | Placeholder clip with a progress chip | Takes A/B; lineage |
| **Agent timeline edits and timeline diff** (c · M3 views · M2 proposals) | Proposals draw on the tracks: added clips hatched, cut ranges red | Accept / Reject / Apply part | History log |
| **Agent transcript view** (c · M5) | `agent/read-view kind: transcript` | — | `Zoom here` from a word range |
| **Lottie import** (c · M5+, A.5) | Drop `.json` → a `lottie` asset clip | Plays as a clip; parameters read-only | Export as video; Rive **reject** (A.12) |
| **Audio-only page / waveform element** (defer, A.8) | Element `Waveform` bound to a clip | — | — |
| **Speed ramps** (defer M5+, A.2) | Clip · P `Speed` channel keyable | Keys on speed; the filmstrip stretches | — |
| **Beat markers** (defer, A.8) | Audio pill `⋯ › Detect beats` → markers | — | Snap to beats |
| **Component states Smart move / prototype interactions** (defer, A.6) | — | — | — |
| **3D flip / cube / particles** (reject / defer, A.5, A.7) | — | — | — |

### 17.2 Follow-ups — every (c), with a milestone (never rendered before it lands)

| # | Item | Where | Milestone |
|---|---|---|---|
| V-1 | **Temporal model**: `Temporal`, `Source`, `Track`, `Page.duration`, story time with transition overlaps; validation `IF-CS-011`; CRDT parts per page keep tracks; story audio on the root part | `components.ts`, document parts, `@staticflux/motion` ticks | **M3** |
| V-2 | **`@staticflux/motion`** evaluator `evaluate(stage, t)`, channels, easing (bezier, hold, steps, sampled springs), interpolators, seeded PRNG, lint | new package (Δ15) | M3 |
| V-3 | **`@staticflux/media`**: `MediaClock`, `DecoderPool`, Mediabunny port, `MediaIndex`, AudioWorklet host, mixer, offline render | new package (Δ16) | M3 |
| V-4 | **Playback and scrub**: audio-master clock, coarse-then-exact scrub, hover scrub, `J K L`, frame step, loop, quality switch; render-worker motion override (E-6) | `src/timeline/`, render module | M3 |
| V-5 | **Edit gestures**: move (overwrite / insert), trim, ripple, roll, slip, slide, split, join, lift, ripple delete, range delete, `Q W E`, nudge, snapping, markers | editor worker `src/tools/timeline-*.ts`, capabilities | M3 |
| V-6 | **Proxies, filmstrips, waveform peaks, media probe** as renditions; provisional clips | `renditions.ts`, `ingest.ts` | M3 |
| V-7 | **Audio**: clip gain (keyable), fades, equal-power crossfades, track faders, master + limiter, meters, pan, normalise, mute / solo, audio scrubbing, link / unlink / detach | media worker, kit `<sf-meter>` | M3 |
| V-8 | **Keyframes UI**: `◇` on fields, keys strip, lanes, move / scale / copy / delete / hold, rubber-band, curve picker (bezier + hold), `Alt`-offset | `src/spec/controls.ts`, kit `<sf-curve-picker>` | M3 |
| V-9 | **Speed, reverse, pitch-preserve, freeze frame** | media worker, `Source` | M3 |
| V-10 | **Clip-path / mask channel** for wipes, mask reveals and text reveals | scene IR, render crate | M4 |
| V-11 | **Motion preset assets** (catalogue §4.3 shipped as workspace assets), `PresetUse`, the preset sheet with in-place previews, parameters, `Bake to keyframes`, save / brand presets | `src/library`, kit `<sf-preset-sheet>` | **M4** |
| V-12 | **Text animation units** (`char · word · line`, stagger, order, seeded random) on the GPU after layout | text pipeline, render | M4 |
| V-13 | **Transitions**: node, catalogue (§7.2), gap selection on the filmstrip and story track, overlap blocks, `Apply to all gaps`, clip transitions with `Trim for me`, reduced-motion fallback | render WGSL passes, `src/timeline/` | M4 |
| V-14 | **Smart move** matcher (keys, suggestions, text morph modes, unmatched policy), `Matches` list, canvas arrows | `src/timeline/smart-move.ts` | M4 |
| V-15 | **Springs catalogue and value graph** (Pro) | motion package, kit | M4 |
| V-16 | **Motion path on canvas** (position channels) | overlay batch | M4 |
| V-17 | **Zoom here / punch-in** (page camera channel) | capabilities, evaluator | M4 |
| V-18 | **Presentation**: fullscreen takeover, builds model (`Advance`, `Builds ▸`, `With previous`), show keys, presenter window + `BroadcastChannel`, notes, viewer HTML release | `src/present/`, NAV route `/s/:asset/presenter`, Share › Publish | M4 |
| V-19 | **MP4 export**: `video` format family, encoder probes, offline evaluator at export fps, offline audio mix, GOP checkpoints, pause / resume (incl. after reload), estimate, poster scrubber, range / pages scope, chapters | `src/export/`, `@staticflux/media ExportJob` | **M3** (chapters M4) |
| V-20 | **WebM (VP9/AV1 + Opus, alpha), GIF (gifenc, loop, colours, dither), image sequence (zip), audio only (`.m4a`)** | `src/export/formats.ts` | M4 |
| V-21 | **Timeline agent view codec** (OTIO-shaped seconds; `clip.place`, `keyframe.set`, `transition`, `motion` ops; timeline diff rendering on the tracks) | `@staticflux/agentview`, proposals | M3 (view), M2 proposals |
| V-22 | **Captions**: transcript asset, on-device + provider transcription jobs, caption track role, caption style presets (§9.4), `.srt`/`.vtt` import and export, `Max words` chunking, Transcript dock tab, speakers, confidence | `src/captions/` | **M5** |
| V-23 | **Edit by transcript**, filler and silence detection with `Review` | `src/captions/`, capabilities | M5 |
| V-24 | **Karaoke highlight** text animation keyed to word times | text animation (V-12) + transcript | M5 |
| V-25 | **Duck under voice** (auto gain keys tagged `auto`) and **Record voice-over** | media worker | M5 |
| V-26 | **Cutout matte** jobs (live mask preview, baked matte), `Cutout` section, position presets | ONNX worker, `Matte` component | M5 |
| V-27 | **Extend / regenerate / generate** media (recipes, lineage badge, takes) | capabilities + providers | M5 |
| V-28 | **Transcript agent view codec** | `@staticflux/agentview` | M5 |
| V-29 | **Safe-area overlays** (title / action safe, platform UI shapes) | overlay batch, `View ▾` | M3 (overlay) |
| V-30 | **Fidelity suite** (§13) and the flashing guard (§12, §15) | tests, a11y facts | M3 / M4 |
| V-31 | Lottie import as a clip; speed ramps; beat markers; waveform element; audio descriptions | later | M5+ / backlog |

## 18. Owner questions (recommendation first, in plain words)

**Q1. Milestone numbering.** `CAPABILITY-COVERAGE.md` says the Timeline and Motion rows are "M2"; `PLAN.md` §2 says Timeline
is **M3** and Motion & presentation **M4** (M2 is the agent layer). *Recommend:* keep PLAN's numbering in this spec (it is what
the engineering plan is sequenced against) and fix the coverage table. *Example:* when the coordinator briefs "the M2 timeline
work", read it as "the first timeline work package after the agent layer", i.e. V-1…V-9 and V-19. *Question:* agreed, or do you
want the timeline pulled ahead of the agent layer? (Pulling it forward is possible: V-1…V-9 depend only on M1; only the
agent timeline view V-21 needs M2.)

**Q2. A tray under Canvas and Pages, as well as the Timeline lens.** *Recommend:* yes, both (§2.2). The tray is one strip
(the story in time + the selected element's keys) that opens when you first press `Animate`, so animating a headline never
forces a lens switch; the lens is the full editor with tracks. Alternative: lens only (CapCut's way). Rejected because scenario
B's person is laying out pages and wants to see the title move *there*. *Example:* select the title, `Animate ▾ Fade up`, the
tray slides up under the page showing a 5 s clip with a tangerine cap; press `Space` and watch the layout animate under the
inspector you were using. *Question:* fine to spend the tray (≈ 1 week on top of the lens)?

**Q3. Pages ripple; element clips do not.** *Recommend:* on the story track, trimming or deleting a page always moves the pages
after it (no empty time between pages); on element tracks, `Delete` leaves a gap and `Shift+Delete` closes it (Premiere's rule,
muscle memory). *Example:* cut 2 s off page 2 → pages 3–5 slide left; cut 2 s off a logo overlay → the logo ends earlier and
the page keeps its length. *Question:* agreed that pages never have empty time between them? (Keynote and Canva agree; Final
Cut's magnetic timeline is the same idea.)

**Q4. No trim tools; modifiers instead.** *Recommend:* trim by dragging an edge; `Alt` on a shared edge = roll; `Alt` inside a
clip = slip; `Alt+Shift` inside = slide; a two-line label names the edit while you drag (§3.3). Alternative: Premiere's five trim
tools. Rejected: tool modes are the most-cited reason non-editors give up on Premiere, and Studio already uses exactly these
three modifiers everywhere. *Example:* you grab the end of the reaction clip and pull left: label `Trim end · −0.4 s`; hold `Alt`
and grab the join between two clips: `Roll · +0.4 s`. *Question:* agreed? The cost is that `Alt`+drag on a clip body cannot mean
duplicate (it means slip); duplicate stays `Mod+D` and `Alt`+drag on the **canvas** keeps its meaning.

**Q5. `Space` depends on focus in Canvas with the tray open.** *Recommend:* in the Timeline lens `Space` always plays; in
Canvas / Pages with the tray open, `Space` plays when the tray or transport has focus and pans (hold) when the canvas has
focus; the play button's tooltip says so (§3). Alternative: `Space` always plays once a tray is open, and panning moves to
`H`-hold only. Rejected: hold-Space-to-pan is deep muscle memory from Figma and Photoshop. *Question:* acceptable, or would
you rather `Shift+Space` play from the canvas (an extra key for the common case, but no ambiguity)?

**Q6. The first keyframe is explicit; later ones are automatic and announced.** *Recommend:* no After Effects stopwatch and no
record mode; click `◇` beside a field (or apply a preset) to start; after that, changing a value at a new time adds a key and a
1.5 s hint says `Key added at 2.0 s` (§5.3). Alternative: Premiere's per-property toggle. Rejected: AE's silent auto-keys are
the top beginner trap, and a stopwatch icon means nothing to a designer. *Example:* move the playhead to 2 s, drag the logo
right: hint `Key added at 2.0 s`, a diamond appears under the clip, a motion path appears on the canvas. *Question:* agreed?

**Q7. Smart move shows its matches.** *Recommend:* the gap pill reads `Smart move · 12 matched · 2 unmatched` and a `Matches`
list lets you link or unlink pairs; the canvas draws arrows from A to B while the gap is selected (§6.3). Keynote and Figma
match silently; ours shows the pairing because that is what fails in both. *Example:* you add a new price badge on page 2
that was not on page 1: the list says `Price (fades in)`; if you wanted it to fly in from the old sticker, click `Link…` and
pick the sticker on page 1. *Question:* agreed? Also: should **suggested** matches (same text or image, no key) be linked
automatically with a hint, or only offered? *Recommend* offered (never silently change the document).

**Q8. Video is a chip in the Export dialog, not a tab.** *Recommend:* `Video` joins `PNG · JPG · PDF · SVG` in the Format
row, with its own rows underneath (container, size, fps, quality, range, audio, captions) and the same preset row, name line,
progress and toast (§10). The brief said "tab"; a tab would split "export this design" in two and duplicate the preset and
memory logic. *Example:* `Mod+Shift+E`, click `Video`, read `≈ 24 MB · ≈ 1 min`, press `Export MP4`, close the dialog, keep
editing; the toast shows progress and `Pause`. *Question:* agreed? And is **pause / resume across a reload** worth the GOP
checkpoint work in M3 (≈ 3 days), or can it wait for M4?

**Q9. Reduced motion changes the preview and the show, never the export.** *Recommend:* with reduced motion on, every
transition and Smart move previews as a 0.3 s fade, emphasis and loops rest, hover previews need a click; the Export dialog
says `Export includes full motion`; presentation offers `Play motion anyway` per show (§15). Alternative: honour the setting
in export too. Rejected: an MP4 is for other people's screens; their players apply their own settings. *Question:* agreed?

**Q10. Captions are text elements with presets, not a separate system.** *Recommend:* a caption is a text clip on a caption
track; `Bold pop`, `Karaoke`, `Lower third` are text presets with a layout; every TEXT-FONTS control applies; sidecar `.srt`
and burn-in come from the same clips (§9). Transcription runs on the device when the model is installed, else through the
configured assistant, and the sheet explains both (the one place a not-yet-available thing is rendered, because the sheet *is*
the explanation). *Question:* agreed that the on-device model (≈ 40–80 MB download) is offered from Settings › Assistant,
and that "Edit by transcript" (delete words = cut video) is in scope for M5?

**Q11. Timecode.** *Recommend:* seconds with one decimal for people (`0:12.4`) in Focus and Standard, SMPTE timecode
(`00:00:12:10`) in Pro, frames always on the grid (§1.1 rule 7). Alternative: timecode everywhere (every NLE). Rejected: a
first-timer reads `12.4 s`, not `00:00:12:10`. *Question:* agreed?

**Q12. Presentation route.** `/s/:asset/presenter` is reserved here for the presenter window and `?present=<page>` as an
intent key; both need a row in NAVIGATION-DEEPLINKS §2. *Recommend:* add them when V-18 is briefed, not now (the owner asked
UX docs to stay the source; the NAV file's owner should add the row). *Question:* fine?

## Appendix A. Feature checklist against CapCut · Premiere · Final Cut · DaVinci · Descript · Keynote · Figma · Canva · After Effects · Rive / Lottie

Method (coordinator, 2026-10-25): every motion, timeline, audio, caption, export and presentation control the ten tools offer,
each marked **include** (where it lives, per density: `S` = Standard at rest, `M` = behind `More ▾` or a row's second line, `P` =
Pro only, `HUD` = the pill, `sheet` = the preset / transition sheet, `tray`, `lens`, `menu` = More / context / palette, `View`,
`Export`), **defer** (milestone and the §17.2 item) or **reject** (why). Columns `C P F D De K Fi Ca AE R` = CapCut, Premiere,
Final Cut, DaVinci, Descript, Keynote, Figma (Smart Animate / prototyping), Canva, After Effects, Rive or Lottie have it.
Nothing basic is left implicit.

### A.1 Timeline basics

| Control | C P F D De K Fi Ca AE R | Decision | Where / why |
|---|---|---|---|
| Tracks (video, overlay, text, audio) | ✓ ✓ ✓ ✓ ✓ – – ✓ (limited) ✓ – | **include** (c M3) | lens rows; Standard folds per kind, Pro per track |
| Main / story track with sequential clips | ✓ – ✓ (magnetic) – ✓ – – ✓ – – | **include** (c M3) | pages are clips; §2.1 |
| Pages as clips (slides with durations) | – – – – – ✓ – ✓ – – | **include** (c M3, departure) | one document |
| Nested sequences / compound clips | – ✓ ✓ ✓ – – – – ✓ (precomp) – | include via `instance` of a composition (c M4+) | DOCUMENT-FORMAT §3.1 `instance` carries its own time; UI = `Make composition` in a page's More (defer M4+) |
| Ruler with timecode | ✓ ✓ ✓ ✓ – – – – ✓ ✓ | include (c M3) | seconds; Pro timecode (Q11) |
| Playhead, red line | ✓ ✓ ✓ ✓ ✓ – ✓ – ✓ ✓ | include (c M3) | |
| Track headers: name, eye, mute, solo, lock | ✓ ✓ ✓ ✓ – – – – ✓ – | include (c M3) | header |
| Track height / zoom | ✓ ✓ ✓ ✓ – – – – ✓ – | include (c M3) | handle, double-click |
| Filmstrip thumbnails on clips | ✓ ✓ ✓ ✓ – – – ✓ ✓ – | include (c M3) | renditions |
| Waveforms on clips | ✓ ✓ ✓ ✓ ✓ – – ✓ ✓ – | include (c M3) | peaks |
| Markers (with names, colours) | ✓ ✓ ✓ ✓ – – – – ✓ – | include (c M3) | `M`; chapters M4 |
| Clip markers (inside a clip) | – ✓ ✓ ✓ – – – – ✓ – | reject | story markers suffice; a clip marker moves with the clip in no tool consistently |
| Snapping toggle | ✓ ✓ ✓ ✓ – – – – ✓ – | include (c M3) | `N` |
| Linked A/V selection | ✓ ✓ ✓ ✓ – – – – – – | include (c M3) | §3.3 |
| Multiple sequences / timelines per project | – ✓ ✓ ✓ – – – – ✓ – | reject | one story per design; several designs in a project (HOME-FILES) |
| Timeline search / find clip | – ✓ ✓ ✓ ✓ – – – – – | include (b, Find bar `Kind ▾ Clip`) | STUDIO §9.1 |
| Clip colour labels | – ✓ ✓ ✓ – – – – ✓ – | include (c M3, Pro) | clip `⋯ › Label ▾`; Pro only |
| Disable / enable a clip | – ✓ ✓ ✓ – – – – ✓ – | include (c M3) | = hide (A-2) in time; eye on the clip in Pro |
| Multicam | – ✓ ✓ ✓ – – – – – – | reject | out of scope for a design tool |
| Proxy workflow toggle | – ✓ ✓ ✓ – – – – – – | include (c M3) | transport `Quality ▾ Auto · Full · Draft` |
| Timeline tray on a layout surface | – – – – – – – – – – | **include** (departure) | §2.2 |

### A.2 Trim and edit

| Control | C P F D De K Fi Ca AE R | Decision | Where |
|---|---|---|---|
| Move clip, overwrite / insert | ✓ ✓ ✓ ✓ – – – ✓ ✓ – | include (c M3) | drag; `Shift` insert |
| Trim edges | ✓ ✓ ✓ ✓ ✓ – – ✓ ✓ – | include (c M3) | edge drag |
| Ripple trim / ripple delete | ✓ ✓ ✓ ✓ ✓ – – ✓ – – | include (c M3) | story default; `Shift` |
| Roll | – ✓ ✓ ✓ – – – – – – | include (c M3) | `Alt` on a shared edge |
| Slip | – ✓ ✓ ✓ – – – – – – | include (c M3) | `Alt` inside |
| Slide | – ✓ ✓ ✓ – – – – – – | include (c M3) | `Alt+Shift` inside |
| Trim to playhead (`Q`/`W`), extend edit (`E`) | – ✓ ✓ ✓ – – – – – – | include (c M3) | keys |
| Split at playhead | ✓ ✓ ✓ ✓ ✓ – – ✓ ✓ – | include (c M3) | `S` |
| Join through-edit | – ✓ ✓ ✓ – – – – – – | include (c M3) | pill `Join` |
| Lift / extract (range delete) | – ✓ ✓ ✓ ✓ – – – – – | include (c M3) | `Delete` / `Shift+Delete` on a range |
| Speed (constant), reverse | ✓ ✓ ✓ ✓ – – – ✓ ✓ – | include (c M3) | pill `Speed ▾` |
| Speed ramps (curve) | ✓ ✓ ✓ ✓ – – – – ✓ (time remap) – | **defer** M5+ (V-31) | needs a keyable speed channel with a time map |
| Freeze frame | ✓ ✓ ✓ ✓ – – – – ✓ – | include (c M3) | `Alt+F` |
| Rate stretch tool | – ✓ – – – – – – – – | reject | `Speed ▾` with ripple covers it |
| Duplicate clip | ✓ ✓ ✓ ✓ ✓ – – ✓ ✓ – | include | `Mod+D` |
| Copy / paste attributes (motion, audio) | – ✓ ✓ ✓ – – – ✓ ✓ – | include (b/c) | copy style carries motion |
| Replace clip keeping edits | ✓ ✓ ✓ ✓ – – – ✓ – – | include (c M3) | Clip · S `Replace…` |
| Nudge by frame | ✓ ✓ ✓ ✓ – – – – ✓ – | include | `,` `.` |
| Group clips | – ✓ (nest) ✓ (compound) ✓ – – – ✓ – – | defer M4+ (composition instance) | A.1 |
| Crop / position in frame (video) | ✓ ✓ ✓ ✓ – – – ✓ ✓ – | include | the element's Transform and Image crop (APPEARANCE) |
| Stabilise, colour grading, LUTs | ✓ ✓ ✓ ✓ – – – – ✓ – | reject (M1–M5) | a colour page is DaVinci's domain; image adjustments (A-10) cover the basics |
| Keyboard-only edit of every gesture | – ✓ ✓ ✓ – – – – ✓ – | **include** | §3 |

### A.3 Playback and navigation

| Control | C P F D De K Fi Ca AE R | Decision | Where |
|---|---|---|---|
| Space play/pause | ✓ ✓ ✓ ✓ ✓ ✓ ✓ ✓ ✓ ✓ | include | |
| J K L shuttle with rates | – ✓ ✓ ✓ – – – – – – | include | |
| Frame step, 1 s step | ✓ ✓ ✓ ✓ ✓ – – – ✓ ✓ | include (departure: `Shift` = 1 s) | |
| Edit-point jump (`↑`/`↓`) | – ✓ ✓ ✓ – – – – – – | include | |
| In / out points | – ✓ ✓ ✓ – – – – – – | include | `I` `O` |
| Loop range | ✓ ✓ ✓ ✓ – – – – ✓ ✓ | include | `Alt+L` |
| Audio scrubbing toggle | – ✓ ✓ ✓ – – – – – – | include | `Shift+S` |
| Hover scrub (skimming) | ✓ (preview) – ✓ (skimmer) – – – – – – – | include (`Alt`+hover) | Final Cut's skimmer is always on and people hate it; ours is held |
| Go to time field | – ✓ ✓ ✓ – – – – ✓ – | include | `Alt+G` |
| Full-screen preview | ✓ ✓ ✓ ✓ ✓ – – ✓ – – | include | `Shift+F` |
| Second-monitor program output | – ✓ ✓ ✓ – – – – – – | reject (M1–M5) | the presenter window is the second-window case |
| Playback quality switch | ✓ ✓ ✓ ✓ – – – – ✓ – | include | transport `⋯` |
| Safe-area overlays | – ✓ ✓ ✓ – – – ✓ (margins) – – | include (c M3) | `View › Safe areas ▾` |

### A.4 Keyframes and easing

| Control | C P F D De K Fi Ca AE R | Decision | Where |
|---|---|---|---|
| Keyframes on transform / opacity | ✓ ✓ ✓ ✓ – – – – ✓ ✓ | include (c M3) | `◇` |
| Keyframes on every parameter (effects, colour, audio) | – ✓ ✓ ✓ – – – – ✓ ✓ | include (c M3) | IF-9.1 |
| Stopwatch / record mode | – ✓ (toggle) – – – – – – ✓ – | **reject** (Q6) | explicit first key + announced auto-keys |
| Keyframe lanes per property | – ✓ – ✓ – – – – ✓ ✓ | include (Pro) | §5.2 |
| Value graph / graph editor | – – – ✓ – – – – ✓ ✓ | include (Pro, c M4) | V-15 |
| Easing presets (named) | ✓ ✓ ✓ ✓ – – ✓ ✓ ✓ ✓ | include | curve picker |
| Bezier handles | – ✓ (temporal) – ✓ – – ✓ – ✓ ✓ | include (`Custom ▸`) | |
| Springs | – – – – – – ✓ – – ✓ | **include** (c M4) | pre-sampled (departure vs AE) |
| Hold keyframes | – ✓ ✓ ✓ – – – – ✓ ✓ | include | `Hold` |
| Motion path on canvas | – ✓ ✓ – – – – – ✓ – | include (c M4) | |
| Copy / paste keys | – ✓ ✓ ✓ – – – – ✓ ✓ | include | |
| Scale / reverse keys | – ✓ ✓ – – – – – ✓ ✓ | include | `Alt`+drag last; `Reverse` |
| Expressions / scripting | – – – – – – – – ✓ – | reject | flows (M6) and agents are the automation story |
| Parenting / constraints | – – – – – – – – ✓ ✓ | reject (M1–M5) | groups animate as one; A-8 constraints are layout |
| Bake preset to keys | – – – – – – – – – – | **include** (departure) | |
| Animated text properties (size, spacing, colour) | ✓ – – – – – – – ✓ – | include | §5.5 |
| Animate structure (parent, order) | – – – – – – – – – ✓ | reject | not keyable; split the clip |
| 3D rotation / camera | ✓ ✓ – ✓ – ✓ – – ✓ – | reject (M1–M5) | 2D stand-ins (`Flip in` via skew); B10b perspective later |

### A.5 Presets and text animation

| Control | C P F D De K Fi Ca AE R | Decision | Where |
|---|---|---|---|
| Animate In / Out presets | ✓ ✓ (presets) ✓ (titles) ✓ – ✓ (builds) – ✓ ✓ (presets) ✓ | include (c M4) | sheet |
| Emphasis (action) presets | ✓ (combo) – – – – ✓ – – – – | include | |
| Loop presets | – – – – – – – – – ✓ | include | |
| Text by letter / word / line with stagger | ✓ – ✓ – – ✓ (by letter/word) – ✓ (some) ✓ (animators) ✓ | **include** | sheet text row |
| Preview on hover | ✓ (thumbnail) – ✓ – – ✓ (delayed) – ✓ (thumbnail) – – | **include** on the real element (departure) | |
| Duration / delay / direction / distance | ✓ ✓ ✓ ✓ – ✓ – ✓ (speed) ✓ – | include | sheet |
| Apply to all elements / page (Magic Animate) | – – – – – – – ✓ – – | include | `Animate all`, `Apply to all <kind>` |
| Save custom preset | ✓ ✓ ✓ ✓ – – – – ✓ – | include | `Save as preset…` |
| Presets as assets with slugs / brand presets | – – – – – – – – – – | **include** (departure) | IF-9.2 |
| Ken Burns / zoom / pan on images and pages | ✓ ✓ ✓ ✓ – ✓ – ✓ – – | include | page presets |
| Typewriter, karaoke highlight | ✓ – – – ✓ (captions) – – ✓ – – | include (M4; karaoke M5) | |
| Particles, 3D text, path-follow text | ✓ – – – – – – – ✓ – | **defer** / reject | path text is TEXT T-17; particles M5+ (V-31) |
| Stickers / GIF overlays | ✓ – – – – – – ✓ – – | include via image clips (GIF decode c M3) | |
| Lottie import | – – – – – – – ✓ (limited) ✓ (Bodymovin export) ✓ | defer M5+ (V-31) | asset kind `lottie` exists |
| Rive import | – – – – – – – – – ✓ | reject | runtime-bound format; export to video not meaningful |
| Lottie / Rive export | – – – – – – – – ✓ (plugin) ✓ | reject (M1–M5) | video and viewer HTML are the outputs (D10) |

### A.6 Auto Animate

| Control | C P F D De K Fi Ca AE R | Decision | Where |
|---|---|---|---|
| Tween matched elements between pages (Magic Move / Smart Animate) | – – – – – ✓ – ✓ (Magic Animate ≈) – – | **include** (c M4) | Smart move |
| Matching rule | – – – – – identity ✓ name – – – | **include by key, suggestions shown** (departure) | §6.2 |
| Matched / unmatched list | – – – – – – – – – – | **include** (departure) | `Matches` |
| Text morph by word / letter | – – – – – ✓ (by char/word) – – – – | include | `Morph text ▾` |
| Unmatched policy (fade / scale) | – – – – – ✓ (fade) ✓ (fade) – – – | include | `Unmatched ▾` |
| Duration / curve | – – – – – ✓ ✓ – – – | include | pill |
| Between component states / variants | – – – – – – ✓ – – ✓ (state machine) | **defer** (A-12 components first) | §6.4 |
| Prototype interactions (click → navigate, hover) | – – – – – – ✓ – – ✓ | **reject** (M1–M5) | the output is pages and video; builds on click cover decks |
| Apply to all gaps | – – – – – ✓ – ✓ – – | include | |

### A.7 Transitions

| Control | C P F D De K Fi Ca AE R | Decision | Where |
|---|---|---|---|
| Dissolve / crossfade | ✓ ✓ ✓ ✓ ✓ ✓ ✓ ✓ ✓ – | include | |
| Dip to black / white / colour | ✓ ✓ ✓ ✓ – ✓ – ✓ – – | include | |
| Push / slide / wipe (4 directions) | ✓ ✓ ✓ ✓ – ✓ ✓ (move in/out) ✓ – – | include | |
| Zoom / blur | ✓ ✓ ✓ ✓ – ✓ – ✓ – – | include | |
| Luma wipe with pattern | – ✓ ✓ ✓ – – – – – – | include | `Pattern ▾` |
| Smart move | – – – – – ✓ ✓ – – – | include | §6 |
| Flip / cube / 3D | ✓ ✓ ✓ ✓ – ✓ – ✓ – – | Flip include (2D); cube **defer** (3D) | |
| Glitch / shake / light leak packs | ✓ – – – – – – ✓ – – | defer M5+ | brand/asset packs once presets are assets |
| Duration drag on the overlap | ✓ ✓ ✓ ✓ – – – – – – | include | |
| Alignment (centre / start / end) | – ✓ ✓ ✓ – – – – – – | include (M) | |
| Apply default transition (`Mod+D` in Premiere) | – ✓ ✓ ✓ – – – ✓ – – | include as `Apply to all gaps` and a default in the sheet | `Mod+D` stays Duplicate |
| Transition on a clip's start/end alone (fade from black) | ✓ ✓ ✓ ✓ – – – – – – | include | the sheet on a clip edge with no neighbour |
| Audio crossfade with video transition | ✓ ✓ ✓ ✓ – – – – – – | include | automatic |
| Insufficient media handling | – warn ✓ warn – – – – – – – | **include** `Trim for me` (departure) | |

### A.8 Audio

| Control | C P F D De K Fi Ca AE R | Decision | Where |
|---|---|---|---|
| Clip volume | ✓ ✓ ✓ ✓ ✓ ✓ – ✓ ✓ – | include | |
| Fade in / out handles | ✓ ✓ ✓ ✓ ✓ – – ✓ – – | include | |
| Crossfade | ✓ ✓ ✓ ✓ ✓ – – ✓ – – | include | |
| Gain keyframes (rubber band) | – ✓ ✓ ✓ – – – – ✓ – | include | |
| Track fader, mute, solo | ✓ ✓ ✓ ✓ ✓ – – – – – | include | |
| Master meter and limiter | – ✓ ✓ ✓ ✓ – – – – – | include | |
| Pan | – ✓ ✓ ✓ – – – – – – | include (M) | |
| Loudness normalise | – ✓ ✓ ✓ ✓ – – – – – | include | |
| Auto ducking | – ✓ (auto) ✓ (range) ✓ ✓ – – – – – | include (c M5) | |
| Noise removal / studio sound | ✓ ✓ ✓ ✓ ✓ – – – – – | defer M5+ | an audio ML job; same job pattern as the matte |
| EQ, compressor, effects rack | – ✓ ✓ ✓ – – – – – – | reject (M1–M5) | the limiter and normalise cover the design-tool case |
| Beat detection / markers | ✓ – – – – – – ✓ (beat sync) – – | defer (V-31) | |
| Voice-over recording | ✓ ✓ ✓ ✓ ✓ ✓ – ✓ – – | include (c M5) | |
| Text to speech | ✓ – – – ✓ (overdub) – – – – – | defer M5 (assistant `✦ Voice`) | provider-gated |
| Music library | ✓ – – – ✓ – – ✓ – – | include via Assets › Audio (bring your own); licensed library **reject** (licensing) | |
| Audio-only export | – ✓ ✓ ✓ ✓ – – – – – | include (c M4) | |
| Waveform visualiser element | – – – – – – – ✓ (some) ✓ (plugin) – | defer (V-31) | |
| Detach audio | ✓ ✓ ✓ ✓ – – – ✓ – – | include | |
| Pitch preservation at speed | ✓ ✓ ✓ ✓ – – – – – – | include | |
| Audio scrub | – ✓ ✓ ✓ – – – – – – | include | |

### A.9 Captions

| Control | C P F D De K Fi Ca AE R | Decision | Where |
|---|---|---|---|
| Auto captions (speech to text) | ✓ ✓ ✓ ✓ ✓ – – ✓ – – | include (c M5) | |
| On-device transcription | – ✓ (local) – ✓ ✓ (some) – – – – – | **include** (departure vs cloud-only) | |
| Caption style presets | ✓ ✓ ✓ ✓ ✓ – – ✓ – – | include | §9.4 |
| Word highlight / karaoke | ✓ – – – ✓ – – ✓ – – | include (M5) | |
| Edit text in place | ✓ ✓ ✓ ✓ ✓ – – ✓ – – | include | |
| Transcript panel | – ✓ – ✓ ✓ – – – – – | include | dock tab |
| Edit video by editing the transcript | – ✓ (text-based) – ✓ (some) ✓ – – – – – | **include** | §9.3 |
| Filler word and silence removal | ✓ – – – ✓ – – – – – | include (M5) | |
| Speaker labels | – ✓ – ✓ ✓ – – – – – | include | |
| Import / export SRT / VTT | ✓ ✓ ✓ ✓ ✓ – – ✓ – – | include | |
| Burn-in vs sidecar | ✓ ✓ ✓ ✓ ✓ – – ✓ (burn) – – | include | Export `Captions ▾` |
| Translation | ✓ – – – ✓ – – ✓ – – | defer M5 (assistant) | provider-gated |
| Caption position / safe areas | ✓ ✓ ✓ ✓ ✓ – – ✓ – – | include | |
| Max words / lines per caption | ✓ ✓ ✓ ✓ ✓ – – ✓ – – | include | |

### A.10 Export

| Control | C P F D De K Fi Ca AE R | Decision | Where |
|---|---|---|---|
| MP4 H.264 + AAC | ✓ ✓ ✓ ✓ ✓ ✓ ✓ (video) ✓ ✓ – | include (c M3) | |
| WebM / AV1 | – ✓ – ✓ – – – – – – | include when encodable (c M4) | |
| GIF | ✓ ✓ ✓ ✓ ✓ – ✓ ✓ ✓ ✓ | include (c M4) | |
| Image sequence | – ✓ ✓ ✓ – ✓ – – ✓ – | include (c M4) | |
| Audio only | – ✓ ✓ ✓ ✓ – – – – – | include (c M4) | |
| Transparent (alpha) video | – ✓ (ProRes) ✓ ✓ – ✓ – – ✓ – | include WebM alpha / sequence (c M4); ProRes **reject** (no encoder in the browser) | |
| Resolution / fps / bitrate | ✓ ✓ ✓ ✓ ✓ ✓ – ✓ ✓ – | include | |
| Range / in–out export | ✓ ✓ ✓ ✓ ✓ – – ✓ ✓ – | include | |
| Size and time estimate | – ✓ (size) – ✓ (size) – – – – ✓ – | **include** (departure: time too) | |
| Background render, queue | – ✓ (Media Encoder) ✓ ✓ – – – – ✓ – | include | toast, 1 waiting |
| Pause / resume, survive reload | – – – – – – – – – – | **include** (departure, c M3) | GOP checkpoints |
| Chapters from markers | – ✓ ✓ ✓ – – – – – – | include (c M4) | |
| Hardware encode selection | – ✓ ✓ ✓ – – – – ✓ – | include implicitly (probes); no UI | |
| Export presets (YouTube, TikTok…) | ✓ ✓ ✓ ✓ ✓ – – ✓ ✓ – | include (preset row) | |
| Direct upload to platforms | ✓ ✓ ✓ ✓ ✓ – – ✓ – – | **reject** (D3 no accounts; D10 releases are the share path) | |
| Poster / thumbnail frame choice | ✓ – – – ✓ – – – – – | include | preview card scrubber |
| Viewer HTML / web embed | – – – – ✓ (share) ✓ (Keynote Live) ✓ (prototype link) ✓ – ✓ | include (D10 release, c M4) | |

### A.11 Presentation

| Control | C P F D De K Fi Ca AE R | Decision | Where |
|---|---|---|---|
| Full-screen play with transitions | – – – – – ✓ ✓ (present) ✓ – – | include (c M4) | |
| Builds on click, build order, with previous | – – – – – ✓ – ✓ (some) – – | include | `Builds ▸` |
| Auto-advance pages with timing | – – – – – ✓ – ✓ – – | include | `Advance ▾ Auto` |
| Presenter view (notes, next, timer) | – – – – – ✓ – ✓ – – | include | second window |
| Speaker notes | – – – – – ✓ – ✓ – – | include | Page · M `Notes` |
| Black / white screen, go to page | – – – – – ✓ – ✓ – – | include | |
| Laser pointer / drawing on slides | – – – – – ✓ – ✓ – – | **defer** M5+ | nice for talks, not for the first version |
| Rehearse mode (timing per slide) | – – – – – ✓ – – – – | defer | the presenter timer covers most |
| Remote control from a phone | – – – – – ✓ – ✓ – – | **reject** (D1 no mobile) | a Bluetooth clicker works as keys |
| Keynote Live / audience link | – – – – – ✓ ✓ ✓ – – | include via the viewer HTML release (D10) | |
| Loop a show (kiosk) | – – – – – ✓ – – – – | include | `▶ ▾ › Loop` |
| Reduced motion in the show | – – – – – – – – – – | **include** (departure) | §11.2 |

### A.12 Not these controls, listed so they are not missed

Colour grading pages, LUTs, scopes (DaVinci); multicam; proxies as a separate managed media panel; EQ / compressor racks;
expressions (AE); 3D cameras and lights; particle systems; Rive state machines and runtime export; prototype interactions
(Figma); direct platform upload; phone remote; ProRes / DNx; 10-bit HDR export (M5+ when WebCodecs allows); cloud rendering.
Pixel-lens image editing (B-2), pen and vector animation of points (the Pen WP), comments on time ranges (B-8, `comment=` with
a `time` anchor is designed in DOCUMENT-FORMAT §7).

## Appendix B. Coordinator checklist rows this spec accounts for (`CAPABILITY-COVERAGE.md`)

| Row | How this spec accounts for it |
|---|---|
| **Timeline, video, audio (§8)** | §2 anatomy (lens and tray per density), §3 every gesture and key (playhead, J/K/L, range, markers, snapping, move / trim / ripple / roll / slip / slide / split / join / delete, speed, freeze, link, zoom here), §3.6 control tables, §8 audio (levels, fades, crossfades, faders, master, meters, pan, normalise, ducking, voice-over), §12 errors (IF-MEDIA-001, missing media, decode, encoder), §13 fidelity, §14 performance; FLOWS F-76, F-78, F-79, F-80; V-1…V-9, V-19 |
| **Motion: animation and transitions (§9)** | §4 presets (sheet, catalogue, text units, timing, saving), §5 keyframes and easing (`◇`, lanes, graph, motion path, curve picker, springs), §6 Smart move (match keys, suggestions, Matches list, text morph), §7 transitions (pages and clips, sheet, Trim for me, reduced motion); FLOWS F-73, F-74, F-75, F-77; V-10…V-17 |
| **Export (§29)** | §10 the `Video` chip: containers, size, fps, quality, range, audio, captions, transparent, chapters, estimate, poster, pause / resume, background, releases; FLOWS F-76, F-80; V-19, V-20 |
| **Generative features (§10)** | §9.2 transcription (on device or provider), §9.3 filler removal, §8.2 ducking, §17.1 cutout / Extend / regenerate / generate / `✦ Sound effect` as provider-gated proposals; V-22…V-27 |
| **Agent views and change sets (§6, §12)** | §13 timeline and transcript codecs, timeline diff on the tracks; every control is a capability with `plan()` (§16); V-21, V-28 |
| **Layers, Pages, Library, lenses (§23)** | Pages = story clips (§2.1), the Pages filmstrip = the tray (§2.2), `Builds ▸` on Pages rows (§11.2), Assets › Motion presets and Transcript tab (§4.6, §9.3), lens appearance rule (§2.1) |
| **Repeat (§26)** | Match keys `key~k` make Smart move work across repeats and expanded repeats (§6.2) |
| **Text and fonts (§21)** | Text animation units (§4.4), captions as text elements with presets (§9.4), karaoke (V-24), text stroke for caption outlines (T-18) |
| **Appearance (§20)** | Every stack item's `id` is a keyframe target (§5.5); transitions reuse paints (dip to colour); clip crop = image crop (A-3) |
| **Accessibility (§25)** | §15 reduced motion (content vs chrome), flashing guard, keyboard-only timeline, announcements, time fields, captions as output |
| **Versioning (§22)** | Milestone previews play the story with the same evaluator (§13); exports create nothing (D10) |
| **Import** | Video / audio / `.srt` / `.vtt` / Lottie drop targets (§3.5); unsupported codec placeholder (§12) |
| **Home, files, storage** | Large media and storage pressure (§12 `IF-LIB-002`); the `Video` intent tile on Home (UX.md scenario C) opens a design with the Timeline lens |
| **Brand kit** | Brand motion presets and caption style (§4.6, §9.4) |
| **Flows (§11)** | `Apply to all gaps`, `Animate all`, `Remove all · Review` are bulk capabilities a flow can record |
| **Identity and gating, sharing** | Presentation and releases (§10.4, §11); nothing here needs accounts |
| **Comments (§18)** | Time-anchored comments reserved (DOCUMENT-FORMAT §7); not designed here (B-8) |
| **Pixel lens (B-2)** | Image adjustments on video clips wait for A-10; cutout (V-26) is a media job, not a Pixel tool |
| **Backlog B-1, B-7** | This file; GAP-AUDIT updated |

