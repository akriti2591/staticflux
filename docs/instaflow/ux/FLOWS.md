# Instaflow flows (Layer 3)

> Status: **normative acceptance tests.** Every flow names what the person is trying to do, the surfaces it touches,
> the **building blocks** (FOUNDATIONS) it exercises, and each step's *visible* result, so a broken block shows up in
> every flow that uses it. Flows are not scripts tied to today's DOM: they state what must be observable, in order.
> Tier: **M1 must-pass** (the end-to-end suite, both worker topologies), **M1** (ships in M1, tested when its WP lands),
> **M2**. Pointer and keyboard paths are both given; a flow passes only when both do, unless a step says otherwise.
>
> Conventions: `Mod` = ⌘ / Ctrl. "Pill" = the selection pill. "Toast", "banner", "takeover" = `OVERLAYS-FEEDBACK.md`;
> URLs and fallbacks = `NAVIGATION-DEEPLINKS.md`; text and fonts = `TEXT-FONTS-UX-SPEC.md` (F-60…F-64); appearance,
> transforms and structure = `APPEARANCE-TRANSFORM-UX-SPEC.md` (F-65…F-72). Fixture: a fresh workspace
> unless a precondition says otherwise. Every step's result must be checkable by a test (DOM text, accessibility tree,
> the editor's `inspect`, a screenshot region, or the polite live region).

## A. Studio

### F-01 First run — **M1 must-pass**
Goal: a first-timer makes a design, keeps a version, leaves and comes back. Surfaces: Home, Studio. Blocks: Card,
Button, Tool picker (Icon button + Tooltip + hint), Selection pill, Field, Toast, Tree (Layers), Regions, Density.

| # | Pointer | Keyboard | Visible result |
|---|---|---|---|
| 1 | Open `/` | — | Home: hero with the format row, `＋ New design` primary, empty Jump back in line "Your designs will appear here." No developer text anywhere (F-19 §). |
| 2 | Click `＋ New design` | Tab to it, Enter | Studio opens at `/s/<id>` in **Standard** density: top bar (logo slot, title `Untitled design`, lens switcher `Canvas · Pages` only, `● Saved`, `View ▾`, `Milestone`, `⋯`), dock on Layers (empty-state line), the canvas as the mist room with **one white page card with a shadow** and the label `Page 1 · Post · 1 080 × 1 080`, the tool picker pill (Select Frame Shape Text Hand; no Pen), the zoom pill `Fit`, the command bar `Type a command ⌘K`, the inspector showing **Page** sections. The title field is focused for naming (Escape keeps `Untitled design`). |
| 3 | Hover Shape | — | Tooltip `Rectangle · R` after 500 ms. |
| 4 | Click Shape, drag on the page | `R`, then Shift+arrows cannot draw: keyboard path = `R`, then Enter places the default 100 × 100 at the viewport centre | While dragging: a marquee outline and a `W × H` pill. On release: a tangerine rectangle, selected (round handles, the rotate handle below), the pill `Fill · Stroke · Radius · Duplicate · Delete · ⋯`, Layers shows `Rectangle`, the inspector shows Transform · Fill · Stroke · ▸ Corners · ▸ Effects · ▸ Layer with the Fill swatch **tangerine** (resolved). The tool returns to Select. First-use hint shown once under the picker (dismissed on the next action). |
| 5 | Click Text, click on the page, type `Hello` | `T`, Enter, type | A caret appears where clicked; typing shows `Hello` in the document font; the pill shows `Font ▾ · Size · B · Align ▾ · Fill · ⋯`. |
| 6 | Click empty canvas | Escape | Text editing ends, the text stays, nothing selected; the inspector shows Page. `● Saved` within 2 s. |
| 7 | Click `Milestone` | `Mod+Alt+S` | A popover with `Milestone 1` pre-selected and a note field; Enter creates. **Toast** "Milestone 'Milestone 1' created · Rename · View"; the Milestones tab shows a dot; opening it lists `Latest` and `Milestone 1`. |
| 8 | Click the logo | Tab to the logo, Enter | Home: Jump back in shows the card `Untitled design · Edited just now · 1 page` with a cover (or the format chip). |
| 9 | Click the card | Enter | Studio reopens with the rectangle and `Hello`, the last camera, nothing selected. |
| 10 | Reload the tab | `F5` | The same document and camera; `● Saved`. |

### F-02 Drawing on the canvas, on and off the page — **M1 must-pass**
Blocks: Tool picker, Selection models, Tree (Layers), Drag and drop (re-parent), Export dialog line.

| # | Pointer | Keyboard | Visible result |
|---|---|---|---|
| 1 | `F`, drag **on the mist** outside the page | `F`, Enter (default 400 × 300 at the viewport centre, which is on the page) | A white frame with a non-printing hairline outline and the label `Frame 1` above it; selected; Layers lists it under the **Canvas** group (loose) in the pointer case, under `Page 1` in the keyboard case. |
| 2 | `F`, drag on the page | — | A white frame on the white page is **visible**: hairline + label. Layers: under `Page 1`. |
| 3 | `R`, drag inside Frame 2 | — | While dragging, Frame 2's outline turns tangerine; on release the rectangle is Frame 2's child (Layers indents it); it is clipped by the frame. |
| 4 | Drag the rectangle out of the frame onto the mist | Select it, Shift+arrows ×n | The frame's clip hides it while inside; dropped fully outside the page it becomes loose (Layers moves it to Canvas); the drop target highlighted while hovering. |
| 5 | Drag it back fully onto the page | arrows | Re-parented to `Page 1`. |
| 6 | Open `Pages` lens (`5`) | `5` | Only pages show, loose elements hidden; the Pages panel line `1 loose element on the canvas · Show in Canvas`. |
| 7 | (after C1) Open Export | `Mod+Shift+E` | The dialog states "1 element outside the pages won't be exported." |

### F-03 Using every tool — **M1 must-pass**
Blocks: Icon button (selected state), Tooltip, first-use hint (coach mark), Switcher.

For each of Select (V), Frame (F), Rectangle (R; menu Ellipse O, Line L), Text (T), Hand (H), and Pen (P) once it ships:
1. Hover → tooltip `Name · Key`. 2. Click or key → the icon sits on the soft tangerine pill, `aria-pressed=true`, the
cursor changes (crosshair / text / grab). 3. The first activation shows the one-line hint under the picker exactly once
per device; the hint has a close ×. 4. Use: Select drags a marquee on empty canvas; Frame/Shape/Text create as F-01/F-02;
Hand drags the canvas (the page card moves), and holding **Space** with Select does the same (cursor grab); Pen: click
three points → a path with straight segments, drag a point → a curve with handles, click the first point → closed,
Enter → finished and selected, Escape → cancels an unfinished path. 5. Double-click a creation tool → the sticky dot;
two shapes in a row without re-choosing; `V` leaves sticky. 6. `Escape` with a creation tool → Select.

### F-04 Transforming — **M1 must-pass**
Blocks: Handles (resize, rotate handle + zones, skew, pivot), size/angle pills, Scrubbable number, snapping guides. Spec:
`APPEARANCE-TRANSFORM-UX-SPEC.md` §3 (F-69 extends this flow).

| # | Pointer | Keyboard | Visible result |
|---|---|---|---|
| 1 | Click a shape | Tab | Selected: frame, 8 round handles, the rotate handle 24 px below on a stem. |
| 2 | Drag the body | arrows / Shift+arrows | Moves 1 / 10; smart guides (tangerine) and distance tags appear when aligned with the page centre or another element; `X, Y` pill while dragging; one undo step `Move` / `Nudge`. |
| 3 | Drag the SE handle; with Shift; with Alt | `Mod+Alt+→` / `Mod+Alt+Shift+→` | Resizes; Shift keeps the ratio; Alt resizes from the centre; `W × H` pill; the inspector W/H follow live. |
| 4 | Drag the rotate handle; with Shift | `Alt+]` / `Alt+Shift+]` | Rotates about the pivot with the rotate cursor and an angle pill; Shift snaps to 15°; keyboard 15° / 1°. The invisible corner zones also rotate (cursor changes 12 px outside a corner). |
| 5 | Pill `⋯ › Flip horizontal` | `Shift+H` | Mirrored; twice restores; undo label `Flip horizontal`. |
| 6 | Inspector `More ▾`, scrub Skew; or Mod+drag a side handle in Pro | type `15` in Skew, Enter | The shape leans 15°; the field shows `15°`. |
| 7 | Pill `⋯ › Free transform` | `Mod+Alt+T` | Thicker frame, the pivot ring; drag the pivot, rotate; Enter commits **one** undo step `Transform`; Escape cancels everything. |
| 8 | Drag a handle past the opposite edge | — | The shape flips (B10a); the inspector shows Flip on. |
| 9 | Scrub the X label | — | Cursor `ew-resize`; the shape moves live; release = one undo step. |

### F-05 Delete and undo — **M1 must-pass**
Blocks: Selection pill (Delete), Context menu, Toast, keyboard scopes.

| # | Pointer | Keyboard | Visible result |
|---|---|---|---|
| 1 | Select a shape, click pill `Delete` | Select, `Backspace` **and** `Delete` | Gone; Layers row gone; nothing selected; the overflow shows `Undo: Delete`. |
| 2 | Click a tool-picker button, then press Delete with a selection | click `Milestone` then Escape, select, Delete | Delete works although focus was on chrome (the canvas scope follows the selection); it does **not** work while a text field has focus. |
| 3 | Right-click a shape › Delete | `Shift+F10`, arrows, Enter | Deleted. |
| 4 | Select 6 shapes, Delete | `Mod+A`, Delete | **Toast** "Deleted 6 elements · Undo"; clicking Undo restores all six, selected. |
| 5 | — | `Mod+Z` ×3, `Mod+Shift+Z` | Each step restores / redoes exactly one gesture; the overflow label changes each time; Windows also accepts `Ctrl+Y`. |
| 6 | Delete while editing text with a caret | Backspace | Deletes a character, never the element. |

### F-06 Clipboard within a document — **M1 must-pass**
Blocks: Clipboard conventions, Selection models, Toast (permission).

| # | Pointer | Keyboard | Visible result |
|---|---|---|---|
| 1 | Context menu › Copy on a styled rectangle | `Mod+C` | Silent. |
| 2 | Context menu › Paste | `Mod+V` | A copy at +24, +24, selected, same fill/stroke/radius; `Mod+V` again → +48, +48. |
| 3 | — | `Mod+Shift+V` | A copy at the **same** coordinates (on top). |
| 4 | Copy a text element, paste | — | Rich text and marks kept (bold stays bold). |
| 5 | Copy a repeat, paste | — | A live repeat with the same parameters. |
| 6 | Cut | `Mod+X` | The source disappears (undo label `Cut`); paste brings it back at the same place. |
| 7 | Enter a frame (double-click), paste | — | The pasted element is the frame's child. |
| 8 | Go to Page 2, paste | — | Same page coordinates as the source. |

### F-07 Clipboard across documents and from other apps — **M1**

