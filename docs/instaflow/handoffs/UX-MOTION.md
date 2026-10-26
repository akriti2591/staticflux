# UX-MOTION handoff — 2026-10-26
**Branch:** `claude/wip-ux-motion`  ·  **State:** **done** (docs only; no PR; owner questions open in the spec §18)

## Files touched
- `docs/instaflow/ux/MOTION-TIMELINE-UX-SPEC.md` (new, Layer 2, ≈ 1 370 lines): §0 engine inventory and letters (almost
  everything is (c): M3 Timeline, M4 Motion & presentation, M5 captions and media) · §1 principles, market analysis against
  CapCut · Premiere · Final Cut · DaVinci · Descript · Keynote · Figma · Canva · After Effects · Rive/Lottie, departures,
  vocabulary · §2 Timeline lens and the **tray** under Canvas / Pages, per density · §3 every gesture and its key (transport,
  J/K/L, range, markers, snapping, move / trim / ripple / roll / slip / slide / split / join / lift, speed, freeze, link,
  zoom here; drag and drop into time; control tables for clip · range · gap · key · track) · §4 preset sheet, catalogue,
  text units, timing on the page, saving / brand presets · §5 keyframes (no stopwatch; explicit first key, announced auto
  keys), strips, lanes, graph, motion path, the curve picker with springs · §6 Smart move (match keys, suggested matches,
  the `Matches` list, canvas arrows, text morph) · §7 transitions for pages and clips (`Trim for me`) · §8 audio · §9
  captions and edit by transcript · §10 the Export dialog's `Video` chip (estimate, pause / resume across reload) · §11
  presentation, builds, presenter window · §12 errors · §13 fidelity · §14 performance states · §15 a11y and reduced motion ·
  §16 plumbing · **§17.1 outlet + flow + follow-up for every feature, deferred included** · §17.2 (c) schedule **V-1…V-31**
  with milestones · §18 owner questions **Q1–Q12** · Appendix A checklist (A.1–A.12, every row include / defer / reject) ·
  Appendix B coverage rows.
- `STUDIO-UX-SPEC.md`: §2 top bar `▶ Present` row; §2.1 Timeline pointer and "lens appears on first Animate"; §4.2.4 pill
  rows for the timeline selections and `Animate ▾` slot 4; §5.1 inspector rows; §7 keyboard map `Timeline` and
  `Presentation` groups, `Shift+T`, `3`.
- `DENSITY-DISCLOSURE.md`: §3.1 tray and track-area rows; §3.2 Clip / Gap / Key / Caption rows; §8.1 Page (Duration,
  Advance), Clip, Transition, Track header, Transport rows; §8.3 Preset sheet, Transition sheet, Curve picker, Export ›
  Video, Presenter window rows.
- `GAP-AUDIT.md`: §1.1 Timeline and Presentation rows → worked; §1.2 motion flows row; gaps #10, #13 updated, #16 added;
  backlog B-1 and B-7 → worked with pointers; pointer to the motion questions.
- `FLOWS.md`: section I, **F-73…F-81**; header pointer; coverage matrix rows.
- `ux/README.md`: the MOTION-TIMELINE row and the FLOWS row.
- `handoffs/CAPABILITY-COVERAGE.md`: the two motion rows → worked, milestones per PLAN.

## What a later pass should know
- **Nothing temporal is built.** Every control here is (c); FOUNDATIONS §5.6 means none of it renders before its V-item lands.
  The `Animate` HUD action and the Timeline lens declaration exist in `studio-contributions.ts` as VBDN placeholders; B11b
  should stop rendering them (STUDIO §13 says so).
- Milestones follow `PLAN.md` §2 (M3 / M4 / M5), not CAPABILITY-COVERAGE's "M2" (spec Q1).
- NAVIGATION-DEEPLINKS needs two rows when V-18 is briefed: `/s/:asset/presenter` and the `?present=<page>` intent key (Q12).
  `?format=video` on `/d/export` is already covered by the existing `format` key's "later" list.
- The brief said "export to video (tab in the Export dialog)"; the spec recommends a **`Video` chip in the Format row** of the
  one dialog (Q8) and explains why.
- Key decisions that depart from convention and need the owner's eye: no trim tools (modifiers + live labels), pages always
  ripple, explicit first keyframe, Smart move's visible matches, presets previewed on the real element, `Shift+←/→` = 1 s,
  the tray under Canvas / Pages, reduced motion never touches export, captions as text presets.
- Shortcut scope `timeline`: the keys were checked against STUDIO §7 by hand (§3.4 lists the check); `checkShortcuts` in CI
  is the real guard when they are registered.

## Owner questions
In the spec §18 (recommendation first), Q1–Q12.
