# Instaflow text and fonts — UX specification (Layer 2)

> Status: **normative** for everything marked (a) or (b); **planned** for (c). Written 2026-10-25 from the owner's flag
> ("fonts/text: associated actions, fidelity and usability") and the coordinator's addendum (text types and presets,
> every inline and block format, a checklist against the best tools as an appendix). Before this file, text had only
> STUDIO §4.2.4 (the pill row), §4.2.6 (the font picker), §5.1 (the Text section), §7 (five shortcuts) and FLOWS F-10.
> Those now point here. The engine is `apps/instaflow/src/text` + `engine/crates/authoring/src/text` (REQUIREMENTS §21,
> LIFECYCLES §22, D20); this file never redefines what the model or the layout do, it says what a person sees and does.
>
> **Letters** (the Export convention, OVERLAYS §2.3): **(a)** the engine does it today · **(b)** UI only, buildable in
> B11b over the existing services (`TypographyService`, `FontLibrary`, `TextSession`, the ops in `rich-text.ts`) ·
> **(c)** needs engine or editor-worker work (a new mark, a layout-spec field, the Wasm, the export writers, or the
> text session's keyboard and undo logic). FOUNDATIONS §5.6 applies: **a (c) control is not rendered in M1** — no
> greyed button, no "soon" tag; the row does not exist until §11 lands it. Every (c) has a milestone in §11.
>
> Conventions kept and why: Docs / Notion / Figma / Canva agree on `Mod+B/I/U`, double-click = word, triple-click =
> paragraph, `Mod+K` = link, Enter = new paragraph, Shift+Enter = line break, `Mod+Shift+V` = paste without formatting
> — forty years of muscle memory, kept exactly. Departures are marked **Departure** inline and gathered in §1.2.

## 0. Reading map and the engine today

### 0.1 What exists (so nobody re-specifies it)

| Piece | Today | Letter |
|---|---|---|
| Text element: `box` auto-width · auto-height · fixed, `align` start · center · end · justify, `verticalAlign` top · middle · bottom | model (`model.ts`); the Text tool makes auto-width on click, auto-height on drag (`placeTextOps`) | (a) model; **fixed box and vertical align are not laid out or projected yet** → (c) §11 |
| Character marks: bold, italic, underline, strike, link, size, weight, color, font, letterSpacing | model + layout + decorations; `TypographyService` exposes all but **strike has no UI** | (a) |
| Paragraph marks: align, list (none · bullet · number), lineHeight, spaceBefore, spaceAfter, first-line indent | model; align and lineHeight laid out; **list markers, spacing and indent are not in the layout spec** | (a) model; (c) layout |
| Mixed values (`MIXED`) across a range or a multi-selection | `summarizeTypography` | (a) |
| Fit to box (scale every run so the height fits) | `fitToBoxOps`, HUD action | (a) |
| Caret motions: grapheme, word, line start/end, text start/end, up/down with sticky column, Select All; grapheme-safe deletes | `text-session.ts`, Rust `move` | (a); **word vs line keys are not platform-aware** → (c) §11 |
| IME: compositions as previews, candidate window at the caret (owner check passed, D20) | `TextInput` port, EditContext / hidden textarea | (a) |
| Bidi, per-script fallback families, lazy complex-scripts build (Thai, Lao, Khmer, Myanmar) | Parley + ICU4X | (a) |
| Variable fonts (weight axis), synthetic bold and italic | layout + render | (a); other axes (c) |
| Fonts as sha-256 assets; uploads (.ttf .otf .ttc); Local Font Access flow with a state machine; brand font tokens | `fonts.ts` | (a); WOFF/WOFF2 rejected (c) |
| Glyphs from unhinted outlines, GPU = CPU golden; export: PNG renderer, PDF Type 3 + ToUnicode, SVG outlines labelled with text | render + export (D21) | (a); colour emoji, SVG `<text>`, `missingFonts` (c) |
| Accessibility data: text, paragraphs, lines, links, selection, role | `a11y.ts` | (a) |
| Each edit one undo step with a label (`Type`, `Delete text`, `Paste`, `New paragraph`) | `text-session.ts` | (a); **per-keystroke steps** → coalescing (c) §11 |

### 0.2 Reading rules

Implementers of the HUD and inspector read §4 (the control table is the normative part) and DENSITY-DISCLOSURE §3.2;
the Text tool and the session read §2–§3; the font picker, Assets › Fonts and the missing-font dialog read §5; export
and render read §6; capabilities read §7; errors §8. FLOWS F-10 and F-60…F-64 are the acceptance tests. Appendix A is
the exhaustive checklist (every control the six reference tools offer: include · defer · reject); Appendix B maps the
coordinator's capability rows that touch text.

## 1. Principles, market analysis and departures

### 1.1 Principles

1. **One text model, one pipeline.** What the caret moves through, what the HUD summarises, what the screen draws and
   what the PDF embeds are the same layout (ARCHITECTURE §5.2). No "preview font", no CSS stand-in anywhere.
2. **Text is an element first, a document second.** People come from Canva and Figma: a text box is a thing you move;
   editing is a mode you enter and leave. Docs-style comfort (word selection, paste plain, undo per word, lists) is
   kept *inside* that mode; Docs-style chrome (rulers, page margins, footnotes) is not.
3. **Never silently lose a glyph.** Missing font, missing glyph, overflow, unresolved token — each has a visible,
   calm marker and a one-click fix; nothing is clipped or dropped without saying so.
4. **Presets before properties.** A person picks *Heading 1*; the fields are there for the person who tunes it.
5. **The same six in the pill, everywhere** (STUDIO §4.2.1); density only reveals (DENSITY-DISCLOSURE §1).

### 1.2 Market analysis: where to match, where to be better

| Area | Leaders | Instaflow: the best version | Convention kept, why | **Departure, why better** |
|---|---|---|---|---|
| Creating | Figma: click = auto-width, drag = fixed; Canva: a text box of a preset | Click = auto-width; drag = auto-height at that width; a third mode, fixed, from the inspector or by dragging the bottom handle | Figma's two gestures (largest group of switchers) | Canva's **presets** (`Add a heading / subheading / body`) are here too, as the `Style ▾` row and the `T ▾` long-press menu, without Canva's side panel |
| Overflow | Figma: overflows visibly, no marker; Canva: box grows; InDesign: red plus, clips | Fixed box draws the overflow **and** marks it (`⤓` tag), Fit to box one click away; auto-height never overflows | InDesign's overflow mark (print people know it) | Nobody both shows and marks. Figma hides the problem; InDesign hides the text |
| Presets / styles | Docs: paragraph styles menu; Figma: text styles (linked); Canva: brand fonts | M1 presets apply values; M2 linked styles with a document style list and `Update style` | Docs' names (Title, Heading 1–3, …): what people call things | Presets live in the inspector's first row, not a dropdown in a toolbar; a preset sets size, weight, line height, spacing, case together so one click gives a finished heading |
| Mixed ranges | Figma: `Mixed` text; Docs: empty toolbar state | Every control has a designed mixed state (hatch, dash, indeterminate press), typing sets all, and the pill says `Mixed` in its own face | Figma's word | The **Weight ▾** menu lists which weights are in the range (`Bold · Regular`) instead of a blank |
| Fonts | Canva: huge cloud list; Figma: Google + local via agent; Docs: `More fonts` dialog | Offline-first: a curated library served from our origin and cached, your uploads, fonts on this computer (copied into the workspace), brand fonts; Google catalogue M2 | Google Fonts as the catalogue (what people search for) | A design opened on another machine **never** loses a font the person added: fonts travel with the workspace (IF-21.17). Local fonts list their faux weights honestly (`(synthetic)`) |
| Missing font | Figma: a yellow banner and a Replace dialog; Canva: silent substitution | A per-element hatched `Font` chip, a document-level `Missing fonts` dialog with Replace / Upload / Use from this computer, and the export result lists substitutions | Figma's Replace dialog | Auto-offer: when Local Font Access sees the same family on this computer the dialog's first row is `Add Fraunces from this computer` |
| Fidelity | Figma: screen ≠ PDF text in places; Canva: fonts outlined in PDF | One layout, one glyph source; PDF has real selectable text (ToUnicode); SVG outlines carry the text | — | Fit is checked by a metric (D21), not by eye |
| Editing comfort | Docs/Notion: word undo, triple-click, `/` menus; Figma: per-keystroke undo | Undo per word, triple-click paragraph, `Mod+Shift+V` plain paste, markdown-ish prefixes (`- `, `1. `, `# `) in M2 | Docs' selection gestures | A design tool with Docs' undo granularity is rare |
| Spelling | Docs: squiggles; Figma: none; Canva: none | None in M1 (no DOM text under EditContext to spellcheck); `✦ Check spelling` M2 | — | Honest: no half-working squiggles |
| Rotated text | Figma: edits in place; Canva: de-rotates to edit | Edit in place; the caret and selection rotate with the element | Figma | Tiny text zooms in to be editable (≥ 12 px on screen) — nobody does this; it removes the "I can't see what I'm typing" moment |

## 2. Creating text

### 2.1 The Text tool (`T`)

| Gesture | Result | Letter |
|---|---|---|
| Click on the page, a frame or the mist | An **auto-width** text element at the click (top-left at the pointer, baseline of the first line 1 em below), in edit mode with a blinking caret and the placeholder `Type something` in mist ink (never committed); the pill appears above (§4.1). Parent = what was under the pointer (STUDIO §1). | (a) |
| Drag | A marquee with a `W` pill; on release an **auto-height** element of that width (height grows with the text), in edit mode. Dragging under 24 px wide counts as a click. | (a) |
| Click on existing text with the Text tool | Edits that text at the clicked caret (does not create a new one). Cursor `text`; over empty canvas `text` with a `+` badge (STUDIO §6.2). | (b) |
| Long-press the tool (400 ms) or `Shift+T` | A **presets menu** on the tool: `Title · Heading · Subheading · Body · Caption · Quote · Code` (§4.3). Choosing one arms the tool; the next click creates text with that preset applied. **Departure** (Canva puts these in a side panel): a menu on the tool keeps the canvas in view. | (b) |
| Double-click the tool | Sticky (F-03 step 5). | (a) |
| Paste text with nothing in edit mode | A new auto-width element at the viewport centre, document text defaults (STUDIO §8.1). Pasting > 400 characters makes an **auto-height** box of 60 % of the viewport width instead (a 2 000-character line is useless). | (b) |
| Enter with the tool armed (keyboard path) | Creates at the viewport centre (F-01 step 5). | (a) |
| Leave an element **empty** | It is removed on exit; undo has no extra step (F-10 step 7). | (a) |

Defaults for new text: the document's **default text style** (Document section › `Text defaults`: font, size, colour,
line height; initialised from the template or `Geist 20 px, ink, 1.3`). The presets menu overrides them. The first text
element created on a device shows the one-line hint `Click to start typing, or drag for a fixed width.` once (STUDIO
§4.1).