1. Copy in design A, open design B (Home → card), paste → same coordinates; a copied image whose bytes exceed the inline
   limit shows the "Image not available on this device · Replace" placeholder (test with a > 2 MB image), smaller ones
   paste intact; a brand token missing in B pastes as its hex and the inspector shows the hex. 2. Paste a PNG from the
   system clipboard (Playwright: write `image/png`) → imported into Assets (new row) and placed centred in the viewport
   at pixel size ≤ 80 % of the viewport. 3. Paste plain text with nothing selected → an auto-width text element at the
   viewport centre; while editing text → inserted at the caret. 4. Paste HTML `<b>bold</b> plain` → one text element
   with a bold run. 5. Paste SVG → before C2: an image element; after C2: a group of vector elements. 6. Copy a selection
   and paste into a plain-text app (read `text/plain` from the clipboard) → the element names / text content; after C1
   `image/svg+xml` is present too. 7. Deny clipboard permission → toast "Clipboard blocked by the browser · Allow in
   site settings"; internal copy–paste within the tab still works.

### F-08 Duplicate and arrange — **M1 must-pass**
Blocks: Selection pill (Align ▾, Distribute ▾, Group), Context menu (z-order), Alt-drag, smart duplicate.

| # | Pointer | Keyboard | Visible result |
|---|---|---|---|
| 1 | Pill `Duplicate` | `Mod+D` | A copy at +24, +24, selected. Move it 100 right, `Mod+D` again → the next copy lands another 100 right (smart spacing) with a brief `+100, 0` label. |
| 2 | Alt+drag a shape | — | The original stays; the copy follows the pointer; undo label `Duplicate`. |
| 3 | Marquee three shapes, pill `Align ▾ › Left` | `Mod+A`, `Alt+A` | Left edges aligned; the pill stays in place. |
| 4 | `Distribute ▾ › Horizontal spacing` | `Ctrl+Alt+H` (Mac `⌃⌥H`) | Equal gaps; distance tags flash. |
| 5 | Pill `Group` | `Mod+G` | One `Group` row in Layers with three children, selected as a group; pill shows `Ungroup · Align ▾ · Duplicate · Delete · ⋯`. `Mod+Shift+G` ungroups. |
| 6 | Context menu › Bring to front on the bottom shape | `Mod+Alt+]` | It draws on top; Layers moves the row to the top; `Mod+[` sends it one step back. |
| 7 | Context menu › Frame selection | `Mod+Alt+G` | A frame sized to the selection wraps it (Layers nests). |
| 8 | Select two overlapping shapes, pill `Combine ▾ › Union` | — | One boolean group; the pill shows `Operation ▾ · Release · Flatten`. |

### F-09 Styling — **M1 must-pass**
Blocks: Inspector sections, Colour field popover, Scrubbable number, Slider, stacks. Spec: `APPEARANCE-TRANSFORM-UX-SPEC.md`
§2 (F-65…F-68 below extend this flow).

1. Select a rectangle → inspector sections exactly `Transform · Fill · Stroke · ▸ Corners · ▸ Effects · ▸ Layer` (no
   Typography, no Repeat). 2. Click the Fill swatch → popover with hex, brand tokens, recents, opacity; type `#3D5AFE`
   → the shape turns blue on each keystroke; Escape restores, Enter keeps. 3. `+ Add` in Stroke → a 1 px stroke row with
   Width and Position ▾; set Position Outside → visible. 4. Expand Corners, scrub Radius to 24 → rounded; toggle
   per-corner, set TL 0. 5. Expand Effects, `+ Add` › Shadow → a shadow with offset/blur fields; eye hides it; × removes.
   6. Layer › Opacity slider to 50 % → the mono pill reads `50%`; Blend ▾ Multiply. 7. Select two shapes with
   different fills → the Fill row reads `Mixed`; pick a colour → both change. 8. Every change is one undo step with a
   label (`Fill`, `Stroke width`, `Radius`, `Shadow`, `Opacity`).

### F-10 Text, including IME — **M1 must-pass** (IME steps are the owner's manual check, TXT-10)
Blocks: Text tool, Selection pill (text), Inspector Text section, Field, EditContext. Spec: `TEXT-FONTS-UX-SPEC.md`
(F-60…F-64 below extend this flow).

1. `T`, click, type a sentence → auto-width text; `Enter` → a new paragraph; drag the right handle → fixed width,
   wraps; inspector Auto-size reads `Fixed`. 2. Double-click a word → selected; `Mod+B` → bold; the pill's `B` is
   pressed; `Mod+Shift+E` centres the paragraph. 3. Pill `Font ▾` → a list with previews and a filter; choose one → the
   text re-renders; `Size` scrub → live. 4. Inspector Text: Line height 1.2, Letter spacing 2 → visible change. 5.
   Escape → the element is selected, no caret; Enter → editing again with the caret at the end; `Mod+Enter` commits.
   6. Type in Japanese (`nihongo`, Space, Enter) → the candidate window sits at the composition; the committed text is
   日本語; the same across a wrapped line and after Arabic text. 7. Create a text element and leave it empty → it is
   removed on exit and undo has nothing extra. 8. Fit to box (`⋯`) on an overflowing fixed box → the size shrinks to
   fit.

### F-11 Layers management — **M1 must-pass**
Blocks: Tree and list, Inline rename, Drag and drop, row actions, Filter field.

| # | Pointer | Keyboard | Visible result |
|---|---|---|---|
| 1 | Draw 3 shapes, a frame with 2 children | — | Layers: `Page 1` ▾ with rows in paint order (newest on top), the frame with a chevron; kind icons from the one set. |
| 2 | Click a row | ↑/↓ then Space | The canvas selection follows; the row is the soft tangerine pill; the canvas scrolls it into view. |
| 3 | Hover the eye › click | `Mod+Shift+H` | The element disappears from the canvas; the row is 50 % with the eye crossed; `Mod+Shift+H` again shows it. |
| 4 | Click the lock | `Mod+Shift+L` | A dashed frame on the canvas, no handles, the pill shows `Unlock`; the row keeps the lock icon; clicking the element on canvas does not select it (marquee neither). |
| 5 | Double-click the name, type `Hero`, Enter | Enter on the row, type, Enter | Renamed everywhere (inspector header, announcer); Escape cancels; empty refused inline. |
| 6 | Drag a row above another | `Alt+↑` | Insertion line while dragging; the paint order changes on the canvas; one undo step `Reorder`. |
| 7 | Drag a row onto the frame | — | The frame highlights; dropped inside, the row indents and the element is clipped by the frame. |
| 8 | Type `tex` in the filter | `/`-less: Tab to the field | Only text rows show; Escape clears. |
| 9 | Right-click a row | `Shift+F10` | The element's context menu. |
| 10 | Alt+click the page chevron | — | Everything inside expands. |

### F-12 Masks and booleans — **M1**

Spec: `APPEARANCE-TRANSFORM-UX-SPEC.md` §4.3–4.4.

1. Select an image over an ellipse (the **ellipse below** the image: the bottom-most selected element becomes the mask,
   `useAsMask`), pill `Use as mask ▾ › Clip` → the image is clipped to the ellipse; Layers shows a `Mask group` with the
   ellipse row marked ◐ and the image indented; the pill shows `Mask · Clip` chip · `Mask mode ▾ · Invert · Release`; the
   first time, the hint `The bottom layer is the mask`. 2. `Invert` → the outside shows.
   3. `Release` → back to two elements. 4. Two overlapping shapes, `Combine ▾ › Subtract` → the result; `Operation ▾ ›
   Exclude` changes it live; `Flatten` → one path (Layers icon changes to path). 5. `Outline stroke` on a stroked shape →
   the stroke becomes a filled path. 6. Each is one undo step named after the action.

### F-13 Repeats — **M1**
Spec: `APPEARANCE-TRANSFORM-UX-SPEC.md` §4.6.

1. Select a shape, pill `⋯ › Make repeat ▾ › Radial` → 8 instances on a circle; the pill becomes `Radial · 8 · Count · Edit ·
   Expand · Release`; the inspector shows the Repeat section (Count, Radius, Start angle, Sweep, Rotate). 2. Scrub Count
   to 12 → live. 3. `Edit` → repeat handles on the canvas; drag the radius handle → live; release = one undo step.
   4. Switch kind to Grid → rows/columns fields; Mirror → axis. 5. Clicking an instance selects the **source** and shows
   the instance highlight. 6. `Expand` → 12 real elements in a group (Layers), match keys stable (re-expand after undo
   yields the same ids in `inspect`). 7. `Release` → the single source.

### F-14 Library: place an image — **M1 must-pass**
Blocks: Dock Assets, Button, Drag and drop, Toast (errors), Card.

1. Dock › Assets: empty line "Drop images here or press Import."; click `Import`, pick a JPEG → a thumbnail row appears
   with the pixel-lens mark; a second import of the same bytes → no duplicate, the existing row highlights. 2. Click the
   thumbnail → placed at the canvas centre, selected, the pill `Crop · Fit ▾ · Replace… · Use as mask ▾ · Duplicate ·
   Delete`; Layers shows `lanterns.jpg`. 3. Drag a thumbnail onto the page → placed at the drop point. 4. Drop a file
   from the OS onto the canvas → imported then placed at the drop point. 5. Import a `.txt` → toast with the
   `IF-LIB-001` message and fix; nothing listed. 6. In M1 the lens switcher stays `Canvas · Pages` after the first image (the Pixel lens does not exist yet);
   from M2 the Pixel lens slides in (F-23).

### F-15 Pages — **M1 must-pass**
Blocks: Dock Pages (Tree), Lens switcher, Context menu, page label.

1. Pages tab shows `Page 1` with the Layout mark; `+ Add page` → `Page 2` at the same size, placed right of Page 1 on the
   canvas with its label; the camera shows it. 2. `5` → Pages lens: the camera fits Page 2; `PageUp` → Page 1. 3. Drag
   Page 2 above Page 1 (or `Alt+↑`) → story order changes; in the Canvas lens positions stay. 4. Right-click the page
   label › Rename → `Cover`; the label and the Pages row update. 5. Context menu › Duplicate page → `Cover copy` with the
   same elements (new ids). 6. Delete page → toast "Deleted page 'Cover copy' · Undo"; Undo restores it with its
   elements. 7. Nothing selected → the inspector Page section; change Size preset to Story → the card resizes; elements
   keep their positions.

### F-16 Templates — **M1**

1. Studio `⋯ › Save as template…` → a popover with the title; Enter → toast "Saved as template 'Night market' · Open
   Home". 2. Home › Templates shows the card with the `Template` tag and `Use`. 3. `Use` → a new design opens with the
   same content; its title field is focused; Home lists it under Jump back in, not Templates. 4. Template `⋯ › Edit
   template` opens the template itself (title shows the Template tag in the top bar). 5. Slots (B5): a template with a
   slot asks for the fill on Use (M1 plumbing: a one-field popover per required slot).

### F-17 Milestones and compare — **M1 must-pass**
Blocks: Button, Popover, Toast, Dock Milestones (Tree), read-only banner.

1. `Milestone` → popover, name `Client v1`, Enter → toast, badge, the list shows `Latest`, `Client v1 · just now`.
   2. Edit the design; create `Client v2`. 3. Row `Client v1 › Open` → the canvas shows that state with a banner
   "Milestone 'Client v1' · today · Read-only · Back to Latest"; no handles; the pill shows only `Copy`; `Back` returns.
   4. Select both rows (Space ×2) › Compare → side by side, visual only, with labels; Escape closes. 5. `Client v1 › New
   document from milestone` → a new design opens titled `Client v1 copy` with the provenance line in the inspector's
   Document section; its own Milestones list has only `Latest`. 6. Pin `Client v2` → the pin icon; pinned rows sort
   first. 7. `Mod+S` → toast "Instaflow saves automatically · Create milestone".

