# UX-MOTION handoff — 2026-10-26
**Branch:** `claude/wip-ux-motion`  ·  **State:** **in progress** (docs only; no PR). Sections land in this order and each is
committed and pushed when done; if the session is cut, continue from the first unchecked item.

## Plan (tick as committed)
- [x] Handoff written (this file).
- [ ] `docs/instaflow/ux/MOTION-TIMELINE-UX-SPEC.md` §0–§1 (engine inventory, letters, principles, market analysis, departures).
- [ ] §2 Timeline lens anatomy per density; §3 every gesture and its keyboard path (playhead, J/K/L, trim, split, ripple,
      slip, slide, roll, markers, snapping, speed, range selection).
- [ ] §4 Animate presets library (in / emphasis / out / loop, text by letter · word · line, previews); §5 keyframes and
      easing curves; §6 Auto Animate (Smart move, match keys); §7 transitions (clips and pages).
- [ ] §8 audio (levels, fades, meters, ducking); §9 captions and subtitles (transcript, styles, burn-in, sidecar).
- [ ] §10 video export (the Export dialog's `Video` tab); §11 presentation mode and presenter view.
- [ ] §12 errors; §13 fidelity; §14 performance states; §15 a11y and reduced motion; §16 plumbing.
- [ ] §17 outlets + flows for every feature (deferred included) and the (c) schedule V-1…V-n with milestones; §18 owner
      questions; Appendix A competitor checklist (CapCut · Premiere · Final Cut · DaVinci · Descript · Keynote · Figma ·
      Canva · After Effects · Rive/Lottie), every row include / defer / reject; Appendix B coverage rows.
- [ ] Updates: STUDIO-UX-SPEC (§2.1 lens rows, §4.2.4 pill rows for clip / range / gap / keyframe, §7 keys),
      DENSITY-DISCLOSURE (§3 timeline tray rows, §8 clutter rows), GAP-AUDIT (B-1, B-7 → worked; inventory rows; gap #10,
      #13; pointer to the motion questions), `ux/README.md` row, FLOWS section I (F-73…F-80) + coverage matrix.
- [ ] Final push and report.

## Scope (from the brief and `CAPABILITY-COVERAGE.md`)
Rows owned: **Timeline, video, audio (§8)** and **Motion: animation and transitions (§9)**; plus the slice of **Export
(§29)** that is video; **Generative (§10)** where it touches media (transcribe, silence removal, Extend, cutout);
**Agent views (§6)** for the timeline and transcript views; **Accessibility (§25)** for the timeline; **Layers / Pages /
Library (§23)** for motion presets as assets and the Pages ⇄ clips identity; **Repeat (§26)** for match keys (IF-26.18);
backlog **B-1** (Timeline lens) and **B-7** (presentation mode).

## Baseline read (so nobody re-reads)
- Model exists on paper only: `DOCUMENT-FORMAT.md` §3 (`Temporal`, `Source`, `AudioMix`, `Motion { in, emphasis, out,
  loop, text { unit, stagger }, matchKey }`, `Animation` channels with keyed `Keyframe { t, value, interp hold | linear |
  bezier | spring, ease, spring }`, `Transition { from, to, preset, duration, alignment, params }`, `Track { trackKind
  video | overlay | text | audio, muted, locked, volume }`, `Page.advance auto | click`, `Composition.format.fps`).
- Engine today: nothing temporal is built. `studio-contributions.ts` declares the Timeline lens (shortcut `3`, blue
  palette), a `split` tool (`S`) and the `animate` HUD action; `studio-spec.ts` gives Timeline `[select, split, hand]` and
  the HUD `[animate, ask]`; `lens-features.ts` lets Timeline fall back to the Canvas arrangement. `lineage.key` (match key)
  exists on every element (`components.ts`), and repeats write deterministic keys (IF-26.18). `renditions.ts` says video
  posters and waveforms "arrive with M3". Export is PNG/PDF/SVG only (`formats.ts`).
- Milestones per `PLAN.md` §2: **M3 Timeline** (tracks, trim/split/ripple/roll/slip, speed, fades, clip transitions,
  keyframes, proxies, waveforms, audio-master playback, MP4), **M4 Motion & presentation** (preset assets, text animation,
  page transitions incl. Smart move, Zoom here, Animate HUD, presentation + presenter, WebM/GIF/sequence), **M5** (matte,
  transcription and captions, silence removal, Extend). `CAPABILITY-COVERAGE.md` says "M2" for both rows; the spec uses
  PLAN's numbering and raises the mismatch as an owner question.
- UX baseline: UX.md §2 (ranges are first-class selections), §3 (bottom tray = tracks), §4 (Timeline lens row, presentation
  mode), scenarios B, C, D; §9 keys (`Space`, `J/K/L`, `I/O`, `S`). STUDIO §2.1 lens model (Timeline appears with
  content). GAP-AUDIT §2 Timeline row and backlog B-1, B-7.

## Decisions taken (reasoning in the spec §1 and §18)
- The timeline is a **tray** on the Canvas / Pages lenses as well as the full **Timeline lens**: the tray (one strip)
  answers "animate this" without leaving the layout; the lens answers "edit this cut". Same model, same keys.
- **Pages are clips** in one **story track**; element tracks live inside a page (DOCUMENT-FORMAT). Standard shows one
  track per *kind* folded (Story, Overlays, Text, Audio, Captions); Pro shows every track.
- Presets are **assets** (IF-9.2) with live hover previews, applied from the pill's `Animate`; keyframes are the Pro tier.
- Auto Animate is `Smart move`, a **transition preset** (IF-9.3) with match keys made visible (`Match ▾` in the pill).
- Easing is a **curve picker** with named presets first and a bezier/spring editor behind `Custom`.
- Export to video is a **`Video` chip in the Export dialog's Format row** (not a tab of its own), so one dialog stays.
- Presentation mode is `▶ Present` in the top bar once the document has more than one page or any motion.

## Owner questions
In the spec §18 (recommendation first).