### 2.2 Box modes and how they change

| Mode | Width | Height | How it is set | How it shows |
|---|---|---|---|---|
| **Auto width** | follows the longest line | follows the lines | click to create; inspector `Auto-size ▾ Auto width`; or double-click a side handle | The pill's `W` field is muted (read-only mono); the frame has handles only at the corners' middles for move, side handles show `⇆` on hover and **convert** to auto-height when dragged (Figma) |
| **Auto height** | fixed | follows the text | drag to create; drag a side handle; `Auto-size ▾ Auto height` | Side handles active, bottom handle muted; the element never overflows |
| **Fixed** | fixed | fixed | drag the **bottom** or a corner handle; `Auto-size ▾ Fixed`; a preset frame | All handles; the overflow marker (§2.3) when the text does not fit; **vertical alignment** applies only here (top · middle · bottom) |

Corner handles on auto modes **scale the font size** (Figma, Canva): the size pill shows `48 → 64` while dragging, one
undo step `Resize text`. `Shift` keeps ratio as for shapes. Switching to a smaller mode never deletes text. (b) for the
handle behaviours over the existing resize gesture; (c) for fixed-height layout and vertical alignment (§11).

### 2.3 Overflow

A fixed box whose text does not fit **draws the overflow** (the text continues below the box, clipped only by the frame
that contains the element, never by its own bounds) and shows an **overflow tag**: a 16 px mist pill with `⤓` and the
hidden line count at the box's bottom-right outside corner (`⤓ 2`), visible while selected or hovered, tooltip
`2 lines don't fit · Fit to box` (click runs Fit to box). **Departure:** Figma overflows without saying, InDesign hides
the overflow behind a red plus; showing both is the honest version. Pro adds `Truncate ▾` (`Off · Ellipsis…`) in the
Text section's More row — (c) M2, a layout option; not rendered before. Export draws exactly what the canvas draws.

### 2.4 Text with and in shapes

| Need | M1 | Later |
|---|---|---|
| **Text inside a shape** (a button, a label on a badge) | Double-click a shape that has no text child → a centred auto-height text element is created at 80 % of the shape's width, **grouped** with the shape, in edit mode (one undo step `Add text`). Moving the group moves both; `Align ▾` keeps them centred. **Departure** (Figma: nothing; Canva: shapes have built-in text): we give the gesture without a special element kind. (b) | True shape-bound text (padding, auto-size the shape to the text) is a Frame with layout — **M2 (c)**, with the Frame layout work |
| **Text on a path** (an arc of text round a badge) | Not rendered. | **M2 (c):** `Text › Follow path…` picks a path or ellipse; glyph placement along the path in the authoring crate (Parley gives clusters with advances; the crate positions them along `kurbo` arc length), editing stays linear. Canva's `Curve` slider is the M2 UI (one slider for arcs), `Follow path` the general case |
| **Warp / arch** (Canva Effects) | Not rendered. | M2 with text on a path |

## 3. Editing

### 3.1 Entering and leaving

| Action | Result | Letter |
|---|---|---|
| Double-click a text element (Select tool) | Edit mode, caret at the click. Double-click a text **inside a group** edits it directly (Figma drills through; Canva too). | (b) |
| Enter with a text element selected | Edit mode, caret at the end; `Shift+Enter` selects all its text. | (b) |
| Text tool click on text | Edit at the caret (§2.1). | (b) |
| Start typing with a text element selected | Nothing (letters are tools). Figma does the same; Canva starts editing. Kept: tool keys matter more. | — |
| `Escape` | Leaves edit mode and keeps the element **selected** (the Escape ladder, STUDIO §9). An open composition is committed first. | (a) |
| `Mod+Enter` | Commits and selects (same as Escape; muscle memory from forms). | (a) |
| Click outside | Commits; selection follows the click. Clicking the pill or inspector does **not** leave edit mode. | (a) |
| `Tab` | **Inside a list item:** indents one level; `Shift+Tab` outdents. **Elsewhere:** inserts nothing and does **not** leave editing (today it exits — an easy way to lose the caret; Docs inserts a tab, Figma inserts a tab). **Departure:** we neither exit nor insert a tab character (no tab stops exist). Owner question Q1. | (c) |
| Exit while the element is empty | Removed (§2.1). | (a) |
| Exit while an IME composition is open | The composition commits, then exit. | (a) |
| Remote edit or undo while editing | The session refreshes and keeps the selection in range (IF-21.24). | (a) |

Edit mode visuals: no transform handles; a 1 px tangerine outline (`#FF5C39`) on the box; the pill stays above the
element and acts on the caret's range (STUDIO §4.2.2); Layers highlights the row; the inspector header shows the
element name with the tag `Editing`.

### 3.2 Caret, selection and the mouse

| Gesture | Result | Letter |
|---|---|---|
| Click | Caret at the nearest grapheme boundary (hit test with affinity; a click in the right half of a glyph goes after it). | (a) |
| Drag | Extends the selection by grapheme; dragging above the first line selects to the start, below the last to the end. | (b) |
| Double-click | Selects the **word** (UAX #29 word from the layout's `wordAt`), not its trailing space (Docs; Figma includes punctuation differently — we follow the layout). Double-click-drag extends by word. | (b) |
| Triple-click | Selects the **paragraph**. Quadruple: all (Docs). | (b) |
| Shift+click | Extends from the anchor. | (b) |
| Alt+drag (Mac) / Ctrl+drag | No column selection (rejected: a design tool has no tables). | — |
| Right-click in text | Context menu for text editing (§7.4). | (b) |
| Drag a selection to move it | Not in M1 (Docs has it; Figma does not). Defer M3. | — |

Drawing: the **caret** is a 1.5 px ink bar of the line's height (ascent + descent at the caret's run), drawn in the
canvas HUD layer (OVERLAYS §1 layer 1), transformed with the element (a rotated text has a rotated caret), **never
thinner than 1 screen px**; it blinks 530 ms on / 530 ms off, restarts on every move, and does not blink under
`prefers-reduced-motion`. The **selection** is tangerine at 24 % alpha, one rect per line from `selectionRects`
(bidi-aware: an RTL run inside LTR text gives two rects), with 2 px corners, transformed with the element. The
composition (IME) shows an underline 1 px below the baseline in ink (IF-21.23). The HUD and inspector reflect the caret's
run or the range's common style within the same frame. (a) data, (b) drawing.

### 3.3 Keyboard

Registered in the shortcut registry under the **Text** group (STUDIO §7, §2.3.1); active only while editing. `Mod` = ⌘ /
Ctrl. Where a key **shadows** a canvas shortcut while editing, the table says so; the canvas one returns on exit.

| Action | Mac | Windows | Letter / note |
|---|---|---|---|
| Move by character / line | ← → ↑ ↓ | same | (a) |
| Move by word | ⌥← / ⌥→ | Ctrl+← / Ctrl+→ | **(c)** today `mod || alt` both jump by word; on Mac `⌘←` must be line start |
| Line start / end | ⌘← / ⌘→, also Home / End | Home / End | (c) same fix |
| Text start / end | ⌘↑ / ⌘↓ | Ctrl+Home / Ctrl+End | (a) |
| Extend any motion | + Shift | + Shift | (a) |
| Select all text | ⌘A | Ctrl+A | (a); a second ⌘A selects the element (leaves editing) — Figma |
| Select word / paragraph | double / triple click | same | (b) |
| Delete back / forward | ⌫ / ⌦ | Backspace / Delete | (a) grapheme-safe |
| Delete word | ⌥⌫ / ⌥⌦ | Ctrl+Backspace / Ctrl+Delete | (a) |
| Delete to line start | ⌘⌫ | — | (a) |
| New paragraph | Enter | same | (a) copies the paragraph style |
| Line break (same paragraph) | ⇧Enter | same | **(c)** the model has one break kind; needs a soft break (U+2028) in layout |
| Bold / Italic / Underline | ⌘B / ⌘I / ⌘U | Ctrl+B/I/U | (a) |
| Strikethrough | ⌘⇧X | Ctrl+Shift+X | (a) model; (b) UI. Notion and Figma use this key |
| Subscript / Superscript | ⌘, / ⌘. | Ctrl+, / Ctrl+. | **(c)** §11; shadows Settings and the density cycle **while editing only** (Docs' keys) |
| Link | ⌘K | Ctrl+K | (a) `setLink`; (b) popover. **Shadows the command palette while editing** (Docs, Notion, Figma all use ⌘K for link) |
| Clear formatting | ⌘\ | Ctrl+\ | (b) over `setCharStyleOps`; shadows toggle dock while editing (Docs) |
| Align left / centre / right / justify | ⌘⇧L / ⌘⇧E / ⌘⇧R / ⌘⇧J | Ctrl+Shift+L/E/R/J | (a); shadow Lock/Rename (STUDIO §7) |
| Bulleted / numbered / checklist | ⌘⇧8 / ⌘⇧7 / ⌘⇧9 | Ctrl+Shift+8/7/9 | (c) rendering; Docs' keys |
| Indent / outdent (list level or block indent) | Tab / ⇧Tab in a list; ⌘] / ⌘[ | Tab / Shift+Tab; Ctrl+] / Ctrl+[ | (c); ⌘] shadows Bring forward while editing (Docs) |
| Size up / down (1 px; ⌥ 0.5 px; ⇧ 10 px) | ⌘⇧> / ⌘⇧< | Ctrl+Shift+> / < | (a) |
| Line height up / down | ⌥⇧↑ / ⌥⇧↓ | Alt+Shift+↑/↓ | (a) `setLineHeight`; Figma's keys |
| Letter spacing up / down | ⌥> / ⌥< | Alt+> / Alt+< | (a); Figma's keys |
| Paste / paste without formatting | ⌘V / ⌘⇧V | Ctrl+V / Ctrl+Shift+V | (a) plain; (b) HTML paste; ⌘⇧V shadows Paste in place while editing (Docs) |
| Copy / cut selection | ⌘C / ⌘X | Ctrl+C / Ctrl+X | (b) writes `text/plain` + `text/html` |
| Undo / redo | ⌘Z / ⌘⇧Z | Ctrl+Z / Ctrl+Y | (a); granularity §3.6 |
| Emoji picker (OS) | ⌃⌘Space | Win+. | the OS does it through EditContext; the cheat sheet lists it |
| Commit / exit | ⌘Enter / Esc | Ctrl+Enter / Esc | (a) |

Letter tool keys never fire while editing (registry origin check). Everything here appears in the cheat sheet's **Text**
card and in each control's tooltip.

### 3.4 Editing inside groups, frames and repeats