### F-18 Export — **M1** (after C1)

1. `Export` (primary) or `Mod+Shift+E` → the dialog: What `Page · Selection · Pages`, format switcher PNG · PDF · SVG
   (· .iflow after C2), scale (1× 2× 3×), the loose-elements line when relevant, the "snapshot" sentence (the full
   dialog is F-53). 2. PNG 2× of the current page → a download `<Title>.png`, toast "Exported … · Show in folder" (folder mirror on) and the
   dialog closes; the Milestones list is unchanged (D10: exports create nothing). 3. PDF of all pages → one file, real
   text (selectable in a viewer). 4. SVG → opens in a browser identically (parity rule from C1). 5. `.iflow` → re-import
   (C2) opens an identical document. 6. Cancel mid-export → no file, no toast, the dialog stays usable.

### F-19 Every visible action does something — **M1 must-pass**
Blocks: Selection pill, Menu (More), Context menu, Top bar, Tool picker, Command palette, forbidden-text rule.

For each selection kind in STUDIO-UX-SPEC §4.2 (nothing, shape, text, image, group, frame, multi, repeat, boolean, mask,
page): 1. Every visible pill item, every More row, every context-menu row and every top-bar control is clicked once by
the test; each click must change the document (`inspect` differs), the view (camera, selection, lens), open a surface
(menu, popover, dialog, palette) or show a toast — **a click with no observable change fails the flow**. 2. No More row
or context row is disabled; rows that cannot apply are absent. 3. The rendered text of Studio and Home contains no
match for the forbidden-text pattern (FOUNDATIONS §5.11). 4. Nothing assistant-shaped renders without a provider; the
lens switcher has exactly two options; the Pen button is absent until its controller exists; `Share` is absent.

### F-20 Keyboard-only use — **M1 must-pass**
Blocks: Keyboard map, focus order, Toolbar roving, Menu, Command palette, Help.

1. From page load, Tab walks: logo → title → lens switcher → save status → View → Milestone → ⋯ → Export → dock tabs →
   dock content → tool picker → canvas → (pill when a selection exists) → inspector → command bar → zoom; focus ring
   visible on each. 2. On the canvas: `R`, Enter → a shape; arrows nudge; `Mod+D`; `Mod+G`; `Alt+]`; `Shift+H`; `Mod+]`;
   `Mod+Shift+L`; `Mod+Shift+H`; `Backspace`; `Mod+Z` ×n — every step observable as in F-04/F-05/F-08/F-11. 3.
   `Alt+Enter` → the pill's first item focused; arrows move; Enter runs; Escape back to the canvas. 4. `Mod+K`, type
   `union`, Enter → the boolean runs (with two shapes selected); type `radial` → the repeat. 5. `?` → Shortcuts help
   lists every binding with Mac/Windows labels; `Mod+,` → Settings. 6. `Shift+F10` → the context menu; typeahead `d`
   → Delete. 7. No step needs a pointer; none uses a browser-reserved combo.

### F-21 Screen-reader basics — **M1 must-pass**
Blocks: accessibility tree (B6), announcer, names, landmarks.

1. Landmarks: banner, navigation (dock), main (canvas), complementary (inspector); the canvas is one tab stop named
   "Canvas, 3 elements". 2. Tab into the canvas, arrows / Tab cycle elements: each is announced "Rectangle, 1 of 3
   selected" with its Layers name when named. 3. Enter on a frame enters it ("Inside Frame 1"); Shift+Enter leaves.
   4. A resize announces "Resize Hero"; Delete announces "Deleted Hero"; Undo "Undo delete". 5. Every pill item and
   tool reads name + shortcut; toggles read pressed state. 6. Toasts are read once, politely, and never steal focus.
   7. Milestone creation announces "Milestone 'Milestone 1' created". 8. The audit (`expectNoA11yIssues`) passes on
   every state of Studio and Home.

### F-22 Error and empty states — **M1**

1. **Offline:** block the network → nothing changes (local-first); fonts not yet cached show the fallback with a toast
   "Font 'Fraunces' isn't available offline · Using Geist". 2. **Storage full:** simulate a quota error → `● Not saved ·
   Storage full`, toast "Storage is full. Free space or move the workspace to a folder · Open Storage settings";
   editing continues; freeing space resumes saving (`● Saved`). 3. **Unsupported browser:** Firefox without WebGPU /
   Safari → one calm screen "Instaflow needs Chrome on desktop", the missing capability named, the `IF-PLAT-` code and a
   link; no spinner. 4. **Empty states:** new workspace Home, empty Layers, empty Assets, no milestones — each shows
   its one line and one action from FOUNDATIONS §4.15. 5. **Boundary:** make a panel throw → that region shows
   "Something went wrong here · Try again" and the rest of Studio keeps working. 6. **Trashed design opened by URL:**
   the banner "This design is in the trash · Restore".

### F-23 Lens switcher and contextual lenses — **M1 must-pass** (contextual part M2)

1. New design: the switcher shows `Canvas · Pages`; `1` / `5` switch; the active option is the white pill; a switch
   is announced. 2. Keys `2`, `3`, `4` do nothing and Help does not list them. 3. (M2) Place an image → `Pixel` slides
   in after Pages; delete the image → it fades out (not while in it). 4. (M2) Add a transition between pages →
   `Timeline` appears.

### F-24 Settings — **M1**

1. Studio `⋯ › Settings` (or `Mod+,`) → a dialog over Studio with sections General, Shortcuts, Storage, Assistant
   (the single Coming card), About. 2. General › Density Pro → Studio shows rulers behind the dialog; the line "Saved on
   this device". 3. Nudge 2 / 20 → arrows nudge 2. 4. Reduced motion on → menus open without animation. 5. Shortcuts
   lists every binding; the search field filters. 6. Storage shows usage and persistence; `Move workspace to a folder`
   (Chrome) runs the folder picker; afterwards the footer and this page name the folder. 7. Home header gear → `/settings`
   as a page with the same sections. 8. Reload → settings kept; a different browser profile → defaults (device-local).

### F-25 Command palette — **M1 must-pass**

1. Click the command bar or `Mod+K` → the field focused, recents (empty on first run), then grouped capabilities.
   2. Type `align` → align rows with shortcuts; with nothing selected they are absent. 3. Select three shapes, `Mod+K`,
   `tidy`, Enter → Tidy up runs; the palette closes; the bar shows `Tidy up` in recents next time. 4. `View › …` entries
   (Zoom to fit, Density) appear and run. 5. Escape closes and returns focus to where it was.

### F-26 Context menu per target — **M1 must-pass**

For each target in STUDIO-UX-SPEC §8.2 (empty canvas, shape, text, image, group, frame, multi, repeat, boolean, mask,
page label, Layers row): right-click (or `Shift+F10`) → a menu at the pointer with exactly the listed rows (order and
dividers), icons from the one set, shortcuts right-aligned; every row runs (F-19 rule); Escape closes and restores
focus; the menu never overflows the viewport.

### F-27 Selection pill per kind — **M1 must-pass**

For each kind in §4.2: select it → the pill appears centred 12 px above the selection within 1 frame, with exactly the
listed items (≤ 6 + ⋯), never overlapping the tool picker; scroll so the selection is near the top → the pill moves
below; drag the element → the pill hides and reappears 120 ms after release; change to another kind → the pill re-lays
out once; `⋯` opens the searchable More menu with groups and shortcuts.

### F-28 Inspector per kind — **M1 must-pass**

For each kind in §5.1: select it → exactly the listed sections in order, each heading once, collapsed ones with ▸;
nothing selected → Page · Document; at 264 px no field overflows or wraps; a multi-selection shows `Mixed` where values
differ; Focus density → the rail; Pro → every section expanded with scrubbable fields and the pivot picker.

### F-29 Top bar feedback and controls — **M1 must-pass**

1. Click the title → inline field; type `Spring sale`, Enter → the title, the browser tab title and Home's card update;
   Escape cancels. 2. `Milestone` → F-17 step 1. 3. `⋯ › Save as template…` → F-16 step 1. 4. `View ▾` → the menu with
   zoom, snapping, density (radio with explanations), dock/inspector toggles; each runs. 5. Save status hover → the
   tooltip sentence; click → the Milestones tab. 6. No `Share`, no assistant chip, no density segmented control in the
   bar. 7. (after C1) `Export` opens the dialog.

## B. Home and files

### F-30 Rename a design — **M1 must-pass**
Blocks: Card (menu), Inline rename, Toast, Studio title.

1. Home card `⋯ › Rename` (or `F2` on the focused card, or double-click the title) → inline field, text selected;
   type, Enter → the card title updates; toast "Renamed to 'Spring sale' · Undo"; Undo restores. 2. Empty → "A name is
   required" inline, no change. 3. In Studio, rename via the title (F-29) → back on Home the card shows the new title.
   4. Two tabs: rename in one → the other's card updates without reload.

### F-31 Delete (trash) and restore — **M1 must-pass**
Blocks: Card, Context menu, Toast with Undo, Trash page, read-only banner.

1. Card `⋯ › Move to trash` (or `Delete` on the focused card) → the card fades; toast "Moved 'Spring sale' to trash ·
   Undo" (8 s); Undo brings it back in place. 2. Let it expire; Nav › Trash lists it with `Restore` and `Delete forever`
   and the "kept for 30 days" line. 3. `Restore` → back in Home, toast "Restored · Open". 4. `Delete forever` → inline
   confirm; `Delete` → gone; the copy says it can't be undone. 5. A design open in Studio in another tab, trashed here →
   that tab shows the banner and is read-only; Restore there lifts it. 6. Trash 7 designs by bulk → the bulk bar asks
   inline before trashing.

### F-32 Duplicate a design — **M1**

Card `⋯ › Duplicate` (or `Mod+D`) → `Spring sale copy` appears first in the list with a rise, focused; toast
"Duplicated · Open · Undo"; Open → Studio with identical content and its own Milestones list (`Latest` only); Undo trashes
the copy.

### F-33 Organise into projects — **M1**
Blocks: Card drag and drop, Menu (Move to ▾), project view, Inline rename.

1. Projects section `＋ New project` → inline name `Spring campaign`, Enter → a project card with 0 designs. 2. Card
   `⋯ › Move to ▾ › Spring campaign` → the card stays in Jump back in (recency is not a place), the project card's
   count reads 1, and the card's meta line gains `· Spring campaign`; toast "Moved to Spring campaign · Undo". 3. Drag a card onto the project card → the
   target edge highlights; drop → moved. 4. Open the project → header with the name, count, `⋯`; the grid; `Move to ›
   No project` returns it. 5. Project `⋯ › Rename` inline. 6. `⋯ › Delete project` with designs → inline "Keep designs,
   delete project? · Delete · Cancel"; designs return to No project. 7. Files › `Project ▾` filter shows only that
   project. 8. Keyboard: focus a card, `Mod+Shift+M` opens Move to; arrows, Enter.

### F-34 Find a design — **M1**

