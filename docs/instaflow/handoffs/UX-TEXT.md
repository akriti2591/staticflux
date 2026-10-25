# UX-TEXT handoff — 2026-10-25
**Branch:** `claude/wip-ux-text`  ·  **State:** **done** (docs only; no PR; owner questions open in the spec §12)

## Files touched
- `docs/instaflow/ux/TEXT-FONTS-UX-SPEC.md` (new, Layer 2): §0 engine inventory and letters · §1 principles and
  market departures · §2 creating text (click/drag/fixed, overflow, text in and on shapes) · §3 editing (enter/leave,
  caret and selection, keyboard table, groups and repeats, mixed and typing style, undo coalescing, paste, spellcheck,
  IME/bidi/scripts/emoji) · §4 control table with HUD rank, tier per density, shortcut, letter; presets; per density ·
  §5 fonts (picker, weights, adding fonts, offline library, loading, missing fonts, fallback/subsetting/licensing) ·
  §6 fidelity · §7 actions (incl. assistant, OCR, variables) · §8 errors · §9 a11y · §10 plumbing · **§11.1 outlet +
  flow + follow-up for every feature, deferred included** (owner's standing rule) · §11.2 (c) schedule T-1…T-25 ·
  §12 owner questions Q1–Q10 · Appendix A checklist (Docs · Notion · Figma · Canva · InDesign · Pages; include/defer/
  reject) · Appendix B map of `CAPABILITY-COVERAGE.md` rows touching text.
- `STUDIO-UX-SPEC.md` §4.2.4 Text row, §4.2.6 font picker pointer, §5.1 Text section, §7 text shortcuts, §8.2 text rows.
- `DENSITY-DISCLOSURE.md` §3.2 Text row, §8.1 Text row, §8.3 Font picker + Missing fonts rows.
- `FLOWS.md`: section G, F-60…F-64; coverage matrix rows; header pointer; F-10 pointer.
- `GAP-AUDIT.md`: inventory row, gap #14, backlog B-14/B-15, pointer to the text questions. `ux/README.md` index row.

## Scope
The owner's flag "fonts/text: associated actions, fidelity and usability", plus the coordinator's addendum (text types and
presets, every inline and block format, a feature checklist against Docs · Notion · Figma · Canva · InDesign · Pages as
an appendix, and every row of `CAPABILITY-COVERAGE.md` that touches text).

## What a later pass should know
- The coordinator's two addenda are absorbed: the exhaustive basics (presets, every inline/block format, lists) are in
  §4.2 + Appendix A; the standing "outlet + flow for every feature" rule is §11.1 (one row per feature, M1–M3).
- Nothing in STUDIO §14 (settled owner decisions) was reopened; the pill's six for text are unchanged, with one chip added.
- B11b builds the (b) rows against today's `TypographyService`/`FontLibrary`; the M1 (c) items T-1…T-9 are small,
  editor-side or render fixes and should be scheduled before the text flows F-60/F-61 are run as acceptance tests.
- Appearance pass (next in the queue) owns: gradient text fill, text stroke UI, the colour popover's contrast tag.

## Decisions taken so far (see the spec's §1 and §12 for the reasoning)
- Letters as in OVERLAYS §2.3 Export: (a) engine today · (b) UI only, B11b · (c) engine or editor-worker work with a
  milestone; a (c) control is **not rendered** in M1 (FOUNDATIONS §5.6).
- Text styles in M1 are **presets that apply values** (Title, Heading 1–3, Subheading, Body, Caption, Quote, Code);
  **linked** styles (edit once, update everywhere) are M2 engine work (a `style` mark + document-level style doc).
- Fixed boxes **never clip silently**: overflow is drawn and marked; Fit to box is one click away.
- Undo while typing is **coalesced** per word / 1 s pause (today every keystroke is a step: a (c) editor-side fix, M1).
- No spellcheck squiggles in M1 (EditContext has no DOM text to check); `✦ Check spelling` is an M2 assistant action.
- No built-in OCR; `✦ Text from image` is an M2 assistant action when the provider has vision.
- Shortcuts while editing text shadow canvas ones the way `Mod+Shift+L/E/R` already do: `Mod+K` link, `Mod+,` / `Mod+.`
  sub/superscript, `Mod+\` clear formatting, `Mod+Shift+V` paste plain.

## Findings about the engine worth the coordinator's eye (all in the spec §11)
- Word jumps are `mod || alt` in `text-session.ts`: on Mac `⌘←` must be line start, `⌥←` the word (platform-aware motions).
- `verticalAlign` and `text.box = fixed` exist in the model but nothing lays out or projects them (TS follow-up).
- Lists exist in the model (`p.list`) but the layout spec carries no list markers; no nesting level in the model.
- `strike` exists end to end (model, layout, decorations) but the panel and HUD never expose it.
- HOME-FILES §3.1 accepts WOFF2 fonts; `fonts.ts` rejects WOFF (IF-TXT-006). One must change (recommend decompressing).
- CJK text is invisible without a CJK font (IME check finding 1): `.notdef` boxes and a "no font for these characters"
  state are required, not optional.
- Colour emoji draw as outline fallbacks (engine AGENTS.md) — M2.

## Owner questions
In the spec §12 (recommendation first).