| Context | Behaviour | Letter |
|---|---|---|
| Group / frame | Double-click drills to the text and edits; Escape leaves editing and selects the **text** (one more Escape selects the group — the ladder). | (b) |
| Repeat source | Editing the source's text updates every instance live. The pill shows the repeat chip (`Radial · 8`) left of the text controls. | (a) |
| Repeat instance clicked | Selects the source (STUDIO §4.2.4); double-click edits the **source** text, with a 1.5 s mist toast `Editing the source · all 8 copies change`, once per session. Per-instance text overrides are M2 (with instance overrides generally). | (b) |
| Locked | No editing; the pill shows `Locked · Unlock`. Double-click shows nothing (never a disabled caret). | (a) |
| Milestone preview | Read-only; selection for Copy works, caret never appears. | (b) |
| Another actor editing the same text (M2 agents, later people) | Their selection is drawn in their presence colour with a name tag; both edits converge (TXT-4). | (a) data; M2 UI |

### 3.5 Mixed styles and the typing style

- A **range** with more than one value for a property shows **Mixed** (STUDIO §5.3): number fields show the placeholder
  `Mixed`; `Font ▾` reads `Mixed` in Geist, not in a face; `Weight ▾` reads `Mixed` and its menu ticks **every** weight
  present (`✓ Bold · ✓ Regular`); the colour swatch is hatched; `B I U S` toggles are **indeterminate** (a 2 px dash
  instead of a pressed fill, `aria-pressed="mixed"`); `Align ▾` shows the mixed glyph when paragraphs differ.
- Acting on a mixed range **sets all** (typing a size, picking a font). A mixed toggle press turns the property **on**
  for the whole range (Docs); a second press turns it off.
- A **collapsed caret** reads the run before it (`summarizeTypography`); pressing `B` with a collapsed caret sets the
  **typing style** (`setTypingStyle`), shown pressed in the pill, applied to the next characters, cleared when the caret
  moves (IF-21.22). Marks extend when typing at their end (`TEXT_MARK_EXPAND`), links do not — typing after a link is
  plain text (Docs behaviour, deliberate: nobody wants a link to grow).
- Multi-selection of text **elements** (not editing): the pill shows `Font ▾ · Size` when every element has them
  (STUDIO §4.2.4); the inspector Text section shows Mixed per field and edits all. The summary spans every run of every
  selected element.
- A style change on a range is **one undo step** named by the control (`Bold`, `Font`, `Size`); on a multi-selection,
  one step for all elements.

### 3.6 Undo granularity while typing

Today every keystroke is a step (`LABELS.type`). The rule: consecutive **typing** in one element coalesces into one step
until a pause of **1 s**, a word boundary followed by more typing after a pause, a paragraph break, a style change, a
paste, a caret move by mouse or by arrow, or a different element. Deletes coalesce the same way, separately from
typing. Paste, Enter, style toggles, Fit to box and presets are always their own step. Undo while editing keeps edit
mode and places the caret at the end of the undone range; undo after leaving edit mode selects the element. The label is
`Type` / `Delete text` and in Pro the top bar reads `Undo: Type "Hello wor"` (first 16 chars). **(c)** editor-side
(`text-session.ts` commit policy), M1 follow-up; Docs and Pages behave this way and people notice when a tool does not.

### 3.7 Paste and copy