1. `/` focuses the header search; type `flyer` → every list filters live with highlighted matches; Enter → Files with
   the query in the field. 2. No matches → "No results for 'flyer' · Clear". 3. Files: Sort ▾ Name A–Z reorders; Grid /
   List switch keeps the selection; `Favourites` filter shows starred designs only. 4. Filters, sort and view persist
   after reload.

### F-35 Open from a real folder and move the workspace — **M1** (folder move D8; opening `.iflow` after C2)

1. Settings › Storage › `Move workspace to a folder` → the Chrome folder picker; after choosing, the page shows
   `Workspace: ~/Designs/instaflow`, the footer too; edits in Studio appear as files in the folder within 5 s (mirror);
   Studio's save status stays `● Saved` (the mirror is never on the ack path). 2. Firefox: the control reads `Back up
   workspace (.zip)` and downloads a zip. 3. (after C2) Files › `Open folder…` → designs from the folder appear with an
   `On disk` tag; opening one works; closing the tab and reopening keeps the handle (permission re-prompt once).

### F-36 Templates on Home — **M1**

Templates section shows template cards only (tag `Template`, `Use` primary); `Use` → F-16; `⋯` has Edit template,
Rename, Duplicate, Move to project, Move to trash; templates never appear in Jump back in; Files › Templates filter lists
them.

### F-37 Storage full on Home — **M1**

With a simulated quota error: a banner above the hero "Storage is full. Free space or move the workspace to a folder ·
Open Storage settings"; New design still opens Studio (in memory) with the `● Not saved · Storage full` status; the
footer usage line reads the real number.

### F-38 Favourites and bulk select — **M1**

1. Hover a card › star → filled tangerine; `Favourites` filter shows it. 2. Files list: checkbox on hover; Shift+click
   a range; `Mod+A`; the bulk bar slides up with the count; `Move to project ▾` moves all with one toast; `×` clears.
   3. Escape clears the selection.

## C. Chat (M2)

### F-40 Start from the Home composer — **M2**
Blocks: Card (composer), Button (Agent), Switcher, Toast.

1. With a provider configured (F-45), Home's hero shows the composer; type "A flyer for our night market", `✦ Start
   making` → `/c/<thread>` opens with the message as the first bubble and a streaming reply. 2. The reply attaches a
   mini editor card (preview, `Edit here`, `Open in Studio`). 3. Without a provider the composer is absent and the hero
   shows `Set up an assistant`.

### F-41 Mini editor: preview then edit — **M2**

1. Click the preview → within 150 ms the card becomes live: the header shows the spec's tools and the pill appears on
   the selection. 2. Edit the headline text → the document changes (Studio opened later shows it). 3. `Done` → preview
   again. 4. A fourth live mini editor collapses the oldest to an image. 5. A new turn that changes the spec animates
   only the differing slots; the pinned slot stays.

### F-42 Proposal in Ask mode — **M2**

1. Composer `✦ Ask ▾` → Ask. Send "line up the sponsor logos" → a proposal card (`✦ <Provider> proposes`, sentence, `3
   changes · one undo step`, Accept / Reject) and, in the mini editor, dashed raspberry outlines with the provider tag.
   2. Reject → nothing changed. 3. Send again, Accept → applied as one undo step with the chip `✦ <Provider> · 1 undo
   step`; the person's `Mod+Z` does **not** undo it; the chip's Undo does.

### F-43 Accept-edits mode and conflicts — **M2**

1. Mode `Accept edits`; send "make the date bold" → applied immediately with the chip. 2. Send "delete the subhead" →
   still a proposal (destructive). 3. Move the headline while the assistant rewrites it → the split chip `yours /
   <Provider>'s`; default keeps yours; the log shows "skipped: you moved the headline".

### F-44 Handoff Chat ⇄ Studio — **M2**

1. `Open in Studio` → Studio with the Chat side panel docked (288 px), the mini editor's selection selected, the camera
   on it. 2. Edit in Studio; `← Chat` → the thread with the edit visible in the mini editor preview; nothing lost. 3.
   Reload → the thread is still attached to the design; milestones keep the thread; export does not include it.

### F-45 Provider setup and switch — **M2**

1. Settings › Assistant lists providers; Chrome built-in shows availability (download on a gesture with progress);
   Remote › Anthropic: key field (masked after entry), `Test` → "Connected" or the provider's error; the line "Stored only
   on this device". 2. The top-bar chip reads `✦ Claude · Accept edits`; the composer `Claude ▾` switches per thread;
   choosing Gemini renames the chip and copy; raspberry stays. 3. Remove the key → the chip reads `✦ Set up an
   assistant`; `✦` actions vanish from pills.

### F-46 Assistant from the Studio selection pill — **M2**

Select text → the pill shows `✦ Rewrite` as the 6th item; click → the side panel opens with `Context: Headline selected`
and a tone sheet; a proposal follows F-42; `✦ Ask` in the command bar routes natural language to the thread.

## E. Primitives end to end (overlays, feedback, deep links)

### F-47 Share a design — **M2** (after accounts, D3; the Share tab is not rendered before)
Blocks: Dialog (routable, tabs, wizard step), Menu inside a dialog, inline confirm row, copy field, Toast, deep link.

| # | Pointer | Keyboard | Visible result |
|---|---|---|---|
| 1 | `Export` → tab `Share` | `Mod+Shift+E`, `→` on the tabs | The dialog switches to Share (URL `…/d/export?tab=share`); the link row with `Copy`, the access row `Anyone with the link ▾ · can view ▾`, the invite field, `Publish a release ▸`, `Done` primary. One modal; the canvas behind is inert. |
| 2 | `Copy` | Tab to it, Enter | The button reads `Copied` for 1.5 s; the clipboard holds `/s/<asset>`; no toast (the feedback is at the gesture). |
| 3 | `Anyone with the link ▾` › `People invited` | Enter, arrows, Enter | A one-level menu over the dialog; choosing applies at once; the status line `Saved · Only invited people can open this`; Escape would have closed the menu only. |
| 4 | Type `ana@example` in Invite, `Invite` | — | Inline field error `Enter an email address` under the field; the primary stays enabled. Fix it → the row `ana@example.com · can view ▾ · ×` appears. |
| 5 | Row `×` | Tab to it, Enter | The row becomes `Remove ana@example.com? · Remove · Cancel` inline; no second dialog. `Remove` → row gone. |
| 6 | `Link settings ▸` | — | The body slides left 160 ms; header gains a back chevron and `Link settings`; fields Expires ▾, Allow download, Require a password; footer `Back · Save`. URL `?step=link-settings`. |
| 7 | Set Expires `30 days`, press Escape | Escape | Not closed: the footer shows `Discard changes? · Discard · Keep editing` with focus on Keep editing. `Keep editing`, then `Save` → back to step 1, the link row shows the tag `Expires in 30 days`. |
| 8 | `Publish a release ▸` → `Publish` | — | Step 3: progress row `Rendering page 2 of 3` with `Cancel`; then the release link with `Copy` and `Open`, primary `Done`. |
| 9 | `Done` | Enter | The dialog closes with `history.back()` (it was pushed); focus returns to `Export`; toast `Published 'Release 1' · Open` (8 s). |
| 10 | Open `/s/<asset>/d/share` in a new tab | — | Studio renders, then the dialog opens on the Share tab; Escape **replaces** the URL with `/s/<asset>` (no Back needed). Before accounts exist the same link opens Export with the toast `Sharing isn't available yet`. |

### F-48 Restore a milestone (preview, compare, open as new design) — **M1**
Blocks: Dock Milestones (Tree, row menu), Takeover, banner header, read-only HUD, Toast, deep links, history.

| # | Pointer | Keyboard | Visible result |
|---|---|---|---|
| 1 | Create `Client v1`, change the headline, create `Client v2` | `Mod+Alt+S` ×2 | Milestones tab: `Latest`, `Client v2`, `Client v1`. |
| 2 | Click `Client v1` | ↓ to it, Enter | The **preview takeover**: the canvas shows the old headline; banner header `Milestone 'Client v1' · today 14:02 · Read-only` with `Compare with Latest`, `Open as new design`, `Copy link`, `Back to Latest`; no handles; dock and inspector read-only. URL `/s/<asset>/m/<id>` (pushed). |
| 3 | Select the old headline, `Mod+C` | Tab to it, `Mod+C` | The HUD shows `Copy` only; copied. |
| 4 | `Compare with Latest` | — | Two canvases side by side labelled `Client v1 · today 14:02` and `Latest`; pan one → both move; `Show changes` outlines the headline on both sides (sunflower). URL `…?compare=latest`. |
| 5 | Press Escape | Escape | Back to the preview (one level); Escape again → Latest, URL `/s/<asset>`, nothing selected, history has no dead entries (Back leaves the design). |
| 6 | `Mod+V` | — | The old headline is pasted into Latest at the same coordinates (the person lifted a part of the old version); one undo step `Paste`. |
| 7 | Milestones row `⋯ › Open as new design` | `Shift+F10`, arrows, Enter | Latest flushes; a new design `Client v1 copy` opens with the title field focused; toast `New design from 'Client v1' · Back to 'Night market'`; its Document section reads `From milestone 'Client v1' of 'Night market'`; its Milestones list has `Latest` only. Nothing in the original changed. |
| 8 | Row `⋯ › Delete milestone` on `Client v2` | — | The row becomes `Delete 'Client v2'? · Delete · Cancel`; `Delete` → gone; no dialog; the copy says it can't be undone. |
| 9 | Open `/s/<asset>/m/<deleted id>` | — | Latest opens; toast `That milestone is no longer here`; the URL is replaced with `/s/<asset>`. |

### F-49 Follow a deep link to a missing element — **M1**
Blocks: Routes, intents (`el=`, `inspect=`), fallbacks, Toast, cold boot order, hints suppression.

| # | Pointer | Keyboard | Visible result |
|---|---|---|---|
| 1 | Context menu on a shape › `Copy link to selection` | `Shift+F10`, `c` typeahead, Enter | Toast `Link copied` (1.5 s); the clipboard holds `/s/<asset>?page=<p>&el=<e>`. |
| 2 | Paste it in a new tab | — | Studio boots with the skeleton; the page card and chrome first; then the shape is **selected**, the camera zoomed to it with padding, the HUD above it, `1 element selected` announced; the inspector shows Shape sections; `el=` is stripped from the URL. No first-use hint shows. |
| 3 | Edit the link to `…&inspect=stroke` | — | As 2, and the inspector's Stroke section is expanded and scrolled into view; focus stays on the canvas (Escape and shortcuts work). |
| 4 | In the first tab, delete the shape; reload the second tab's original link | — | The design opens, nothing selected, camera fits the page; toast `That element is no longer in this design` (neutral, 5 s); URL replaced to `/s/<asset>?page=<p>`. Reload again → no toast (the URL no longer asks). |
| 5 | Edit the link to `el=<e2>,<deleted>` | — | `e2` selected; toast `1 of 2 linked elements is no longer in this design`. |
| 6 | Change `page=` to a bogus id | — | First page; toast `That page is no longer in this design`. |
| 7 | Open `/s/not-a-design` | — | The Home-shell page `This design isn't on this device` with `Go to Home` and `Open a folder…`; no spinner, no toast, no Studio chrome. |
| 8 | Open `/s/<asset>/d/settings?section=shortcuts` | `?` in Studio does the same in-app | Studio, then the Settings dialog on Shortcuts, after the first content frame; `Copy link` in its header; Escape **replaces** to `/s/<asset>` (deep-linked) whereas in-app `?` then Escape calls `history.back()`. |

