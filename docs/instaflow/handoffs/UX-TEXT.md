# UX-TEXT handoff — 2026-10-25
**Branch:** `claude/wip-ux-text`  ·  **State:** in progress (docs only; no PR)

## Scope
The owner's flag "fonts/text: associated actions, fidelity and usability", plus the coordinator's addendum (text types and
presets, every inline and block format, a feature checklist against Docs · Notion · Figma · Canva · InDesign · Pages as
an appendix, and every row of `CAPABILITY-COVERAGE.md` that touches text).

## Plan and status
1. `docs/instaflow/ux/TEXT-FONTS-UX-SPEC.md` (new, Layer 2) — **writing**.
2. STUDIO §4.2.4 text row, §4.2.6 font picker, §5.1 Text section, §7 text shortcuts, §8.2 text context rows → point to it.
3. DENSITY-DISCLOSURE §3.2 Text row and §8.1 Text row, §8.3 Font picker row → point to it.
4. FLOWS: F-60 text creation and boxes, F-61 mixed styles, F-62 missing font replacement, F-63 upload / local font,
   F-64 text fidelity to export; coverage matrix rows.
5. GAP-AUDIT: inventory row, gap row, backlog rows for (c) items; README index row.
6. Commit and push after each step.

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