| Case | Behaviour | Letter |
|---|---|---|
| Paste plain text | Inserted at the caret with the **typing style / caret's style**; line breaks become paragraphs. | (a) |
| Paste HTML (from Docs, a web page, Notion) | Bold, italic, underline, strike, links, paragraphs and list items kept; **fonts, sizes and colours dropped** (the text takes the caret's style). Canva does this; Figma keeps sizes and makes a mess. | (b) over `replaceTextOps` + `setCharMarkOps`; lists (c) |
| `Mod+Shift+V` | Plain text only. | (b) |
| Paste an image while editing | Leaves edit mode and places the image (STUDIO §8.1); never inline images in text (not a word processor). | (b) |
| Paste a URL over a selection | The selection becomes a **link** to it (Docs, Notion); over a collapsed caret the URL is inserted as text and linked. | (b) |
| Copy a range | `text/plain` and `text/html` (bold/italic/underline/strike/link as semantic tags, paragraphs as `<p>`). | (b) |
| Copy with nothing in edit mode | STUDIO §8.1 (the element). `Copy as text` in the context menu copies the plain text of the selected elements, joined by blank lines, in Layers order. | (b) |
| Drag a `.txt` file onto the canvas | Import rule (HOME-FILES §3.1): not supported, toast. Pasting its content is. | — |

### 3.8 Spellcheck

**M1: none.** EditContext has no DOM text for the browser to check, so squiggles would need a dictionary in a worker
(≈ 1–2 MB per language). Nothing pretends: no `Spelling` switch is rendered. **M2:** `✦ Check spelling` is an
assistant action (§7.2) when a provider is configured: it lists suggestions as a proposal (Accept per word or all),
never auto-corrects. A local dictionary is backlog (Appendix A row). Owner question Q2.

### 3.9 IME, RTL, bidi and scripts

- **IME** (D20, TXT-10): compositions are underlined previews; the candidate window follows the caret across wraps, after
  RTL runs and under browser zoom. The IME check page (`pnpm ime-check`) is rerun after any change to text input. The
  known cosmetic finding (control bounds growing per key intent) is a bug to fix (§11), not a UX rule.
- **Direction** is per paragraph from its first strong character (ICU4X bidi); `start` / `end` alignment follows it, so an
  Arabic paragraph aligns right by default with no setting. Pro's Text More row offers `Direction ▾ Auto · LTR · RTL`
  — (c) M2 (a paragraph mark). The caret moves **visually** (← is always leftward) with logical affinity at run
  boundaries (IF-21.10), the Chrome convention.
- **Unsupported script / no font for these characters:** when a cluster has no glyph in the run's font or its
  fallbacks, the layout emits `.notdef` and the renderer **draws a tofu box** (today nothing is drawn — IME check
  finding 1; (c) M1 follow-up). The element shows an inline marker as for overflow (`▯ 12`), tooltip `12 characters
  have no font · Add a font ▾` opening the `+ Add fonts` menu (§5.3) pre-filtered to the script when the library has
  one (`Noto Sans JP`). Never a modal.
- **Complex scripts** (Thai, Lao, Khmer, Myanmar) load the complex chunk once; while it loads (≤ 1 s) the text is laid
  out with the base build and relaid; no spinner.
- **Emoji** come from the OS picker; the layout flags them (`EMOJI` cluster flag) and deletes them whole. Colour glyphs
  (COLR/CBDT) render **monochrome outlines** today; colour emoji on screen and in export is (c) M2 (T-19). Until then
  the library carries one monochrome emoji face (`Noto Emoji`) as the `Zsye` fallback so emoji are never tofu, and
  nothing in the UI mentions it (FOUNDATIONS §5.6 forbids "for now" copy).

## 4. Typography controls and where they live

### 4.1 The pill (HUD) for text

The six, in rank order (STUDIO §4.2.4, unchanged): **`Font ▾` · `Size` · Colour swatch · `B` · `Align ▾` · Delete**; in
M2 `✦ Rewrite` takes slot 6 and Delete moves to More. While editing, every item acts on the caret's range (§3.5). The
leading mono chip shows the **preset name** when the range is exactly a preset (`Heading 1`) — the one addition to
the row, as a chip not a control, so the six stay. `Size` is a 64 px scrubbable number with `px`. `B` is the toggle;
`I`, `U`, `S` live in More with their keys. `⋯` More for text: Fit to box · Italic · Underline · Strikethrough ·
Line height · Letter spacing · Vertical align · Auto-size ▾ · Style ▾ · List ▾ · Link… · Convert case ▾ · Clear
formatting · Copy as text · Rotate 90° · Flip · Duplicate · Repeat… · Convert to outlines (M2) · Describe.

### 4.2 The control table (normative)

Every row is one declared control (`src/spec/controls.ts`, STUDIO §4.2.1) with its section, **tier** (DENSITY-DISCLOSURE
§3.2: *essential* shows at rest in Standard, *more* folds behind `More ▾`, *pro* renders only in Pro) and letter.
Section **Text** comes after Transform; **Paragraph** is a sub-block of Text (one heading, a hairline between).

| Control | Kind | HUD rank | Section · tier | Shortcut | Behaviour and notes | Letter |
|---|---|---|---|---|---|---|
| Style (preset) | menu | chip only | Text · essential (first row) | — | `Style ▾` shows the matching preset name or `Custom`; menu = §4.3 list, each row in its own look; `Update style…` and `New style…` rows in M2 | (b) M1 presets; (c) M2 linked |
| Font family | font | 1 | Text · essential | — | The font picker (§5.1); shows the family in its face | (a) |
| Weight / style | menu | — | Text · essential (beside Font) | — | `Weight ▾` lists the family's real faces (`Light · Regular · Medium · Bold · Bold Italic`); weights the family lacks appear below a hairline tagged `synthetic` in mono (the engine fakes bold/italic — say so; Figma does not). `Italic` here is the face; the `I` toggle picks the italic face when one exists, else synthetic | (a) |
| Size | number | 2 | Text · essential | ⌘⇧> / < | 1–999 px, 0.5 steps with ⌥; scrub; expressions; presets `12 14 16 18 20 24 32 40 48 64 96` in a `▾` beside the field | (a) |
| Colour | swatch | 3 | Text · essential | — | The colour popover; document colours, brand tokens (`@ink`), hatched when unresolved (IF-TXT-009) | (a) |
| Bold | toggle | 4 | Text · essential (`B I U S` row) | ⌘B | Pressed = weight ≥ 600 (summary rule) | (a) |
| Italic | toggle | More | Text · essential | ⌘I | | (a) |
| Underline | toggle | More | Text · essential | ⌘U | | (a) |
| Strikethrough | toggle | More | Text · essential | ⌘⇧X | Exists in model and layout; **UI missing today** | (a) engine, (b) UI |
| Superscript / Subscript | toggle pair | — | Text · more | ⌘. / ⌘, | Mutually exclusive; size × 0.65 and a baseline shift of ±0.35 em | (c) M1 follow-up |
| Highlight (text background) | swatch | — | Text · more | — | A rect per run behind the glyphs, 2 px padding; `None` default | (c) M2 |
| Link | action | More | Text · essential (`🔗` icon in the `B I U S` row) | ⌘K | A popover: URL field (http(s), mailto, `#page-id` via a `Page ▾` menu for internal links), `Open`, `Remove`; linked text is underlined in the link colour `#3D5AFE`; hovering a link while **not** editing shows a tooltip with the URL and `⌘-click` opens it | (a) `setLink`; (b) popover |
| Inline code | toggle | — | Text · more | ⌘E | Mono font + highlight; a composite of Font + Highlight | (c) M2 (needs Highlight) |
| Case | menu | More | Text · more | — | `Case ▾ As typed · UPPER · lower · Title · Sentence`: **M1 = Convert case** (rewrites the text, one undo step, marks kept per cluster); **M2 = a non-destructive `case` mark** (display transform, the text stays as typed) | (b) convert; (c) M2 transform |
| Small caps | toggle | — | Text · pro | — | OpenType `smcp` when the font has it; else synthetic (UPPER at 0.8 ×) marked `synthetic` | (c) M2 |
| Letter spacing | number | More | Text · more | ⌥> / < | px, −20…200, 0.1 steps with ⌥; `%` of size in Pro | (a) |
| Line height | number | More | Text · more | ⌥⇧↑ / ↓ | A multiple (`1.2`) in Standard; Pro adds a unit menu `× · px · %`; `Auto` = font metrics (0) | (a) multiple; (c) px unit |
| Paragraph spacing before / after | number pair | — | Paragraph · more | — | px; `Before` and `After` on one row | (a) model; (c) layout |
| First-line indent | number | — | Paragraph · more | — | px | (a) model; (c) layout |
| Indent (block) | number | — | Paragraph · more | ⌘] / ⌘[ | Left indent in px, steps of 24; also the list level | (c) M2 |
| Alignment (horizontal) | menu | 5 | Paragraph · essential (`Align row`) | ⌘⇧L/E/R/J | Four icon toggles `⟵ ≡ ⟶ ☰` (start · centre · end · justify); the pill's `Align ▾` opens the alignment popover whose top row is these four and whose grid aligns the **element** (STUDIO §4.2.7) — one popover, two rows, labelled `Text` and `Box` | (a) |
| Vertical alignment | switcher | More | Paragraph · more | — | `Top · Middle · Bottom`; **rendered only for fixed boxes** (gating) | (c) M1 follow-up |
| List | menu | More | Paragraph · essential (in the Align row) | ⌘⇧8/7/9 | `List ▾ None · • Bullet · 1. Number · ☐ Checklist`; nested levels via Tab; markers follow the paragraph's first run's size and colour; numbering restarts after a non-list paragraph; checklist boxes toggle on click when **not** editing | (a) model bullet/number; (c) markers, checklist, levels |
| Auto-size | switcher | More | Text · more | — | `Auto width · Auto height · Fixed` with the three custom icons (STUDIO §10.2) | (a) two modes; (c) fixed |
| Truncate | menu | — | Text · pro | — | `Off · Ellipsis` for fixed boxes | (c) M2 |
| Direction | menu | — | Paragraph · pro | — | `Auto · LTR · RTL` | (c) M2 |
| Hyphenation | toggle | — | Paragraph · pro | — | | (c) M2 |
| OpenType features | row of toggles | — | Text · pro | — | Ligatures (`liga`, default on) · Discretionary (`dlig`) · Kerning (`kern`, default on) · Figures `Lining / Oldstyle` · `Tabular / Proportional` · Fractions · Stylistic sets `ss01…` as chips, each rendered only when the font has the feature | (c) M2 |
| Variable axes | sliders | — | Text · pro | — | One slider per axis the font exposes besides `wght` (`wdth`, `opsz`, `slnt`, custom), value in a mono pill; `wght` stays the Weight menu plus a slider in Pro | (a) wght; (c) other axes M2 |
| Baseline offset | number | — | Text · pro | — | px, for manual super/subscripts | (c) M2 |
| Text stroke | stack | — | Stroke ▸ | — | The Stroke section exists for text; glyph outlines stroked | (c) M2 (render strokes glyph paths) |
| Effects (shadow, glow, blur) | stack | — | Effects ▸ | — | On the text group, as for shapes | (a) |
| Fit to box | action | More | Text · essential (ghost button under the Auto-size row) | — | Scales every run so the height fits (IF-21.28); on an auto box it is not rendered | (a) |
| Drop cap | toggle + number | — | Paragraph · pro | — | `Drop cap · 3 lines` | (c) M2 (decided: M2, Appendix A) |
| Columns | number | — | — | — | **Rejected** inside one element (Appendix A); threaded boxes M3 | — |
| Convert to outlines | action | More | — (action) | — | §7.1 | (c) M2 |

### 4.3 Text styles and presets

**M1 presets** (`Style ▾`, the tool's long-press menu, the palette `Text style: Heading 1`): a preset is a bundle of
values applied to the paragraph(s) in the range (or the whole element with a collapsed caret / no edit mode). Applying
one is one undo step `Heading 1`. The document's **default font** is used; the preset sets the rest.

| Preset | Size | Weight | Line height | Space after | Extras |
|---|---|---|---|---|---|
| Title | 64 | 800 | 1.05 | 16 | letter spacing −1 |
| Heading 1 | 48 | 700 | 1.1 | 12 | |
| Heading 2 | 32 | 700 | 1.15 | 10 | |
| Heading 3 | 24 | 600 | 1.2 | 8 | |
| Subheading | 20 | 500 | 1.3 | 8 | colour muted (`#56606C`) |
| Body | 18 | 400 | 1.4 | 8 | |
| Caption | 13 | 400 | 1.3 | 4 | colour muted |
| Quote | 24 | 400 italic | 1.3 | 12 | first-line indent 0, block indent 24 (M2), a leading `“` is not added |
| Code | 16 | 400 | 1.5 | 8 | font `Geist Mono` (from the library), highlight mist (M2) |

Sizes scale with the page: on a page narrower than 800 px the table is multiplied by 0.75 (a Story is not a poster).
The `Style ▾` row reads the preset name when every value matches, otherwise `Custom` (never `Heading 1*`: people read
the asterisk as an error). **M2 linked styles (c):** a document-level style list (`D14`'s shared-styles doc) referenced
by a `style` mark; editing a style updates every use; `Update style from selection`, `Detach`; brand kits ship type
tokens (`@display`, `@body`) as styles — the Brand panel (GAP-AUDIT B-4) lists them.

**Brand type tokens** (IF-21.18) resolve today for the font (`@display`); the font picker shows them under **Brand**
with a mono tag; an unresolved token hatches the `Font ▾` chip with `Replace with Fraunces` (STUDIO §5.4 rule).

### 4.4 Per density

| | Focus | Standard | Pro |
|---|---|---|---|
| Pill | the six (§4.1) | same | same, units on `Size`, second tooltip line |
| Inspector Text at rest | rail icon `Text`; a click opens the Text section as a floating card with the Standard layout | `Style ▾` · `Font ▾` · `Weight ▾` · `Size` · Colour · `B I U S 🔗` · Align row (`⟵ ≡ ⟶ ☰` · `List ▾`) · `More ▾` | everything open: all of Standard, then Letter spacing · Line height (with unit) · Paragraph spacing · Indents · Vertical align · Auto-size · Truncate · Case · Direction · Hyphenation · OpenType row · Axes · Baseline, in one scrolling section, mono values |
| Behind `More ▾` (Standard) | — | Line height · Letter spacing · Paragraph spacing · Vertical align (fixed only) · Auto-size · Case ▾ · Sub/superscript · Fit to box; count tag `More ▾ · 2` when non-default | no `More` |
| Font picker | identical in every mode | | Pro: the row shows the face count and source as mono (`6 styles · local`) |

## 5. Fonts

### 5.1 The font picker

264 × 420 px popover (STUDIO §4.2.6, extended), anchored to `Font ▾` in the pill or the inspector; one instance.

| Part | Contents | Behaviour |
|---|---|---|
| Filter field | `Search fonts`, focused on open; type-to-filter from the first key | Matches family names and category words (`serif`, `mono`, `hand`); `Enter` commits the top row |
| Category chips | `All · Sans · Serif · Display · Mono · Hand` (28 px chips, scrollable) | Categories come from a curated table for library fonts and from `OS/2` panose / name heuristics for uploads; unknown = `All` only |
| Rows (36 px, virtualised) | the family **in its own face** at 18 px (`Fraunces`), the name in Geist 12 px muted when the face cannot show it (symbol, CJK-only), a right-side mono tag: `@display` (brand), `6 styles`, source glyph (laptop = this computer, upload arrow, library) | Hover 150 ms **previews** on the selection (the element re-lays out; the caret stays); click commits one undo step `Font`; Escape restores and closes |
| Groups, in order | **Recent** (last 8 on this device) · **In this design** · **Brand** (when a kit exists) · **Your fonts** (uploaded and copied local fonts) · **Library** (curated, §5.4) · **On this computer** (only when Local Font Access is granted: families not yet copied, muted, with the laptop glyph; choosing one copies it first, §5.3) | Group headings are sticky; empty groups are not rendered |
| Not-yet-cached library font | A muted download glyph on the row; hover shows the name only (no preview until cached); click downloads (≤ 300 ms typical) then commits; offline: the row is muted with tooltip `Needs a connection` (banner rule OVERLAYS §3.3) | |
| Footer | `+ Add fonts ▾`: `Upload font file…` · `Use fonts on this computer…` (gated on the LFA fact) · `Browse Google Fonts…` (M2) | |

Keyboard: ↑ ↓ move (previewing), Enter commits, Escape restores, `Tab` to the chips and footer. Multi-selection of text
elements: the picker edits all; `Mixed` shows no row ticked. A11y: `role=listbox` named `Font`, rows `option` with the
family name and the tag as description; previews are announced as `Previewing Fraunces`.

### 5.2 Weight and style

`Weight ▾` lists the family's faces by name (`Light 300 · Regular 400 · Medium 500 · Bold 700 · Black 900`, italics as
`Bold Italic`), ticks the current, and under a hairline lists **synthetic** weights (`Bold · synthetic`) the engine
can fake (IF-21.15). Variable fonts list named instances and, in Pro, a `wght` slider under the list. Choosing a
synthetic weight is allowed (people need bold on a font that has none) and the row says so; export renders the same
synthetic stroke (one pipeline). **Departure** from Figma, which fakes silently.

### 5.3 Adding fonts

| Way | Flow | Letter |
|---|---|---|
| **Upload a file** (`.ttf` `.otf` `.ttc`; `.woff2` after §11) | Picker footer, Assets › `Import`, drop on the canvas or Home (HOME-FILES §3.1). Validation IF-TXT-006 with the toast `'brand.woff' isn't a font Instaflow can use · Use .ttf, .otf or .ttc`. A `.ttc` adds every face. Duplicates (same hash) toast `Already in your fonts` and select it. Result: the font appears under **Your fonts**, and when a text element is selected the picker opens filtered to it (HOME-FILES §3.1). One toast `Added Fraunces · 6 styles`. | (a) store; (b) UI; (c) WOFF2 |
| **Use fonts on this computer** (Local Font Access, Chrome) | Footer row → Chrome's permission prompt (the request runs in the click, IF-TXT-007) → the dialog **Fonts on this computer**: search field, a virtualised list of families in their faces with face counts, checkboxes, `Add 3 fonts` primary. Adding **copies** the files into the workspace (IF-21.17) with a progress row for > 10 fonts; a one-time notice line in the dialog: `Fonts you add are saved with your designs so they open on any device. Check a font's licence before sharing design files.` (owner question Q4). Denied: an inline row in the picker `Chrome blocked access to your fonts · Allow in site settings · Upload a file instead`. Unavailable (Firefox): the footer row is not rendered. Revoked later: the **On this computer** group disappears; copied fonts stay. | (a) machine and copy; (b) dialog |
| **Browse Google Fonts** (M2) | A dialog with the catalogue index (cached), category chips, preview text field, `Add` per family; added fonts download into the blob store and join **Your fonts**. Licence: Google Fonts are OFL/Apache — embedding in exports is permitted, the dialog says so in one line. Offline: the row is muted with `Needs a connection`. | (c) M2 |
| **A design that references a font this device lacks** | §5.6 | |

### 5.4 The library (offline-first)

M1 ships a **curated library** of ≈ 24 OFL families (sans, serif, display, mono, handwriting; plus `Noto Sans Arabic`,
`Noto Sans Devanagari`, `Noto Sans Thai` already used as fallbacks and `Noto Sans JP/SC/KR` for CJK) served as static
assets from the app's own origin, **fetched on first use and cached in the blob store** like any font asset, so the
second use is offline. Nothing is bundled in the JS budget. The per-script **fallback families** are set from this
library (`setFallbacks`), so a Devanagari word in a Fraunces headline shapes correctly without the person doing anything.
Owner question Q4 covers the catalogue question (library vs full Google Fonts in M1).

### 5.5 Loading states

| State | What shows | Letter |
|---|---|---|
| A document opens; its fonts load from the blob store (≤ 100 ms typical) | Text draws with the **fallback family** for the script and relays when the font registers; no shimmer, no placeholder boxes. If a font takes > 300 ms the inspector's `Font ▾` shows a muted `Loading…` mono tag; the pill does not change. | (b) |
| A library font downloads (first use) | The picker row shows a 16 px progress ring; the element previews after download. Failure: the row returns to the download glyph and a toast `Couldn't download Fraunces · Retry` (OVERLAYS §3.2). | (b) |
| Complex-scripts chunk loading | Nothing visible (§3.9). | (a) |
| Wasm text engine failed (IF-TXT-004) | Text elements draw as mist boxes with their bounds; a banner `Text can't be laid out right now · Retry`; retry reloads the module; a second failure follows the worker-crash path (OVERLAYS §3.4). Editing is disabled (double-click does nothing). | (b) |

### 5.6 Missing fonts: detection and replacement

A font is **missing** when a text run references a hash the workspace blob store does not hold (IF-TXT-010 `not-found`
on `load`) — a design imported as `.iflow` without its fonts, or a workspace mirror that lost files. A brand token that
resolves to no font is the **unresolved token** case (IF-TXT-009), handled by the hatch rule, not here.

| Where | What shows | Letter |
|---|---|---|
| Canvas | The text draws in the script's fallback family at the same size (never invisible). Nothing is marked on the canvas itself (a banner-free open; the document is usable). | (a) fallback |
| Inspector / pill | `Font ▾` shows the stored family name (`FontRef.family`, kept for this purpose) in Geist with a hatched chip background and a tooltip `Fraunces is missing on this device · Replace…`; `Weight ▾` disabled with the reason. | (b) |
| Top bar | A mist tag beside the save status: `2 fonts missing` (clickable). Pro only shows it as a mono count; Focus hides it into `⋯` as a menu row. | (b) |
| Layers | Rows of affected elements carry the font icon in sunflower on hover (Pro: always). | (b) |
| **Missing fonts dialog** (tag click, `⋯ › Missing fonts…`, palette) | A dialog (OVERLAYS §2) titled `Missing fonts`, one row per family: name · `used in 14 elements · 2 weights` · a `Replace with ▾` font picker inline · when Local Font Access is granted **and** the family exists on this computer, the row's first action is `Add from this computer` (auto-match by family name, then by PostScript name) · `Upload…`. Footer: `Replace all with the fallback` ghost, `Done` primary. Each replace is one undo step `Replace Fraunces with Inter · 14 elements`, toast with Undo (the same op as Find › Font, STUDIO §9.1). Replacing keeps weights when the new family has them, else nearest, and the toast says `2 weights substituted`. | (b) |
| Export | Export proceeds; the result lists substitutions (`IF-EXP-009`, OVERLAYS §2.3) — **(c) M2**; until then the dialog's preview shows the fallback honestly because the preview is the renderer. | (c) |
| Later: the font arrives (uploaded, copied, downloaded) | Every run with that hash re-lays out; the tag disappears; a 1.5 s toast `Fraunces found · 14 elements updated`. | (b) |

### 5.7 Fallback, subsetting, licensing

- **Fallback** is per script (S3 lesson): `setFallbacks('Arab', […])`. A run never falls back to a different *style*
  silently: when a family lacks italic, the engine synthesises (§5.2); when it lacks a glyph, the per-script fallback
  provides it and the run splits — invisible to the person, visible in Pro as a mono hint under `Font ▾`
  (`+ Noto Sans Arabic for 3 characters`).
- **Subsetting** happens only at export (SVG `Embed fonts`, M2 (c)); the workspace stores whole files so uploads can
  be reused for any text.
- **Licensing** (local-first consequence): fonts copied from the computer or uploaded are stored in the workspace and
  travel in `.iflow` files. The one-time notice (§5.3) says so. Settings › About › Licences lists library fonts (OFL)
  and marks uploaded ones `yours` (HOME-FILES §3.1). Exports embed glyph **outlines** (PDF Type 3, SVG paths) — allowed
  by every common licence including most restrictive desktop licences; embedding font *files* (M2 SVG `Embed fonts`)
  is offered only for fonts whose source is the library or Google Fonts, and for uploads with a confirmation line
  `Embeds brand.otf · check its licence allows web embedding`. Owner question Q4.
- **Export embedding** ties to OVERLAYS §2.3 (c) rows: SVG `Text` + `Embed fonts` (M2), `missingFonts` (M2), colour
  glyphs (M2). PNG and PDF need nothing: the renderer is the source of truth (D21).

## 6. Fidelity

| Concern | Rule | Letter |
|---|---|---|
| **What you see is what exports** | One layout, one outline source (ARCHITECTURE §5.2, D21). The Export preview *is* the renderer; a font missing on screen is missing in the export. Checked by the D21 metric on the text corpus (Latin, Arabic, Devanagari). | (a) |
| **Small sizes and zoom** | Glyphs are unhinted outlines with sub-pixel positioning at every zoom (Figma's choice): text at 100 % looks slightly softer than browser UI text and *identical* to the PDF. Below **4 device px** text is greeked (grey bars, STUDIO §9.2); during a zoom the previous tiles scale then sharpen within 1–3 frames; text is never missing. | (a) |
| **Editing tiny text** | Entering edit mode on text whose line height is **< 12 screen px** zooms the camera about the element until it is ≥ 12 px (160 ms, reduced-motion: instant) and restores the camera on exit **only if** the person did not pan or zoom meanwhile. **Departure** (nobody does this): editing 8 px text at 25 % zoom is guesswork otherwise. Pro can turn it off (`View ▾ › Zoom to edit text`). | (b) |
| **Kerning and shaping** | `kern`, `liga`, mark positioning and contextual forms are on by default (HarfRust GPOS/GSUB); letter spacing is added after kerning (never replaces it). Pro's OpenType row toggles them (M2). Shaping parity with HarfBuzz is tested (IF-21.8). | (a) |
| **Caret and selection over the canvas** | Drawn in the HUD overlay layer from `caret`/`selectionRects`, transformed by the element's full matrix (rotation, skew, flip); the caret keeps ≥ 1 screen px; the IME gets the **axis-aligned bounding boxes** of the transformed character rects (EditContext takes `DOMRect`s), which is what the owner's check exercised with zoom. | (a) data, (b) drawing |
| **Transformed text** | Edited in place (Figma); a flipped text shows mirrored glyphs and still edits (the caret mirrors). Skew is applied to glyph outlines by the matrix (no faux italic confusion: `I` is the style, skew is the transform). | (a) |
| **Hit testing** | Clicks hit the laid-out line boxes, not the whole element rect, when editing; when not editing the element's bounds (a text box is easier to grab than its glyphs). | (b) |
| **Long text** | Target: relayout of a 5 000-character element in ≤ 8 ms off-main (one worker, D15); 50 000 characters ≤ 60 ms. Beyond 20 000 characters a once-per-element toast `Long text slows editing · Split into boxes` (ghost). Incremental paragraph relayout is (c) M2 if the targets fail; the Layers row and the a11y tree always carry the first 80 characters only. | (a) now; (c) if needed |
| **Thumbnails and pages far away** | Pages lens thumbnails render from the same scene; text below 4 px is greeked there too. | (a) |

## 7. Actions

### 7.1 Capabilities (pill More, context menu, palette; the same list, STUDIO §4.2.1)

| Action | Where | Behaviour | Letter / milestone |
|---|---|---|---|
| **Fit to box** | pill More, inspector, context menu | Scales every run so the height fits the box; auto boxes: not rendered | (a) |
| **Auto-fit (shrink on overflow)** | Text · more as `Auto-size ▾ Fit text` (a fourth mode) | Keynote's shrink-to-fit: the box is fixed, the size follows the text live | (c) M2 |
| **Link…** | `🔗`, ⌘K, context menu | §4.2 Link | (a)+(b) |
| **Convert case ▾** | More, context menu | Upper · lower · Title · Sentence, rewriting (M1) | (b) |
| **Clear formatting** | More, ⌘\ | Removes every char mark in the range; paragraph marks stay | (b) |
| **Copy as text** | context menu (element), pill More | Plain text to the clipboard; toast `Copied` | (b) |
| **Find and replace** | ⌘F | STUDIO §9.1; Kind `Font` and the missing-fonts dialog share the replace op | (b) |
| **Select same font** | context menu › Select same ▾ | STUDIO §9 | (b) |
| **Convert to outlines** | context menu, More | The text becomes a group of paths (one per glyph cluster, named by its text), fills kept, text lost; a confirm row in place `This text can't be edited afterwards · Convert`; the glyph outlines come from the export crate's outline source | (c) M2 |
| **Missing fonts…** | `⋯`, the top-bar tag, palette | §5.6 | (b) |
| **Text from image (OCR)** | — | **No built-in OCR** (a Wasm OCR model is 2–10 MB and slow; Canva's is cloud). M2: `✦ Text from image` on an image's pill when the provider has vision; result as a proposal (a new text element). Owner question Q3. | M2 assistant |
| **Variables / data binding** (`{{name}}` fields in repeats and templates) | — | Not in M1 or M2 text work; it is the Flows' batch feature (IF-11, GAP-AUDIT B-3) with repeats: a `field` mark bound to a dataset column. The one M2 item: a **Page number** variable for the Pages lens (`Insert › Page number`), rendered as a chip in the text. | (c) M2 page number; M3 fields |
| **Insert special character** | — | Rejected: the OS has a character viewer; the cheat sheet names it (`⌃⌘Space`). Non-breaking space `⌥Space` passes through as U+00A0. | — |

### 7.2 Assistant actions (M2, only when a provider is configured; CHAT §2.2)

`✦ Rewrite` (slot 6 of the pill; a popover: `Shorter · Longer · Friendlier · Formal · Fix spelling and grammar ·
Translate ▾ · Custom…`), `✦ Check spelling`, `✦ Translate`, `✦ Text from image`. Results arrive as **proposals**
(CHAT §5: Accept / Reject, one undo step, marks kept where the text aligns, otherwise the paragraph's first run's
style). Nothing `✦` renders without a provider (FOUNDATIONS §5.6).

### 7.3 Palette entries

`Text style: Heading 1` … `Code`; `Add font…`; `Use fonts on this computer…`; `Missing fonts…`; `Fit to box`; `Convert
case: …`; `Clear formatting`; `Copy as text`; `Convert to outlines` (M2).

### 7.4 Context menu while editing

`Cut · Copy · Paste · Paste without formatting · ─ · Bold · Italic · Underline · Strikethrough · Link… · ─ · Convert
case ▾ · Clear formatting · ─ · Select all · Select word · Select paragraph · ─ · ✦ Rewrite ▾ (M2)`. On a link: `Open
link · Copy link · Edit link… · Remove link` at the top. The element context menu (STUDIO §8.2) gains `Copy as text`,
`Missing fonts…` (when any) and `Text style ▾`.

## 8. Errors and edge states

| Situation | Code | What the person sees | Fix offered |
|---|---|---|---|
| Font missing on this device | `IF-TXT-010` (`not-found`) | Fallback text, hatched `Font ▾`, top-bar tag, dialog (§5.6) | Replace · Add from this computer · Upload |
| Font file invalid / WOFF | `IF-TXT-006` | Toast `'x.woff' isn't a font Instaflow can use · Use .ttf, .otf or .ttc` | (after §11) WOFF2 decompresses silently |
| Local Font Access refused | `IF-TXT-007` | Inline row in the picker: `Chrome blocked access to your fonts · Allow in site settings · Upload a file instead` | the two actions |
| Local Font Access unavailable | `IF-TXT-008` | The footer row is not rendered (gating) | — |
| Brand token unresolved | `IF-TXT-009` | Hatched `Font ▾` / swatch, `Replace with Fraunces` (STUDIO §5.4) | replace, or open Brand (M2) |
| Text engine (Wasm) failed | `IF-TXT-004` | Mist boxes for text, banner `Text can't be laid out right now · Retry`, editing off | Retry; second failure → worker-crash path |
| Layout rejected (invariant) | `IF-TXT-005` | Never shown; logged to DevTools › Errors; the previous layout stays | — |
| Range / style op rejected | `IF-TXT-001/003` | Never shown (the UI cannot produce them); DevTools | — |
| Characters with no font (unsupported script) | — | Tofu boxes + `▯ 12` marker, tooltip `12 characters have no font · Add a font ▾` (CJK pre-filtered when the library has it) | Add a font |
| Text does not fit a fixed box | — | Overflow drawn + `⤓ 2` marker (§2.3) | Fit to box; Auto height |
| Box too small to show a caret (< 4 screen px) | — | Edit mode zooms (§6) | — |
| Very long text | — | Toast once at 20 000 characters | Split into boxes |
| Empty text on exit | — | Removed, no toast | — |
| Clipboard refused | — | STUDIO §8.1 toast | Allow in site settings |
| Paste of 1 MB+ text | — | Trimmed to 100 000 characters with the toast `Pasted the first 100 000 characters` | — |
| Offline and a library font is uncached | — | Row muted `Needs a connection`; existing text keeps the fallback (OVERLAYS §3.3: no banner until the action) | — |
| Storage full while adding a font | `IF-TXT-010` → `IF-STORE-*` | HOME-FILES §4 storage toast | Free space · Move workspace |

## 9. Accessibility

The canvas a11y tree (B6, IF-21.19) names text elements by their Layers name and first 80 characters; while editing the
element is a `textbox` with `aria-multiline`, the selection is exposed, each paragraph and line has bounds. Links are
announced (`link, instaflow.app`). Every control in §4.2 has a label, a tooltip with the key and `aria-keyshortcuts`;
toggles use `aria-pressed` including `mixed`. The font picker announces previews; the Missing fonts dialog's row count
is a polite live region. Reduced motion: no caret blink, no zoom-to-edit animation. Contrast: the text colour popover
shows a mist tag `AA` / `AAA` / `×` for the text colour against the element's **background behind it** (the page or the
frame fill) when the text is a single colour on a solid fill — a small departure (Canva has a contrast checker as a
separate app; here it is one tag).

## 10. Plumbing (where each piece lives)

| Piece | Code | Status |
|---|---|---|
| Controls table (§4.2) with `tier` and HUD rank | `src/spec/controls.ts` (new, STUDIO §12) | missing |
| Presets (§4.3), Convert case, Clear formatting, Copy as text, Link popover | `src/text/typography.ts` (`applyPreset`, `convertCase`, `clearFormatting`), `src/text/commands.ts` ids, kit `<sf-link-popover>` | missing; ops exist |
| Strikethrough UI, `S` toggle | `typography-panel.ts`, controls | missing (service has `toggle('strike')`) |
| Font picker groups, categories, footer, download states | kit `<sf-font-picker>` (UX-PRIMITIVES), `src/app/fonts.ts` (library index, categories, cache) | kit missing; `FontLibrary` exists |
| Fonts on this computer dialog, licence notice | `src/app/fonts-dialog.ts` over `requestLocalFonts` / `importLocalFont` | missing |
| Missing fonts tag + dialog, `UsageMirror` for font usage | `src/studio/missing-fonts.ts`, `src/workers/mirrors.ts` (shared with Find) | missing |
| Overflow and no-glyph markers | canvas HUD layer (`src/studio/canvas-hud.ts`), from layout `lines()` vs box and `.notdef` clusters | missing; data partly (c) |
| Caret / selection drawing with the element matrix | `src/studio/canvas-hud.ts` | drawing missing; data (a) |
| Zoom to edit tiny text | `src/tools/view-state.ts` + text tool | missing |
| Double/triple click, drag selection, Shift+click | `src/tools/text-tool.ts` (B3 pointer flow) | confirm; likely missing |
| HTML paste, copy HTML | `src/text/clipboard.ts` (new) over `replaceTextOps` + marks | missing |
| Text editing context menu | `src/studio/context-menu.ts` | missing |
| Contrast tag | colour popover (kit) + a background probe (`src/elements/queries.ts`) | missing |

## 11. Follow-ups — every (c), with a milestone (never rendered before it lands)

| # | Item | Where | Milestone |
|---|---|---|---|
| T-1 | **Fixed box height and vertical alignment** laid out and projected (`text.box = fixed`, `verticalAlign`) | `text-style.ts` / `text-scene.ts` (TS), layout spec height | M1 |
| T-2 | **Undo coalescing** while typing (§3.6) | `text-session.ts` commit policy | M1 |
| T-3 | **Platform-aware caret motions** (⌥ word / ⌘ line on Mac; Ctrl word on Windows) | `text-session.ts` | M1 |
| T-4 | **`.notdef` tofu** drawn for missing glyphs + no-glyph marker data | `crates/render` glyphs, layout clusters | M1 |
| T-5 | **Subscript / superscript** mark (`script`) with size and baseline shift | model, layout spec span field, scene | M1 |
| T-6 | **Soft line break** (Shift+Enter) | model (U+2028), layout | M1 |
| T-7 | **WOFF2 upload** (decompress to OTF before `isFontFile`) or align HOME-FILES §3.1 to reject it | `fonts.ts` + a brotli decoder in the worker | M1 |
| T-8 | **Tab does not exit editing**; list indent/outdent (depends on T-10) | `text-session.ts` | M1 |
| T-9 | EditContext control-bounds growth per key intent (IME check finding 2) | `text-session.ts` / `text-input` | M1 (bug) |
| T-10 | **List markers** (bullet, number, checklist), nesting level mark, numbering restarts; paragraph spacing and first-line indent honoured by the layout | model (`p.level`, `check`), layout spec paragraph fields, authoring crate | M2 (markers + spacing could be pulled to M1 if small) |
| T-11 | **Highlight** mark and rects; inline code preset | model, scene | M2 |
| T-12 | **Non-destructive case transform** mark; **small caps** | model, spec-building (`text-style.ts`), OpenType `smcp` | M2 |
| T-13 | **OpenType features** row; **variable axes** beyond `wght`; **baseline offset**; **line height in px** | layout spec span fields, Parley `FontFeature`/`FontVariation` | M2 |
| T-14 | **Linked text styles** (`style` mark + document style list), brand type tokens as styles | model, D14 shared-styles doc, Brand panel (B-4) | M2 |
| T-15 | **Truncate (ellipsis)**, **Auto-fit** box mode, **hyphenation**, **direction override** | layout options, authoring crate | M2 |
| T-16 | **Text on a path / curve**, text bound to a shape with padding | authoring crate (arc-length placement), Frame layout | M2 |
| T-17 | **Convert to outlines** | export crate outline source → document paths | M2 |
| T-18 | **Text stroke** (glyph paths stroked) | render | M2 |
| T-19 | **Colour emoji** (COLR/CBDT) on screen and in export | render, export (OVERLAYS §2.3 row) | M2 |
| T-20 | **SVG `<text>` + embedded subsets**, **`missingFonts` in `ExportResult`** (IF-EXP-009) | export crate, `job.ts` | M2 (already listed in OVERLAYS) |
| T-21 | **Google Fonts catalogue** browse and download | `src/app/fonts.ts`, catalogue index | M2 |
| T-22 | **Page number variable**; `✦ Rewrite / Check spelling / Translate / Text from image` proposals | model `field` mark; CHAT | M2 |
| T-23 | **Drop cap** | layout | M2 |
| T-24 | Incremental paragraph relayout for very long text (only if §6 targets fail) | authoring crate | M2 |
| T-25 | Threaded text boxes (columns across elements), drag-to-move selection, data fields in repeats, local spelling dictionary | — | M3 / backlog |

## 12. Owner questions (recommendation first)

**Q1. Tab while editing.** *Recommend:* inside a list item Tab indents (Shift+Tab outdents); anywhere else Tab does
nothing — it neither inserts a tab character (we have no tab stops) nor leaves editing (today it does, and a typist who
hits Tab by habit loses the caret and lands on the element). Exit stays Escape / ⌘Enter / click away. *Example:* you are
typing a bulleted agenda, press Tab on `Budget` → it becomes a sub-point; in a headline Tab is simply ignored.
*Question:* fine to make Tab a no-op outside lists, or do you want Tab to move focus to the pill (a keyboard-only
path to the controls, which ⌥Enter already provides)?

**Q2. Spelling.** *Recommend:* no squiggles in M1 (EditContext gives the browser nothing to check; a local dictionary
is 1–2 MB per language in a worker), and in M2 `✦ Check spelling` through the assistant as a proposal you accept word by
word. *Example:* you type "recieve" in a poster; M1 shows nothing; M2 the pill's ✦ menu offers `Fix spelling and
grammar` and shows `receive` as a change to accept. *Question:* acceptable that M1 has no spellcheck at all, or should a
local dictionary (English only, ~1.5 MB, M2) be pulled forward instead of the assistant path?

**Q3. Text from an image (OCR).** *Recommend:* no built-in OCR. A Wasm OCR model costs 2–10 MB and reads design
typography badly; the assistant with a vision model does it well and arrives in M2 as `✦ Text from image` on an image's
pill, producing a proposal (a new text element you can accept). *Example:* you drop a photo of a menu; M2 with a
provider: `✦ Text from image` → a text box with the dishes, accept or reject. Without a provider the action does not
exist. *Question:* agreed?

**Q4. Fonts: library, Google Fonts and licences.** *Recommend:* M1 ships a **curated library of ~24 open-licence
families** (plus the Noto fallbacks for Arabic, Devanagari, Thai and CJK) served from our own origin and cached on first
use, so it works offline afterwards; **uploads** and **fonts on this computer** (copied into the workspace) cover the
rest; the full **Google Fonts catalogue** is M2. Fonts copied from a computer travel with the workspace and inside
`.iflow` files — so the "Fonts on this computer" dialog shows one sentence once: `Fonts you add are saved with your
designs so they open on any device. Check a font's licence before sharing design files.` Exports embed outlines, which
every licence allows; embedding font *files* (M2 SVG option) is on by default only for library and Google fonts.
*Example:* you add Helvetica Neue from your Mac, make a poster, export a PDF — fine (outlines). You send the `.iflow`
to a colleague — the file carries Helvetica, which Apple's licence does not allow; the notice is the only guard.
*Questions:* (i) library-plus-uploads in M1, Google catalogue M2? (ii) is a one-time notice enough, or do you want a
per-font `Licence ▾` field (Desktop · Web · Open) that gates the M2 file-embedding option?

**Q5. Overflow.** *Recommend:* a fixed text box never clips its own text; the overflow is drawn and a small `⤓ 2` tag
marks it with Fit to box one click away (Canva instead grows the box; InDesign hides the text behind a red plus; Figma
overflows silently). Pro gets `Truncate · Ellipsis` in M2. *Example:* a caption box under a photo, you paste a longer
sentence: the extra line shows below the box with the tag; click the tag → the text shrinks to fit. *Question:* agreed?

**Q6. Text styles.** *Recommend:* M1 presets (Title, Heading 1–3, Subheading, Body, Caption, Quote, Code) that **apply
values**; M2 **linked** styles that update every use when edited (engine: a `style` mark and a document style list),
and brand type tokens become styles in the Brand panel. *Example:* M1: pick `Heading 2` on three pages; later change
one to 36 px — the other two stay 32. M2: `Update style` makes all three 36. *Question:* fine to ship unlinked presets
first, with the `Style ▾` row reading `Custom` once you deviate?

**Q7. Columns and threaded text.** *Recommend:* reject columns **inside** one text element (Figma and Canva have none;
designers lay out columns as separate boxes) and defer InDesign-style **threaded boxes** (text flowing from one box
into the next) to M3. *Example:* a two-column flyer is two auto-height boxes side by side, aligned with `Tidy up`.
*Question:* agreed, or is threading needed for the Pages lens earlier (multi-page documents)?

**Q8. Shadowed shortcuts while editing text.** *Recommend:* while the caret is in text, `⌘K` = Link (not the command
palette), `⌘.` / `⌘,` = superscript / subscript (not density cycle / Settings), `⌘\` = clear formatting (not toggle
dock), `⌘⇧V` = paste without formatting (not paste in place), `⌘]` / `⌘[` = indent (not bring forward). These are the
Docs/Notion/Figma keys and already the pattern STUDIO §7 uses for `⌘⇧L/E/R`. On exit the canvas meanings return.
*Example:* select a word, `⌘K`, paste a URL, Enter → a link; Escape, `⌘K` → the palette. *Question:* agreed? The
alternative (no shadowing, so `⌘K` is always the palette) makes links a mouse-only feature.

**Q9. Zoom to edit tiny text.** *Recommend:* when you double-click text that is under 12 screen px tall, the camera zooms
in so you can read what you type, and zooms back on exit unless you moved the view meanwhile. Pro can switch it off.
*Example:* a 9 px legal line at 50 % zoom: double-click → the view glides in to ~130 %; Escape → back. *Question:*
agreed? Nobody does this; it is the one departure a first-timer would feel most.

**Q10. Default text.** *Recommend:* new text uses the document's **Text defaults** (Document section): the template's
font or `Geist 20 px, ink, line height 1.3` for a blank design; the Text tool's long-press menu offers the presets.
Canva starts with a preset panel; Figma with 12 px Inter (too small for a poster). *Question:* `Geist` as the blank
document's default font (already shipped for the UI, open licence), or a display face like Bricolage to match the
brand's headlines?

## Appendix A. Feature checklist against Docs · Notion · Figma · Canva · InDesign · Pages

Method (coordinator, 2026-10-25): every text control the six tools offer, each marked **include** (where it lives, per
density: `S` = Standard at rest, `M` = behind `More ▾`, `P` = Pro only, `HUD` = the pill, `menu` = More / context /
palette), **defer** (milestone and the §11 item) or **reject** (why). Columns `D N F C I P` = Docs, Notion, Figma,
Canva, InDesign, Pages have it. Nothing basic is left implicit.

### A.1 Text types, presets and styles

| Control | D N F C I P | Decision | Where / why |
|---|---|---|---|
| Title / Heading 1–3 / Subheading / Body / Caption presets | ✓ ✓ – ✓ ✓ ✓ | **include** | `Style ▾` S, tool long-press menu, palette (§4.3) |
| Quote preset | ✓ ✓ – – ✓ – | **include** | §4.3 (block indent waits for T-10) |
| Code preset (block) | ✓ ✓ – – – – | **include** | §4.3 mono font; highlight M2 (T-11) |
| Linked / named styles (edit once, update all) | ✓ – ✓ ✓ ✓ ✓ | **defer M2** | T-14 |
| Create style from selection / Update style / Detach | – – ✓ – ✓ ✓ | defer M2 | T-14 |
| Brand type tokens as styles | – – ✓ ✓ – – | defer M2 | T-14, Brand panel B-4 |
| Markdown prefixes (`# `, `- `, `1. `, `[] `) convert as you type | – ✓ – – – – | defer M2 | with T-10; a session typing hook |
| `/` command menu in text | – ✓ – – – – | **reject** | The palette (`⌘K` outside editing) and `Style ▾` do this; a second menu in the text is Notion-specific |
| Default text style per document | ✓ – – – ✓ ✓ | **include** | Document section › Text defaults (§2.1) |

### A.2 Inline formatting

| Control | D N F C I P | Decision | Where |
|---|---|---|---|
| Bold / Italic / Underline | ✓ ✓ ✓ ✓ ✓ ✓ | **include** (a) | HUD `B`; `I U` M + keys; inspector `B I U S` row S |
| Strikethrough | ✓ ✓ ✓ ✓ ✓ ✓ | **include** (a engine, b UI) | row S, `⌘⇧X` |
| Subscript / Superscript | ✓ – – – ✓ ✓ | **include, M1 follow-up** (c) | Text M, `⌘,` / `⌘.` (T-5) |
| Small caps | – – – – ✓ ✓ | defer M2 | Text P (T-12) |
| All caps / lower / title / sentence case | – – ✓ ✓ ✓ ✓ | **include** convert (b); non-destructive mark M2 | `Case ▾` M (T-12) |
| Text colour | ✓ ✓ ✓ ✓ ✓ ✓ | **include** (a) | HUD swatch; inspector S |
| Highlight / background colour | ✓ ✓ – – – ✓ | defer M2 | Text M (T-11) |
| Link (URL, mailto, internal page) | ✓ ✓ ✓ ✓ ✓ ✓ | **include** (a+b) | `🔗` row S, `⌘K`, popover |
| Inline code | – ✓ – – – – | defer M2 | T-11 |
| Font family / weight / size | ✓ ✓ ✓ ✓ ✓ ✓ | **include** (a) | HUD + S |
| Letter spacing (tracking) | – – ✓ ✓ ✓ ✓ | **include** (a) | M, `⌥>`/`⌥<` |
| Word spacing | – – – – ✓ – | **reject** | InDesign-only; letter spacing and justify cover the need |
| Baseline shift | – – – – ✓ ✓ | defer M2 | Text P (T-13) |
| Kerning on/off, optical kerning | – – – – ✓ – | defer M2 (toggle) | OpenType row P (T-13); kerning is always on |
| Ligatures (standard, discretionary) | – – ✓ – ✓ ✓ | defer M2 | OpenType row P |
| Figures (lining, oldstyle, tabular, proportional), fractions, stylistic sets, swashes | – – ✓ – ✓ ✓ | defer M2 | OpenType row P |
| Variable font axes | – – ✓ – – – | `wght` include (a); others defer M2 | Weight menu; Text P sliders (T-13) |
| Text stroke / outline | – – ✓ – ✓ ✓ | defer M2 | Stroke ▸ (T-18) |
| Text shadow, glow | – – ✓ ✓ ✓ ✓ | **include** (a) | Effects ▸ (group effects) |
| Text as gradient / image fill | – – ✓ – ✓ – | defer M2 | with the Fill stack on glyph leaves (render brush kinds exist; projection is per run) |
| Clear formatting | ✓ ✓ – – ✓ ✓ | **include** (b) | menu, `⌘\` |
| Copy / paste style (format painter) | ✓ – ✓ ✓ ✓ ✓ | defer M2 | `⌘⌥C` / `⌘⌥V` on text ranges, with T-14 |
| Font preview on hover | – – ✓ ✓ – – | **include** (b) | picker §5.1 |
| Insert special characters / glyph palette | ✓ – – – ✓ ✓ | **reject** | the OS character viewer; the cheat sheet names it |
| Equations | ✓ ✓ – – – ✓ | **reject** | not a design need; an image or SVG import |
| Emoji picker | ✓ ✓ – – – ✓ | **include via OS** | `⌃⌘Space` (cheat sheet) |

### A.3 Block (paragraph) formatting

| Control | D N F C I P | Decision | Where |
|---|---|---|---|
| Align left / centre / right | ✓ ✓ ✓ ✓ ✓ ✓ | **include** (a) | HUD `Align ▾`; Align row S |
| Justify | ✓ – ✓ ✓ ✓ ✓ | **include** (a) | Align row S, `⌘⇧J` |
| Vertical align (top / middle / bottom) | – – ✓ ✓ ✓ ✓ | **include, M1 follow-up** (c) | M, fixed boxes only (T-1) |
| Line height | ✓ ✓ ✓ ✓ ✓ ✓ | **include** (a) multiple; px M2 | M (T-13 for px) |
| Paragraph spacing before / after | ✓ – ✓ ✓ ✓ ✓ | **include** model (a), layout (c) | Paragraph M (T-10) |
| First-line indent | ✓ – ✓ – ✓ ✓ | include model (a), layout (c) | Paragraph M (T-10) |
| Block indent / outdent | ✓ ✓ – – ✓ ✓ | defer M2 | `⌘]` / `⌘[` (T-10) |
| Bulleted list | ✓ ✓ ✓ ✓ ✓ ✓ | **include** model (a); markers (c) | `List ▾` S, `⌘⇧8` (T-10) |
| Numbered list (1. a. i.) | ✓ ✓ ✓ ✓ ✓ ✓ | include model (a); markers (c) | `List ▾` S, `⌘⇧7`; numbering styles per level `1. → a. → i.` fixed (no picker in M1/M2) |
| Checklist | ✓ ✓ – ✓ – ✓ | defer M2 | `List ▾`, `⌘⇧9` (T-10) |
| Nesting levels with markers (• ◦ ▪) | ✓ ✓ – ✓ ✓ ✓ | defer M2 | Tab / Shift+Tab (T-8, T-10) |
| Custom bullet glyph / image bullets | ✓ – – – ✓ ✓ | **reject** | rare; a `•` is enough; Pro may get a glyph field with T-10 |
| Restart numbering / continue | ✓ – – – ✓ ✓ | defer M2 | context menu row with T-10 |
| Drop cap | ✓ – – – ✓ ✓ | defer M2 | Paragraph P (T-23) |
| Columns inside a text box | ✓ ✓ – – ✓ ✓ | **reject** | Q7: separate boxes; threaded boxes M3 (T-25) |
| Threaded text frames | – – – – ✓ ✓ | defer M3 | T-25 |
| Hyphenation | – – – – ✓ ✓ | defer M2 | Paragraph P (T-15) |
| Text direction (LTR/RTL override) | ✓ – – – ✓ ✓ | defer M2 | Paragraph P (T-15); auto direction is (a) |
| Vertical (CJK) writing | – – – – ✓ ✓ | **reject** M1/M2 | niche; revisit with CJK users |
| Tabs and tab stops | ✓ – – – ✓ ✓ | **reject** | no ruler, no tables; Tab indents lists |
| Keep with next / widows and orphans | ✓ – – – ✓ ✓ | **reject** | page-flow features of word processors |
| Borders and shading on paragraphs | ✓ – – – ✓ ✓ | **reject** | a shape behind the text does it |
| Line numbers | ✓ – – – – – | **reject** | — |
| Truncate with ellipsis | – – ✓ – – – | defer M2 | Text P (T-15) |
| Auto-size: auto width / auto height / fixed | – – ✓ ✓ ✓ ✓ | **include** (a two; fixed c M1) | M, handles (T-1) |
| Shrink text on overflow (auto-fit) | – – – ✓ – ✓ | defer M2 | `Auto-size ▾ Fit text` (T-15); manual Fit to box is (a) |
| Text wrap around objects | ✓ – – – ✓ ✓ | **reject** | not a page-layout engine |
| Text on a path / curve | – – – ✓ ✓ – | defer M2 | T-16 |
| Warp / arch effects | – – – ✓ ✓ – | defer M2 | with T-16 |
| Text in a shape with padding (auto-size shape) | – – ✓ ✓ ✓ ✓ | double-click gesture **include** (b); bound text defer M2 | §2.4 |

### A.4 Editing comfort

| Control | D N F C I P | Decision | Where |
|---|---|---|---|
| Double-click word, triple-click paragraph | ✓ ✓ ✓ ✓ ✓ ✓ | **include** (b) | §3.2 |
| Shift+click extend, drag select | ✓ ✓ ✓ ✓ ✓ ✓ | include (b) | §3.2 |
| Drag selected text to move it | ✓ ✓ – – ✓ ✓ | defer M3 | T-25 |
| Word / line / document caret jumps | ✓ ✓ ✓ ✓ ✓ ✓ | include (a; platform fix c M1) | §3.3, T-3 |
| Undo per word, not per keystroke | ✓ ✓ – ✓ ✓ ✓ | **include, M1 follow-up** (c) | §3.6, T-2 |
| Paste without formatting | ✓ ✓ – ✓ ✓ ✓ | include (b) | `⌘⇧V` |
| Paste HTML keeping bold/italic/links | ✓ ✓ ✓ ✓ ✓ ✓ | include (b) | §3.7 |
| Paste a URL onto a selection → link | ✓ ✓ – – – – | include (b) | §3.7 |
| Spellcheck squiggles | ✓ ✓ – ✓ ✓ ✓ | **defer** (assistant M2; local dictionary backlog) | §3.8, Q2 |
| Grammar / rewrite suggestions | ✓ ✓ – ✓ – – | defer M2 (assistant) | §7.2 |
| Autocorrect / smart quotes / auto-capitalise | ✓ ✓ – – ✓ ✓ | **reject M1**; smart quotes M2 option | design copy is often deliberate; smart quotes as a Settings switch later |
| Find and replace | ✓ ✓ plugin – ✓ ✓ | **include** (b) | STUDIO §9.1 |
| Word / character count | ✓ ✓ – – ✓ ✓ | **include** (b) | Pro: mono `128 chars · 24 words` under the Text section; Standard: tooltip on the element name in the inspector header |
| Comments on a range | ✓ ✓ ✓ ✓ ✓ ✓ | defer (D11) | anchored ranges exist (IF-21.4); UI in the Presence/Comments spec (B-8) |
| Collaborative carets | ✓ ✓ ✓ ✓ – ✓ | defer (B-8) | §3.4 last row |
| Dictation | ✓ – – – – ✓ | **include via OS** | the OS dictation types through EditContext; nothing to build |
| Translate | ✓ – – ✓ – – | defer M2 (assistant) | §7.2 |
| IME (CJK), bidi | ✓ ✓ ✓ ✓ ✓ ✓ | **include** (a) | §3.9, D20 |
| Zoom to edit tiny text | – – – – – – | **include** (b, departure) | §6, Q9 |

### A.5 Fonts

| Control | D N F C I P | Decision | Where |
|---|---|---|---|
| Font search, in-face preview rows | ✓ – ✓ ✓ ✓ ✓ | **include** (b) | §5.1 |
| Recent fonts / fonts in this document | ✓ – ✓ ✓ ✓ ✓ | include (b) | groups |
| Category filters (serif, sans, …) | ✓ – – ✓ – – | include (b) | chips |
| Google Fonts catalogue | ✓ – ✓ ✓ – – | defer M2 | T-21 |
| Upload a font file | – – – ✓ (paid) – – | **include** (a+b) | §5.3; WOFF2 T-7 |
| Fonts on this computer (Local Font Access) | – – ✓ (agent) – ✓ ✓ | **include** (a+b) | §5.3 |
| Brand fonts | – – ✓ ✓ – – | include (a) | Brand group; tokens |
| Favourite / pin fonts | – – – ✓ – ✓ | **reject M1** | Recent covers it; a star per row is cheap to add later |
| Missing-font detection and replace | ✓ – ✓ – ✓ ✓ | **include** (b) | §5.6 |
| Font pairing suggestions | – – – ✓ – – | defer M2 (assistant) | `✦ Suggest a pairing` on `Font ▾` when a provider exists |
| Variable font instances | – – ✓ – ✓ – | include (a wght) | §5.2 |
| Synthetic weights marked honestly | – – – – ✓ – | **include** (b, departure) | §5.2 |
| Font licence info | – – – ✓ – – | include (notice + About) | §5.7, Q4 |
| Embed / subset fonts in export | – – ✓ ✓ ✓ ✓ | PDF outlines (a); SVG embed defer M2 | OVERLAYS §2.3, T-20 |
| Convert text to outlines | – – ✓ – ✓ ✓ | defer M2 | T-17 |

### A.6 Not text controls, listed so they are not missed

Footnotes, table of contents, bookmarks, headers/footers, page numbers as fields (page number: M2 variable, T-22),
mail merge / data fields (M3 with Flows), tables (not in the text model; a Frame grid is the M2 answer), citations,
tracked changes (milestones and proposals are Instaflow's model), voice typing (OS), accessibility checker (the contrast
tag §9 is the one piece included).

## Appendix B. Coordinator checklist rows that touch text (`CAPABILITY-COVERAGE.md`)

| Row | How this spec accounts for it |
|---|---|
| Text and fonts (§21, `src/text`) | This file end to end; FLOWS F-10, F-60…F-64 |
| Appearance: fills, strokes, effects (§20) | Text colour (§4.2), text stroke (T-18), effects on text (a), gradient text (A.2 defer) |
| Transforms (§34) | Rotated / skewed / flipped text editing and caret (§6); corner handles scale size (§2.2) |
| Groups, components and instances (§20) | Editing inside groups, repeat source / instance rules (§3.4) |
| Repeat (§26) | §3.4; data fields in repeats deferred to Flows (§7.1) |
| Snapping, guides (§24) | Text boxes snap like shapes; baseline snapping is not offered (A.3 reject implied: no ruler) |
| Layers, Pages, Library (§23) | Layers text rows (first 80 chars), Assets › Fonts, Pages thumbnails greeking (§6) |
| Versioning (§22) | Milestone preview is read-only text (§3.4) |
| Export (§29) | Fidelity §6; embedding §5.7; (c) rows shared with OVERLAYS §2.3 (T-19, T-20) |
| Import (`src/workspace`) | Font import paths (§5.3), `.iflow` fonts and missing fonts (§5.6), WOFF2 mismatch (T-7) |
| Home, files, storage | Fonts in the workspace and storage errors (§8) |
| Accessibility (§25, `src/a11y`) | §9 |
| Brand kit | Font tokens (§4.3), Brand group in the picker, unresolved token hatch (§8) |
| Motion (§9) | Clusters / words / lines addressing is engine-only here (IF-21.12); no text UX until the Timeline spec (B-1) |
| Generative features (§10) | `✦ Rewrite`, `Check spelling`, `Translate`, `Text from image`, `Suggest a pairing` as provider-gated proposals (§7.2) |
| Flows (§11) | Data fields / variables deferred to Flows (§7.1) |
| Agent views and change sets (§6, §12) | The typography service is the one pipeline agents use (IF-21.29); every control in §4.2 maps to a capability |
| Identity, sharing (§13, §14) | Licence notice for shared `.iflow` files (§5.7); presence carets deferred (B-8) |