### F-50 Recover from a worker crash — **M1**
Blocks: Banner, automatic retry, Toast, blocking error, `Copy diagnostics`, save status.

| # | Pointer | Keyboard | Visible result |
|---|---|---|---|
| 1 | Draw and move shapes; the test terminates the editor worker (`IF-WRK-*`) | — | Within 500 ms: the canvas freezes; a banner over the canvas region `The editor stopped unexpectedly · Restarting…` with the busy dot; the top bar, dock and inspector stay usable; shortcuts that need the editor are off; save status `● Not saved · Restarting`. No dialog. |
| 2 | Wait | — | Workers restart once; the document reloads from Latest; the banner leaves; toast `Editor restarted` (8 s), or `Editor restarted · Your last changes from the past 2 s may be lost · Undo history kept` when the last commit was not acknowledged; `● Saved`; the selection is restored when its elements exist; undo still works. |
| 3 | Terminate it again within a minute | — | The **blocking error** takeover: `The editor can't start`, one sentence, `Reload` (primary), `Copy diagnostics`, `Back up workspace`; `alertdialog`, announced once; nothing else is reachable. |
| 4 | `Copy diagnostics` | Tab, Enter | The button reads `Copied`; the clipboard holds JSON with the `IF-WRK-*` codes, topology and versions; the surface text itself shows no code. |
| 5 | `Reload` | Enter | Studio boots; the document is at the last acknowledged Latest; Home's card shows the same `Edited` time. |
| 6 | Export during a crash of the export worker only (`IF-EXP-*`) | — | A **section error** inside the Export dialog (`Couldn't export · Try again`), not a banner: the editor is fine. |

### F-51 Configure an assistant — **M2**
Blocks: Settings (dialog and page), Field (password), inline status, section error, Toast with Undo, deep link, no-provider state.

| # | Pointer | Keyboard | Visible result |
|---|---|---|---|
| 1 | Home hero `Set up an assistant` | Tab, Enter | `/settings/assistant`: the one-sentence key notice; provider cards `Chrome built-in`, `On-device model`, `Anthropic`, `OpenAI`, `Google`, `Custom endpoint`, each with a status line; none is `Default`. |
| 2 | Expand `Anthropic`, paste a key, Tab | — | The key masks to `sk-…9f2a` on blur; status `Key saved · not tested`; the line `Saved on this device`. |
| 3 | `Test connection` with a bad key | Enter | `aria-busy` on the button; then a **section error** under the fields: `Key refused · Check the key, or create a new one` with the provider console link; the key field keeps its value and gets `aria-invalid`. |
| 4 | Fix the key, `Test connection` | — | Inline status `● Connected · claude-… · 420 ms`; the card gets the `Default` tag (first ready provider); Defaults show `Write: Anthropic`. |
| 5 | Open a design | — | The top-bar chip `✦ Claude · Accept edits`; the command bar reads `Ask Claude or type a command`; `✦ Rewrite` on a text selection. |
| 6 | Settings › Assistant › `Remove key` | — | Toast `Key removed · Undo` (8 s); the chip reads `✦ Set up an assistant`; `✦` actions vanish; `/c/<thread>` still opens with the card `Set up an assistant to continue this conversation · Open settings`. `Undo` restores the key and the chip. |
| 7 | Go offline, send a message in Chat | — | Banner above the composer `You're offline. The assistant needs a connection; editing works.`; Send disabled with the reason in its tooltip; the turn card `Waiting for a connection… · Cancel`; back online → the turn sends once. |
| 8 | Provider returns 429 | — | The turn card `Claude is over its limit right now · Try again in 30 s` with `Retry` counting down and `Switch provider ▾`. |
| 9 | Send a long request, press `Stop` | Escape in the composer | The partial reply stays, tagged `Stopped`; in-flight proposals vanish; applied steps remain as undo steps. |

### F-52 Canva-style quick recolour from the HUD — **M1 must-pass**
Blocks: Contextual HUD (control model), Colour popover (document colours), light dismiss pass-through, Inspector sync, Undo.

| # | Pointer | Keyboard | Visible result |
|---|---|---|---|
| 1 | Draw a rectangle, a cream (`#FFF4E0`) ellipse and a text | — | Three elements; the document uses tangerine, cream and ink. |
| 2 | Click the rectangle | Tab | Pill `Fill · Stroke · Radius · Duplicate · Delete · ⋯`, 12 px above the selection; the Fill swatch shows the **resolved** tangerine; the inspector Fill row shows the same colour and `@primary`. |
| 3 | Click the pill's Fill swatch | `Alt+Enter`, Enter | The **colour popover** (264 px) anchored to the swatch: hex `#FF5C39`, opacity `100 %`, eyedropper (Chrome), **Document colours** `#FF5C39 · #FFF4E0 · #16151A`, Brand (when a kit), Palette, Recent, `Custom ▸`; focus in the hex field; the pill is frozen. |
| 4 | Hover the cream document swatch | arrows to it | A mono tag `#FFF4E0 · 1 use`; **no** preview on hover. |
| 5 | Click it | Enter | The rectangle turns cream within one frame; the inspector Fill row reads `#FFF4E0` at the same instant; one undo step `Fill`; the popover stays open; Document colours now shows `#FFF4E0 · 2 uses` first. |
| 6 | Type `3D5AFE` in the hex field | — | Live preview on each complete hex; Enter commits one undo step; Escape would restore cream. |
| 7 | Click the ellipse on the canvas | — | The popover closes **and** the ellipse is selected (one click, pass-through); the pill re-lays out for the new selection; focus on the canvas. |
| 8 | Open the inspector Fill swatch | Tab to it, Enter | The **same** popover component, anchored to the inspector row, with the same Document colours including the blue; pick blue → the ellipse is blue; `Mod+Z` twice restores both. |
| 9 | Select the text, pill `Colour` swatch; then double-click into the text, select one word, pill swatch | — | The whole text recolours; inside editing, only the selected run recolours (the pill stays above the element while editing). |
| 10 | Marquee the rectangle and the text | `Mod+A` | Pill `Fill · Align ▾ · Distribute ▾ · Group · Delete` (both have a fill); the Fill swatch shows the `Mixed` hatch; pick a document colour → both change; the inspector Fill row no longer reads `Mixed`. |
| 11 | `Custom ▸` | — | The picker expands **inside** the popover (no second popover); drag → live; release = one undo step. Escape closes the popover only; the selection stays. |
| 12 | Open DevTools (switch on), `Alt+Shift+click` the Fill swatch | — | The Explain tab names the control `fill.color`, its section `Fill`, HUD rank 1, the capability it runs, and the facts it read. |

### F-53 Export a multi-page design as print PDF and PNGs — **M1** (after C1; steps marked M2 need the engine follow-ups)
Blocks: Dialog (routable, wizard step `advanced`), Switcher (single and multi), page-range picker (listbox), disabled
reasons, progress row, background toast, section error, memory per design, deep link. Precondition: a design `Night
market` with 5 pages at 1 080 × 1 080, one loose element on the mist, the folder mirror on.

| # | Pointer | Keyboard | Visible result |
|---|---|---|---|
| 1 | Top bar `Export` | `Mod+Shift+E` | The dialog `Export` (URL `/s/<asset>/d/export`, pushed): What `Page · Selection · Pages` on `Page` (`Page 1 · Post · 1 080 × 1 080`), Preset `Current size · Screen 2× · Social post` (the page is 1 080 × 1 080) with `Screen 2×` selected, Format `PNG · PDF · SVG` on PNG, Scale `1× · 2× · 3×` on 2× with `2 160 × 2 160 px` under it, the line `Night market.png`, the loose line `1 element outside the pages won't be exported. · Export selection instead`, the preview card with `2 160 × 2 160 px · about 1.4 MB`, footer `Reset to defaults · Cancel · Export PNG`. Focus is on `Export PNG`. The `Selection` chip is disabled; its tooltip reads `Selection · Select something on the canvas first`. Nothing says "coming soon"; no JPG, no Print chip. |
| 2 | `Pages` | `→` ×2 | The picker: five 72 px thumbnails (or format chips before the projection lands), all checked, `5 of 5 pages`, `All · None`. Uncheck pages 2 and 4 → `3 of 5 pages`; the name line reads `Night market - 01…05.png (3 files)` and the primary `Export PNG`; URL `?scope=pages&pages=<p1>,<p3>,<p5>`. `None` → the primary is `aria-disabled` with tooltip `Export · Choose at least one page`; `All` restores. |
| 3 | `Mod+click` `PDF` | Tab to Format, `→` to PDF, Space | Both chips selected (`PNG, checked, 1 of 3` announced); the PDF rows appear under the PNG rows headed `PDF`, Kind `Standard` only (Print is M2 and not rendered); the name line `Night market.zip (PNG, PDF · 6 files)`; primary `Export 2 formats`. |
| 4 | `Advanced ▸` | Tab to it, Enter | The body slides left 160 ms; back chevron and title `Advanced`; URL `?step=advanced`; rows `Transparent background` (off), `File name` (placeholder `Night market`), `Zip several files` (on), `Remember for this design` (on); footer `Back · Done`, no Export. Switch Transparent on → the preview's checkerboard shows when back on the main step; the Advanced row summarises `Transparent`. |
| 5 | `Done`, then `Export 2 formats` | Enter, Enter | The footer becomes the progress row `Rendering page 1 of 5` with `Cancel`; the options dim (`aria-busy`); the live region announces at page boundaries; then `Exporting PDF · 2 of 2 formats`, `Writing PDF`. On success the dialog closes (`history.back()`), focus returns to `Export`, toast `Exported Night market.zip · Show in folder` (8 s). The zip holds `Night market - 01.png`, `- 03.png`, `- 05.png` and `Night market.pdf` (5 pages, selectable text). Milestones unchanged (D10). |
| 6 | `Export`, then Escape during `Rendering page 2 of 5` | `Mod+Shift+E`, Enter, Escape | The dialog closes; the sticky toast `Exporting Night market.zip… · Cancel` continues; it becomes `Exported … · Show in folder`. Press `Cancel` instead on a second run → the toast leaves, no file, no further toast. |
| 7 | Page label menu on page 3 › `Export this page…` | `Shift+F10` on the label, arrows, Enter | The dialog on `Page` locked to `Page 3 · Post`, URL `?scope=page&page=<p3>`; formats still PNG + PDF and Transparent on (remembered per design). `Reset to defaults` → `Screen 2×` of the page, PNG only, `Defaults restored` inline for 1.5 s. |
| 8 | Select two shapes, context menu › `Export selection…` | `Shift+F10`, `e` typeahead, Enter | The dialog on `Selection` (`2 elements · 640 × 420`), no loose-elements line, name `Night market - selection.png`. |
| 9 | Set `3×` on a 6 000 × 6 000 page (test fixture) | — | The `3×` chip is disabled with tooltip `3× · Too large for this device (max 16 384 px)`; the test then forces `SF-SURF-013` at 2× → section error above the footer `Couldn't render at 2× · Export at 1×`; the fix button sets 1× and re-runs; no banner, no toast while the dialog is open. |
| 10 | The test terminates the export worker mid-run | — | Section error `Couldn't export 'Night market.png' · Try again` (F-50 step 6); `Try again` re-runs; the editor keeps working behind the dialog. After the dialog was closed, the same failure is a danger toast with `Try again` instead. |
| 11 | Open `/s/<asset>/d/export?scope=pages&pages=<p1>,<deleted>&format=pdf` in a new tab | — | Studio renders, then the dialog on `Pages` with page 1 checked only, PDF selected; no toast (partly unknown); with every id unknown: all pages and the toast `Those pages are no longer in this design`. Escape **replaces** the URL with `/s/<asset>`. |
| 12 | (M2, after the engine follow-ups) Preset `Print A4` on an A4 design | — | PDF · Print, `Bleed 3 mm`, `Crop marks` on; the preview shows the marks outside the page; the PDF's TrimBox is the page. Not rendered in M1. |

