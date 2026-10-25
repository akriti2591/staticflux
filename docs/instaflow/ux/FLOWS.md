# Instaflow flows (Layer 3)

> Status: **normative acceptance tests.** Every flow names what the person is trying to do, the surfaces it touches,
> the **building blocks** (FOUNDATIONS) it exercises, and each step's *visible* result, so a broken block shows up in
> every flow that uses it. Flows are not scripts tied to today's DOM: they state what must be observable, in order.
> Tier: **M1 must-pass** (the end-to-end suite, both worker topologies), **M1** (ships in M1, tested when its WP lands),
> **M2**. Pointer and keyboard paths are both given; a flow passes only when both do, unless a step says otherwise.
>
> Conventions: `Mod` = ⌘ / Ctrl. "Pill" = the selection pill. "Toast", "banner", "takeover" = `OVERLAYS-FEEDBACK.md`;
> URLs and fallbacks = `NAVIGATION-DEEPLINKS.md`. Fixture: a fresh workspace
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
Blocks: Handles (resize, rotate handle + zones, skew, pivot), size/angle pills, Scrubbable number, snapping guides.

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
Blocks: Inspector sections, Colour field popover, Scrubbable number, Slider, stacks.

1. Select a rectangle → inspector sections exactly `Transform · Fill · Stroke · ▸ Corners · ▸ Effects · ▸ Layer` (no
   Typography, no Repeat). 2. Click the Fill swatch → popover with hex, brand tokens, recents, opacity; type `#3D5AFE`
   → the shape turns blue on each keystroke; Escape restores, Enter keeps. 3. `+ Add` in Stroke → a 1 px stroke row with
   Width and Position ▾; set Position Outside → visible. 4. Expand Corners, scrub Radius to 24 → rounded; toggle
   per-corner, set TL 0. 5. Expand Effects, `+ Add` › Shadow → a shadow with offset/blur fields; eye hides it; × removes.
   6. Layer › Opacity slider to 50 % → the mono pill reads `50%`; Blend ▾ Multiply. 7. Select two shapes with
   different fills → the Fill row reads `Mixed`; pick a colour → both change. 8. Every change is one undo step with a
   label (`Fill`, `Stroke width`, `Radius`, `Shadow`, `Opacity`).

### F-10 Text, including IME — **M1 must-pass** (IME steps are the owner's manual check, TXT-10)
Blocks: Text tool, Selection pill (text), Inspector Text section, Field, EditContext.

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

1. Select an image over an ellipse (ellipse on top), pill `Use as mask ▾ › Clip` → the image is clipped to the ellipse;
   Layers shows a masked group; the pill shows `Mask mode ▾ · Invert · Release`. 2. `Invert` → the outside shows.
   3. `Release` → back to two elements. 4. Two overlapping shapes, `Combine ▾ › Subtract` → the result; `Operation ▾ ›
   Exclude` changes it live; `Flatten` → one path (Layers icon changes to path). 5. `Outline stroke` on a stroked shape →
   the stroke becomes a filled path. 6. Each is one undo step named after the action.

### F-13 Repeats — **M1**

1. Select a shape, pill `⋯ › Radial repeat` → 8 instances on a circle; the pill becomes `Radial · 8 · Count · Edit ·
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

1. `Export` (primary) or `Mod+Shift+E` → the dialog: format switcher PNG · PDF · SVG · .iflow, scale (1× 2× 3×),
   pages (All / Current / Selection), the loose-elements line when relevant, the "snapshot" sentence. 2. PNG 2× of the
   current page → a download `<title>-page-1@2x.png`, toast "Exported … · Show in folder" (folder mirror on) and the
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

## D. Coverage matrix (block → flows)

| Block | Flows |
|---|---|
| Button / Icon button / Tooltip | F-01, F-03, F-19, F-20, F-29 |
| Switcher / tabs | F-01, F-15, F-23, F-34 |
| Field / Scrubbable number / Colour / Slider | F-04, F-09, F-10, F-28, F-30 |
| Menu / Context menu | F-05, F-08, F-19, F-26, F-31, F-33 |
| Popover / Toast / Dialog | F-01, F-05, F-17, F-18, F-24, F-31, F-47, F-48 |
| Overlay layering / Escape order / light dismiss | F-47, F-48, F-52 |
| Banner / blocking error / progress | F-22, F-37, F-47, F-50, F-51 |
| Colour popover / font picker / HUD control model | F-09, F-10, F-52 |
| Deep links / copy link / fallbacks | F-47, F-48, F-49, F-51 |
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
| Coming pattern / forbidden text | F-19, F-23, F-24 |
| Lens model | F-23 |
| Settings | F-24, F-45, F-51 |
| Chat errors / long turns / no provider | F-51 |