**Quick-export variant (M1):** with a design exported before on this device, `Mod+Shift+E`, Enter exports with the
remembered settings; the dialog is visible for the duration of the progress row and closes on success with the toast.
Two keys, no pointer, no chooser; a stray `Mod+Shift+E` alone downloads nothing.

## F. Product basics (2026-10-25 gap pass)

### F-54 New design with a custom size — **M1 must-pass**
Blocks: New design dialog (HOME-FILES §1.3), size field pair, presets menu, orientation switcher, routable `/new`.

| # | Pointer | Keyboard | Visible result |
|---|---|---|---|
| 1 | Home `＋ New design` | `Tab` to it, Enter | The New design dialog (URL `/new`): Formats chips with `Post` pre-selected (first run), Size pair `1 080 × 1 080 px` with lock off, orientation `▯`, `Units ▾ px`, `Presets ▾`, `Start from ▾ Blank`, Name `Untitled design` selected, `More ▾` folded, footer `Cancel · Create`. |
| 2 | Click `Custom`, type W `1200`, Tab, `628` | arrows to `Custom`, Tab, type | The Size pair reads `1 200 × 628 px`; no chip selected but `Custom`; `Create` stays enabled. |
| 3 | Click `▭ · ▯` orientation | Tab to it, Space | W/H swap (`628 × 1 200`) with a 120 ms animation; press again to swap back. |
| 4 | `Presets ▾ › Link preview 1 200 × 628` | Enter, arrows, Enter | The pair fills; the menu names the preset in mono. |
| 5 | Type W `20000` and Tab | — | Inline error `Too large for this device (max 16 384 px)`; `Create` focuses the field when pressed. Fix to `1200`. |
| 6 | `Units ▾ mm`, type `210 × 297` | — | Fields show one decimal mm; the hint reads `794 × 1 123 px`; A4 chip becomes selected (same size within 1 px). |
| 7 | `Create` | `Mod+Enter` | Studio at `/s/<id>` with one page `Page 1 · Custom · 1 200 × 628` (label), inspector Page › Size showing the same pair, title focused. `/new` is replaced in history. |
| 8 | Home header `▾ › Custom size…` | — | The dialog on `Custom` with W focused; `Start from ▾` lists a saved template; choosing it sets and locks the size with the hint `Template size`. |
| 9 | In Studio, nothing selected, Page › Size `Presets ▾ › Story` | — | The page card resizes to 1 080 × 1 920; elements keep positions (F-15 step 7); Export's preset row now shows `Social story`. |

### F-55 Import from Home and Studio — **M1** (SVG/`.iflow` steps after C2)
Blocks: drop targets, importer (HOME-FILES §3.1), progress row, question toast, Assets rows, dedupe.

1. Drag two JPEGs onto Home → the page column outlines tangerine while dragging; on drop a toast `Imported 2 images ·
   Show in Files · Undo`; Files › Media lists both; dropping the same files again adds nothing (rows highlight). 2.
   Drag a folder of 12 mixed files onto a project card → `Importing 12 files · 4 of 12 · Cancel`, then `Imported 9
   files · 3 skipped (unsupported) · Details`; the images carry the project. 3. In Studio, drop a PNG on the canvas →
   placed at the drop point, selected, a new Assets row; drop three → a 24 px stack, all selected. 4. `Mod+I` in
   Studio → the picker; pick a `.ttf` → the font appears in the font picker under `In this workspace`. 5. Drop a PDF on
   Home → `Imported 'brief.pdf' as 4 image pages · Open`; Open shows four pages at the PDF's size, each one image. 6.
   (after C2) Drop an `.iflow` on the Studio canvas → toast `Open 'Night market' as a new design · Open · Add its
   pages here`; `Add its pages here` appends its pages after the current one, one undo step `Import pages`. 7. Drop
   a `.mov` in M1 → `Couldn't import 'clip.mov' · Video arrives with the Timeline lens`. 8. Every import announces
   once; `Undo` on an import toast moves the items to trash.

### F-56 Find and replace across pages — **M1**
Blocks: find bar (STUDIO §9.1), Kind menu, Replace disclosure, font picker, colour swatch, toast with Undo.

| # | Pointer | Keyboard | Visible result |
|---|---|---|---|
| 1 | `⋯ › Find…` on a 5-page design | `Mod+F` | The find bar under the top bar, field focused, `Kind ▾ Text`, `Scope ▾ All pages`, count empty. |
| 2 | Type `market` | — | Count `1 of 6`; every match outlined sunflower on the canvas and in Layers; the first is selected and the camera zooms to it. |
| 3 | Enter ×2, Shift+Enter | — | Steps forward twice (camera follows across pages), then back; the count follows; `Match 3 of 6: Headline on Page 2` announced. |
| 4 | `Replace ▾`, type `Market`, `Replace all` | `Mod+Alt+F` opens expanded | Six replacements; marks kept (bold stays bold); toast `Replaced 'market' with 'Market' · 6 · Undo`; one undo step. |
| 5 | `Kind ▾ Font`, pick `Fraunces`, Replace with `Inter`, `Replace all` | — | Every Fraunces text element listed and outlined; after Replace all a toast `Replaced Fraunces with Inter · 14 elements · 2 weights substituted · Undo`. |
| 6 | `Kind ▾ Colour`, pick the tangerine document colour | — | Fills, strokes, text colours and a page background using it are matched (`9 of 9`); `Replace with a token ▾` appears when a kit exists; replace with cream → all nine change, one undo step. |
| 7 | Lock one element, run a replace | — | It is counted `1 locked, skipped` and stays. |
| 8 | Escape | Escape | The bar closes; the current match stays selected; `Mod+G` is Group again. |

### F-57 Learn the shortcuts — **M1**
Blocks: cheat sheet dialog (STUDIO §2.3.1), search field, platform switch, routable Settings section.

1. `?` in Studio → the dialog `Keyboard shortcuts` (URL `…/d/settings?section=shortcuts`, pushed), search focused,
   platform switch on the person's OS, cards Tools · Selection · Edit · Arrange · Transform · Text · View · Studio.
   2. No row for Pen (not built), none for keys 2–4, none for DevTools (off). 3. Type `group` → rows filter to Group,
   Ungroup, Frame selection with highlighted text. 4. Hover `Rectangle · R` → the Shape tool in the picker behind the
   dialog highlights. 5. Switch to `Windows` → `⌘` becomes `Ctrl`, `⌥` becomes `Alt`. 6. `Print` → a one-page
   print preview with no chrome. 7. Escape → closed with `history.back()`; `?` on Home opens `/settings/shortcuts` as
   a page; in Pro both platform columns show at once.

### F-58 Switch density mode — **M1 must-pass**
Blocks: View menu, `Mod+.`, rails, floating panels, split dock, disclosure memory, tokens (DENSITY-DISCLOSURE).

| # | Pointer | Keyboard | Visible result |
|---|---|---|---|
| 1 | New design (Standard) | — | Dock docked on Layers, inspector docked with Page sections, no rulers, lens switcher visible, `Milestone` in the bar. |
| 2 | Select a rectangle; collapse `Effects`; add a shadow via `Effects ▸` then collapse again | — | The collapsed heading shows the summary `Shadow`. |
| 3 | `View ▾ › Density › Focus` | `Mod+.` | Regions animate 160 ms; the page does not move on screen. Dock and inspector are 44 px rails; the lens switcher is **hidden** (`1`/`5` still work); `Milestone` moved into `⋯`; the toast `Focus · Just your work.` (keyboard path only). |
| 4 | Click the inspector rail's Fill icon | — | A floating 264 px card with **only** the Fill section over the canvas; click the canvas → it leaves. |
| 5 | `Mod+.` | `Mod+.` | Standard again; the Effects section is still collapsed with its summary (memory per section). |
| 6 | `Mod+.` | `Mod+.` | Pro: rulers on; inspector sections **all open** including Effects and the pivot row (no `More ▾`); rows 26 px; eye and lock always visible in Layers; dock split in two panels; undo label in the top bar; tooltips gain a description line. |
| 7 | `Mod+\` in Pro | `Mod+\` | The dock hides; `View ▾` shows `Show dock` unchecked; switching to Standard and back to Pro restores the hidden state (override remembered per mode). |
| 8 | Open Settings › General | — | Density radios with the three-frame preview strip and one-liners; the current one checked. Reload → the mode is kept (per device). |
| 9 | Open Home in Pro | — | The hero is one 44 px row of chips; Files defaults to list view with visible checkboxes and sortable column headers. |

### F-59 First run — **M1 must-pass** (extends F-01 step 1)
Blocks: welcome card (HOME-FILES §1.4), `persist()` on a gesture, seen store, hints.

1. Fresh profile, open `/` → the hero, the formats row with the line `Pick a size to start. You can change it later.`,
   and the welcome card `Your designs live on this device` with one button `Keep my designs on this device`; no
   sign-in, no tour, no sample design. 2. Press the button → `navigator.storage.persist()` is requested; the card
   becomes `Saved on this device · Settings`; if refused: `Chrome may clear this workspace under storage pressure · Pin
   this site`. 3. Reload → the card and the line are gone; Settings › Storage shows the persistence state. 4. Settings ›
   General › `Reset hints` → the next Home visit shows the card again. 5. The forbidden-text test passes on the first-run
   Home.

## G. Text and fonts (2026-10-25 text pass; spec `TEXT-FONTS-UX-SPEC.md`)

### F-60 Create text: click, drag, boxes and overflow — **M1 must-pass** (fixed-box steps after T-1)
Blocks: Text tool and its presets menu, handles on text, overflow tag, Auto-size switcher, Fit to box.

| # | Pointer | Keyboard | Visible result |
|---|---|---|---|
| 1 | `T`, click on the page | `T`, Enter | An auto-width element in edit mode: caret, placeholder `Type something` in mist, the pill `Font ▾ · Size · Colour · B · Align ▾ · Delete · ⋯` above; inspector Text section with `Style ▾ Body` (the document default), `Auto-size` reading `Auto width` with its `W` muted. |
| 2 | Type a long sentence | — | The box grows to the right; no wrap; Layers shows the first words as the name. |
| 3 | Drag the right side handle to 300 px | — | `Auto-size` reads `Auto height`; the text wraps; the box's height follows. |
| 4 | Drag a corner handle | — | The font size scales (`Size` pill `20 → 31`), one undo step `Resize text`. |
| 5 | Drag the bottom handle up over the text (after T-1) | — | `Auto-size` reads `Fixed`; the hidden lines are drawn below the box and the tag `⤓ 2` appears at the bottom-right; tooltip `2 lines don't fit · Fit to box`. |
| 6 | Click the tag | — | Sizes shrink to fit; the tag disappears; one undo step `Fit to box`. `Vertical ▾ Middle` centres the text in the box. |
| 7 | Long-press `T`, choose `Heading 1`, click | `Shift+T`, arrows, Enter, Enter | New text with `Style ▾ Heading 1`, 48 px 700; the pill chip reads `Heading 1`. |
| 8 | Escape with nothing typed | Escape | The empty element is removed; undo has no extra step. |
| 9 | Double-click a rectangle with no text | select it, Enter | A centred text appears inside it, grouped, in edit mode; one undo step `Add text`. |

### F-61 Mixed styles in one text — **M1 must-pass**
Blocks: selection gestures, typing style, Mixed states in pill and inspector, Weight menu, Clear formatting.

1. Type `Spring sale this week`; double-click `sale` → the word is selected (not its space); `Mod+B` → bold; the pill's
   `B` is pressed. 2. Triple-click → the paragraph; the pill's `B` shows the **indeterminate dash**, `Weight ▾` reads
   `Mixed` and its menu ticks `Bold` and `Regular`; `Size` still reads `20` (same everywhere). 3. Type `32` in `Size` →
   every run is 32, bold stays where it was. 4. Press `B` once → the whole paragraph is bold (mixed → on); press again →
   none bold. 5. Place the caret after `week`, press `Mod+I`, type ` only` → the new letters are italic (typing style);
   press → the pill's `I` in More shows pressed while the caret is there; move the caret left → it clears. 6. Select
   `this week only`, `Mod+K`, paste a URL, Enter → underlined blue link; Escape; hover → tooltip with the URL;
   `Mod`-click opens it. 7. Select all, `Mod+\` → every character mark gone, the paragraph alignment kept; undo
   restores in one step. 8. Select two text elements → the pill shows `Font ▾ · Size`; the inspector Size reads
   `Mixed`; typing `24` sets both; one undo step.

### F-62 Replace a missing font — **M1**
Blocks: fallback rendering, hatched `Font ▾`, top-bar tag, Missing fonts dialog, Local Font Access auto-match, toast
with Undo.

| # | Pointer | Keyboard | Visible result |
|---|---|---|---|
| 1 | Import an `.iflow` whose text uses `Fraunces` without its font file | — | The design opens; the text renders in the fallback family; the top bar shows the tag `1 font missing`; no banner, no dialog. |
| 2 | Select the headline | — | `Font ▾` reads `Fraunces` in Geist on a hatched chip; tooltip `Fraunces is missing on this device · Replace…`; `Weight ▾` disabled with the reason. |
| 3 | Click the tag | `⋯ › Missing fonts…` | Dialog `Missing fonts` with one row: `Fraunces · used in 14 elements · 2 weights`, `Replace with ▾`, `Upload…`; when Local Font Access is granted and Fraunces is installed, the row's first action is `Add from this computer`. |
| 4 | `Replace with ▾`, pick `Inter` | arrows, Enter | All 14 elements re-render in Inter; toast `Replaced Fraunces with Inter · 14 elements · 2 weights substituted · Undo`; the tag disappears; one undo step. |
| 5 | Undo; `Upload…`, pick `Fraunces.ttf` | `Mod+Z` | The elements return to the fallback with the tag; after upload every element re-lays out in Fraunces; toast `Fraunces found · 14 elements updated`. |
| 6 | Export PNG | `Mod+Shift+E` | The preview shows exactly the canvas (fallback or Fraunces); after T-20 the result line lists substitutions. |

### F-63 Add a font: upload, this computer, library — **M1**
Blocks: font picker footer, Fonts on this computer dialog, permission flow, licence notice, download states.

1. Select text, `Font ▾` → picker with chips `All · Sans · …`, groups Recent · In this design · Library; hover rows →
   the headline previews each family; Escape → restored. 2. Type `mono` → the Mono category and matching names; Enter →
   `Geist Mono` applied, one undo step `Font`. 3. A library row with the download glyph → click → progress ring ≤ 1 s →
   applied; offline the row is muted with `Needs a connection`. 4. `+ Add fonts ▾ › Upload font file…`, pick a `.ttc` →
   toast `Added Fraunces · 6 styles`; the picker opens filtered to it; `Weight ▾` lists the six real faces and, under a
   hairline, no synthetic rows (all exist). 5. Upload a `.woff` → toast `'brand.woff' isn't a font Instaflow can use ·
   Use .ttf, .otf or .ttc` (until T-7). 6. `+ Add fonts ▾ › Use fonts on this computer…` → Chrome's prompt; allow →
   dialog `Fonts on this computer` with search and checkboxes and the one-sentence licence notice; tick two, `Add 2
   fonts` → progress → they appear under **Your fonts**. 7. Deny the prompt → the picker shows the inline row `Chrome
   blocked access to your fonts · Allow in site settings · Upload a file instead`. 8. In Firefox the footer has no
   `Use fonts on this computer…` row at all.

### F-64 Text fidelity to export — **M1** (after C1)
Blocks: one layout pipeline, greeking, caret over transformed text, Export preview, D21 metric.

1. A headline in `Fraunces Bold 64` with an Arabic word and a `Noto Sans Devanagari` fallback run; rotate it 20°,
   skew 10°. 2. Double-click → the caret is rotated and skewed with the text, blinks, stays ≥ 1 px; drag-select → the
   selection rects follow the lines; the IME candidate window (owner check) sits at the composition. 3. Zoom to 10 % →
   the text is greeked (grey bars), never missing; zoom back → sharp within 3 frames. 4. Zoom to 25 % and double-click a
   9 px caption → the camera glides until the line is ≥ 12 screen px; Escape → the camera returns. 5. Export PNG 2× →
   pixel-identical glyph shapes to the canvas (GPU/CPU golden thresholds); PDF → the text is selectable and searchable
   (`Fraunces` appears as Type 3 with ToUnicode), copying it yields the typed string including the Arabic word; SVG →
   paths labelled with the text. 6. Pick a synthetic `Bold` on a single-weight font → canvas and PDF show the same faux
   stroke. 7. Make a fixed box overflow → the export shows the overflow exactly as the canvas does, tag excluded.

## H. Appearance, transforms and structure (2026-10-25 appearance pass; spec `APPEARANCE-TRANSFORM-UX-SPEC.md`)

### F-65 Gradient fill: edit in the popover and on the canvas — **M1 must-pass**
Blocks: Fill stack rows, colour popover tabs, gradient strip, on-canvas gradient handles, document gradients, undo labels.

| # | Pointer | Keyboard | Visible result |
|---|---|---|---|
| 1 | Select a tangerine rectangle, click the HUD Fill swatch | `Alt+Enter`, Enter on the swatch | The colour popover opens on `Solid` with `#FF5C39`, the contrast tag against the page (`AA 4.9 : 1`), Document colours, Palette, Recent. |
| 2 | Click the `Gradient` tab | arrow to the tab, Enter | The fill becomes a two-stop linear gradient: tangerine → transparent at 0°; the strip shows two stops; the canvas shows two round handles on a tangerine line across the rectangle; the Fill row reads `Linear · 2 stops · 0°`; one undo step `Fill kind`. |
| 3 | Click the strip at 60 % | Tab to the strip, `+` | A third stop appears with the interpolated colour, selected (tangerine ring); the Stop row shows its hex; `Position` reads `60 %`. |
| 4 | Pick `#FFC23D` for it from the Palette | arrows, Enter | The canvas and the strip update live; one undo step `Gradient`. |
| 5 | Drag the canvas end handle with Shift | type `45` in `Angle`, Enter | The angle snaps to 45°; `Angle` reads `45°`; the handles rotate about the midpoint. |
| 6 | Press `Reverse ⇄` | Tab, Enter | Stops mirror; the strip and canvas agree. |
| 7 | Switch the type to `Radial` | arrows | A centre handle and a radius handle replace the line; the row reads `Radial · 3 stops`; stops kept. |
| 8 | Select a second rectangle, open its Fill swatch › Gradient | — | The `Document gradients` row shows the first gradient; click it → applied with this rectangle's own geometry; one step `Fill`. |
| 9 | Press `☆` on the gradient | — | It joins the `Saved` row (a square thumbnail); it is there in another design on this device. |
| 10 | Escape | Escape | The popover closes, the handles go, the selection stays; `Mod+Z` three times walks back `Fill`, `Reverse gradient`, `Gradient` with labels in the Pro top bar. |

### F-66 Image fill with crop — **M1** (crop steps after A-3)
Blocks: Fill `+ Add ▾ Image…`, Assets picker, Fit ▾, crop mode, image ratio-by-default, missing-asset row.

1. Select a rectangle, Fill `+ Add ▾ Image…` → the Assets picker (recent first) or a file dialog; pick a photo → a new top
   row `Image · Fill` with the photo as its thumbnail; the HUD swatch shows the photo. 2. Row second line `Fit ▾ Fit` →
   letterboxed; `Tile` → repeated; back to `Fill`. 3. Drag the rectangle's corner → the **rectangle** keeps ratio by default
   (it is image-filled); Shift frees it; tooltip `Drag to scale · Shift for free`. 4. (after A-3) Double-click → crop mode:
   the image shows at 40 % outside the box with its own eight handles; drag inside to pan, drag a handle to scale, pill
   `1 920 × 1 080 · 142 %`; Enter commits one step `Crop`; Escape cancels. 5. `Replace…` with a photo of another ratio → crop
   reset, 1.5 s toast `Crop reset · new image ratio`. 6. Set the row opacity to 60 % and add a `Colour` row **under** it in
   white → a wash; collapse Fill → summary `2 fills`. 7. Paste the rectangle into a design on a device that lacks the asset
   → the row is hatched `Image not available on this device · Replace…`; the canvas shows a mist box with the name.
   8. `Mod+Alt+C` on it, select three other shapes, `Mod+Alt+V` → all three carry the two fills; one step `Paste style`.

### F-67 Page background: colour, gradient, image — **M1** (gradient and image steps after A-1)
Blocks: Page section fill stack, page label HUD, `Apply to all pages`, Export `Transparent`, `Use as page background`.

| # | Pointer | Keyboard | Visible result |
|---|---|---|---|
| 1 | Click empty canvas | Escape | The inspector shows **Page**: Name, Size pair, `Background` stack with one row `#FFFFFF`. |
| 2 | Click the row's swatch, pick `#F1F4F7` | Enter on the swatch, arrows | The page card turns mist; the Pages thumbnail follows; one step `Page background`. |
| 3 | (after A-1) `+ Add ▾ Gradient ▸ Linear` | — | A gradient row on top; the popover opens on `Gradient`; pick `Dusk` → the whole page fades; handles span the page. |
| 4 | (after A-1) `+ Add ▾ Image…`, pick a photo, `Fit ▾ Fill` | — | The photo covers the page under nothing else; set its opacity to 40 % → the gradient under it shows through. |
| 5 | (after A-1) Page label menu › `Crop background` | — | Crop mode on the page's image (as F-66 step 4); Enter. |
| 6 | Page `More ▾ › Apply to all pages` | — | Every page gets the stack; toast `Background applied to 5 pages · Undo`; one step. |
| 7 | Right-click a photo element › `Use as page background` | `Shift+F10`, arrows | A confirm row in the pill `Replace the background and remove this image · Replace`; confirm → the page's stack is the photo, the element is gone; undo restores both. |
| 8 | `Mod+Shift+E`, Advanced › `Transparent` | — | The preview drops the page's stack (PNG alpha); the Pro line of the Page section reads `Export: transparent`. |

### F-68 Effects, bevel and layer blend — **M1 must-pass**
Blocks: Effects stack preset menu, row second lines, Bevel preset rows, `From brand ▸`, Layer section, Mixed effects.

1. Select a rectangle, expand ▸ Effects, `+ Add ▾ Shadow ▸ Soft` → a row `Shadow · 0 4 16 · 16 %`; the section's collapsed
   summary reads `Shadow · Soft`. 2. Click the summary → the second line: scrub `Y` to 12, `Blur` to 24, click the colour
   swatch → the popover (Solid only, no Image tab), set alpha 30 %. 3. `+ Add ▾ Bevel ▸ Soft bevel` → two inner rows tagged
   `Bevel`; remove one with × → the tag disappears; undo. 4. `+ Add ▾ Blur ▸ Background blur`, set 20, lower the Fill
   opacity to 50 % → frosted glass over what is behind; the first-use hint explains. 5. Eye on the shadow → hidden row at
   50 %; drag the glow row above it → `Reorder effects`. 6. Layer ▸: slider to 50 %, `Blend ▾ Multiply` → summary `50 % ·
   Multiply`; `Alt+Shift+↑` → 60 %. 7. Select two shapes with different effects → `Mixed effects` row with `Replace all ▸`
   → `Shadow ▸ Hard` → both get it. 8. With a brand kit: `+ Add ▾ From brand ▸ @shadow-md` → the section header shows the
   token tag; `Detach` returns values. 9. Export PNG → identical; PDF → the Pro result line counts raster patches.

### F-69 Rotate, skew and flip numerically — **M1 must-pass** (extends F-04)
Blocks: Transform fields, expressions, rotate 90° buttons, skew field, flip toggles, pivot picker, Free transform.

| # | Pointer | Keyboard | Visible result |
|---|---|---|---|
| 1 | Select a shape; type `30` in ∠ | Tab to ∠, type, Enter | Rotates 30° about the pivot; the field reads `30°`; one step `Rotate`. |
| 2 | Type `+15` in ∠ | same | `45°`; the handle frame follows. |
| 3 | Hover ∠, click `↻ 90` | — | `135°`; label `Rotate 90°`. |
| 4 | Inspector `More ▾`, type `15` in ⟂ | Tab, type, Enter | The shape leans; `15°`; tooltip explains the horizontal lean; `Mixed` never appears for one element. |
| 5 | Mod-drag the **left** handle | — | A vertical lean: the fields show the decomposition (∠ and ⟂ both change) — honest to the model. |
| 6 | Click `Flip H` | `Shift+H` | Mirrored, including its gradient; the toggle is pressed; twice restores. |
| 7 | Pro: pivot picker → bottom-left dot; type `90` in ∠ | arrows in the radiogroup, Enter | Rotates about the bottom-left corner. |
| 8 | `Mod+Alt+T`, nudge, type `200` in W, `Shift+V`, Enter | same | One undo step `Transform`; Escape instead would cancel all three. |
| 9 | Select three shapes; type `400` in W | — | The union scales to 400 wide, each shape proportionally; one step `Resize`. |
| 10 | Select an image, drag a corner | — | Scales with the ratio kept; with Shift it stretches. |

### F-70 Groups, frames, masks and booleans end to end — **M1**
Blocks: Group/Ungroup, Frame selection, enter/exit, select through, Combine ▾, Use as mask, Layers glyphs, lock scopes, hide.

1. Draw three shapes, `Mod+G` → `Group` in Layers with a chevron; the pill `Ungroup · Align ▾ · Duplicate · Delete`;
   the Layer ▸ summary. 2. Double-click → enters; a child is selected; breadcrumb `Group › Rectangle`; Escape twice leaves.
   3. `Mod+click` a child from outside → selected directly. 4. `Mod+Alt+G` on the group → `Frame` with clip on and no fill;
   the Frame section shows the one-line explanation once; `Clip content` off → children show outside with the hairline.
   5. Two overlapping shapes, `Combine ▾ Subtract` → a boolean group with the operation glyph in Layers; `Operation ▾
   Exclude` live; Enter → move an operand → the result follows; `Mod+E` → one path. 6. A photo over an ellipse (ellipse
   below), `Use as mask ▾ Clip` → F-12. 7. Lock the frame (`Mod+Shift+L`) → dashed frame, clicks pass through; Pro `Lock ▾
   Position only` → it cannot move but its fill swatch still edits. 8. (after A-2) Eye on a shape → gone from canvas and the
   Export preview; Layers `⋯ › Show all` returns it. 9. `Mod+]` on the bottom shape → it moves up one in Layers; `Mod+Alt+[`
   → to the back. 10. Rename the group `Hero` in Layers → the header and announcer say `Hero`.

### F-71 Build a component, place instances, override, detach — **M2** (after A-12)
Blocks: Create component, Assets › Components, instance pill, override dots, Reset ▾, Go to main, Detach, Swap ▾.

1. Select a card (frame with text and image), `Mod+Alt+K` → mint outline, ◈ in Layers, header `Component · Card`, a row
   in Assets › Components with a thumbnail; the hint `Drag it from Assets to place a copy that stays linked`. 2. Drag it
   onto the page twice → two instances with the ◇ icon and the chip `Instance of Card`. 3. Edit the second instance's
   headline → only it changes; the Text section's label shows an override dot; `Reset ▾` lists `Text`. 4. Try to delete the
   instance's image → refused with the pill line `Edit the main component to change its structure · Go to main`. 5. `Go to
   main`, set the corner radius to 24 → both instances follow; toast `2 instances updated`; the overridden headline stays.
   6. `Mod+Alt+B` on the first instance → a plain frame; the chip is gone. 7. `Swap ▾` on the second → pick another
   component → swapped; the headline override kept where names match. 8. Undo walks every step with labels.

### F-72 Snapping, rulers, align and distribute — **M1**
Blocks: smart guides, equal spacing labels, `View › Snapping ▸`, rulers, alignment popover, key object, tidy up.

1. Drag a shape toward another's edge → a tangerine guide and a distance tag; release → snapped exactly (X field shows
   it). 2. Drag a third into the row → equal-spacing ticks and labels; it snaps to the equal gap. 3. Hold `Mod` while
   dragging → no snapping; `Shift` → the move locks to one axis. 4. `View › Snapping ▸ Snap to elements` off → no guides;
   on again. 5. `Shift+R` → rulers with the selection's extent highlighted; right-click a ruler → `Units ▾ mm`; (M2, A-16)
   drag out a guide and snap to it. 6. Select three shapes, pill `Align ▾` → the popover; `Top`, then `Distribute H` → the
   popover stays open; `Align to: Page`, `Centre` → centred on the page. 7. Pro: `Alt+click` one of the three → key object
   (double outline), `Align to` reads `Key object`; `Left` → the others move to it. 8. Scatter five shapes roughly in a
   grid, `Ctrl+Alt+T` → tidy rows and columns; (M2, A-17) drag a gap handle → all gaps change. 9. Frame › `Layout grid ▸ +
   Add ▾ Columns 12` → the overlay (`Ctrl+G` toggles), dragging a child snaps to the column lines; export shows no grid.

## D. Coverage matrix (block → flows)

| Block | Flows |
|---|---|
| Button / Icon button / Tooltip | F-01, F-03, F-19, F-20, F-29 |
| Switcher / tabs | F-01, F-15, F-23, F-34, F-53 |
| Field / Scrubbable number / Colour / Slider | F-04, F-09, F-10, F-28, F-30, F-53 |
| Menu / Context menu | F-05, F-08, F-19, F-26, F-31, F-33, F-53 |
| Popover / Toast / Dialog | F-01, F-05, F-17, F-18, F-24, F-31, F-47, F-48, F-53 |
| Overlay layering / Escape order / light dismiss | F-47, F-48, F-52, F-53 |
| Banner / blocking error / progress | F-22, F-37, F-47, F-50, F-51, F-53 |
| Colour popover / font picker / HUD control model | F-09, F-10, F-52 |
| Deep links / copy link / fallbacks | F-47, F-48, F-49, F-51, F-53 |
| Export dialog (scope, presets, formats, memory, section errors) | F-02, F-18, F-50, F-53 |
| Disabled-with-reason (dialogs only) | F-53 |
| First-use hints | F-01, F-03, F-49 (suppressed) |
| DevTools | F-52 (step 12) |
| Tree (Layers, Pages, files) / Inline rename / Drag and drop | F-02, F-11, F-15, F-33, F-38 |
| Card | F-01, F-30, F-31, F-32, F-36, F-40 |
| Command palette | F-20, F-25 |
| Selection pill | F-01, F-19, F-27, F-46 |
| Handles and snapping | F-04 |
| Clipboard | F-06, F-07 |
| Keyboard map / Help | F-20, F-24 |
| Accessibility tree / announcer | F-21 |
| Empty / error states | F-22, F-37 |
| Coming pattern / forbidden text | F-19, F-23, F-24, F-53 (no JPG or Print chip in M1) |
| Lens model | F-23 |
| Settings | F-24, F-45, F-51 |
| Chat errors / long turns / no provider | F-51 |
| Size field pair / New design / custom size | F-54, F-53 (Export Size row), F-15 |
| Import (drop targets, question toast, PDF, fonts) | F-55, F-14, F-07 |
| Find bar / replace | F-56 |
| Cheat sheet | F-57, F-20 |
| Density modes / disclosure memory / per-mode overrides | F-58, F-24, F-28 |
| First run / welcome card / persist | F-59, F-01 |
| Text tool, boxes, overflow tag, presets | F-60, F-10, F-01 |
| Text selection gestures, Mixed states, typing style, links | F-61, F-10 |
| Font picker, add fonts (upload, this computer, library), licence notice | F-63, F-55 |
| Missing fonts tag and dialog | F-62, F-56 (Kind Font) |
| Text fidelity (caret over transforms, greeking, zoom to edit, export parity) | F-64, F-53 |
| Fill / Stroke / Effects stacks, colour popover tabs, gradient editor and canvas handles | F-65, F-66, F-68, F-09, F-52 |
| Image fills, crop mode, ratio-by-default, missing asset row | F-66, F-14 |
| Page background stack, apply to all pages, transparent export | F-67, F-53 |
| Effects presets, bevel, layer opacity and blend, Mixed effects | F-68, F-09 |
| Transform fields, rotate/skew/flip/pivot, Free transform, multi resize | F-69, F-04 |
| Groups, frames, booleans, masks, lock scopes, hide, z-order, rename | F-70, F-12, F-11 |
| Components and instances (M2) | F-71 |
| Snapping, rulers, guides, layout grids, align popover, key object, tidy up | F-72, F-04, F-08 |
| Copy / paste style, Select same | F-66, F-56 |
