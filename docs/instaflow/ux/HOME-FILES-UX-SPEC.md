# Instaflow Home, files and projects — UX specification (Layer 2)

> Status: **normative for M1 Home and file management** (M1-BRIEF §5). Composes `FOUNDATIONS.md` (principles,
> vocabulary, the **Card**, **Tree and list**, **Menu**, **Inline rename**, **Toast**, **Drag and drop**, **Empty
> states** and **Command palette** blocks) and only states Home's arrangement and behaviour. Settings is specified in
> `STUDIO-UX-SPEC.md` §2.4 and reached from both surfaces. Flows: `FLOWS.md` F-30…F-38. Design source:
> `docs/instaflow/design/HomeCP.dc.html`.

## 1. What Home is

Home (`/`) is the light surface (D17: no engine, no GPU) where a person finds, starts and manages designs. It answers
three questions in this order: **what do I want to make** (hero + formats), **what was I doing** (Jump back in), **where
is everything** (Files, projects, templates, trash). Everything Home does is a capability (D18), so the same operations
run from cards, menus, the keyboard and, later, agents.

Layout (HomeCP): a 64 px header with the logo slot, the nav switcher and `＋ New design` (primary, right); a 1180 px
centred column; sections with Bricolage 800 24 px headings; cards 18 px; 4-column grids at ≥ 1180 px, 3 at ≥ 900, 2
below.

### 1.1 Header and navigation (M1)

| Slot | Content |
|---|---|
| Logo slot | 28 px logo + `instaflow` wordmark (link to `/`) |
| Nav switcher | `Home` · `Files` · `Templates` · `Trash` (M2 adds `Chats` and `Brand kits`; hidden until built) |
| Search | A 36 px field (`Search designs`, `/` focuses it) that filters every list live and, on Enter, opens Files with the query. |
| Settings | A ghost icon button (`settings`) → `/settings` (STUDIO-UX-SPEC §2.4) |
| New design | Primary 34 px, `＋ New design` → `/new` (default format) with a ▾ half for the format menu |

### 1.2 Home (`/`) sections, in order

1. **Hero.** Bricolage 72 px `Make something bold today` with the tangerine highlight (HomeCP). **M1:** under it, the
   line "Open a blank canvas, or start from a template." and a row of **format cards** (Post 1080², Story 1080 × 1920,
   Landscape 1920 × 1080, Poster A4 / Letter, Slide 16:9, Custom…) — each a secondary button with the lens square;
   click → `/new?format=`. **M2:** the assistant composer from HomeCP replaces the line (CHAT-UX-SPEC §2), and the
   format row stays under it.
2. **Quick actions.** The D18 capability cards (one per format in M1 as C0 built; M2 adds Remove background, Resize for
   socials, …). A card is a real link.
3. **Jump back in.** The 8 most recently edited designs as cards: 158 px thumbnail (18 px corners; a cover rendered by
   Studio's projection when it lands; until then the format chip on a mist card), the lens tag top-left, title (600),
   meta line `Edited 2 min ago · 3 pages`. Hover shows a `⋯` menu button top-right (§3). A design opened from here
   opens Studio.
4. **Templates.** Workspace templates (kind `template`) as cards with a `Template` mist tag and the primary action
   `Use` (creates a design, opens Studio). `⋯`: Rename, Duplicate, Move to project, Move to trash, Edit template
   (opens the template itself in Studio).
5. **Projects.** Project cards (`folder` icon, name, count, last edited) + `＋ New project`. Opening one shows the
   project view (§2).

Empty states (one card, one sentence, one action): no designs → the hero only, with "Your designs will appear here."
under Jump back in; no templates → the Templates section is hidden; no projects → "Group designs into projects" with
`＋ New project`.

### 1.3 New design (`/new`): sizes, presets and custom size

`＋ New design` (header), a format card, `/new?format=` or the palette open the **New design** popover-dialog: a 520 px
form dialog (routable `/new` on Home; it is the Home page's only dialog) that creates and opens Studio in one step.
Departure from Canva (a wall of templates before a blank page) and Figma (an empty file, size chosen later): Instaflow
asks the one question that cannot be undone cheaply, **the page size**, and nothing else.

| Row | Contents | Behaviour |
|---|---|---|
| **Formats** (presets row, visible in every mode) | Chips with the lens square: `Post 1 080 × 1 080` · `Story 1 080 × 1 920` · `Landscape 1 920 × 1 080` · `Slide 16:9 1 920 × 1 080` · `Poster A4` · `Letter` · `Custom`. The last used format is pre-selected; `Custom` is pre-selected when the last design was custom. | Choosing a chip fills the Size pair; editing the pair selects `Custom`. |
| **Size** (the **size field pair**, one block shared with Page › Size and Export) | `W` and `H` mono fields with a unit suffix; a **lock** icon button (ratio; off by default here); an **orientation** switcher `▯ · ▭` (swaps W/H, animates 120 ms); `Units ▾` (`px · mm · in · pt`, default from Settings; mm/in convert at 96 px/in for the canvas and are remembered as the page's display unit); a `Presets ▾` menu with the full list (social: Instagram post/story/reel cover, Facebook, LinkedIn, X, YouTube thumbnail, Pinterest; print: A3–A6, Letter, Legal, Tabloid, business card; screen: HD, 4K, iPhone, iPad, desktop; each with its size in mono). | Validation on blur: 1–16 384 px a side (`Too large for this device (max 16 384 px)` inline), integers for px, one decimal for mm/in. Enter in a field = `Create`. |
| **Start from** | `Start from ▾`: `Blank` (default) · the workspace's templates (with their size; choosing one sets the Size pair to the template's and locks it with a hint `Template size`) · `Last design` (copies the last design's page size and brand). | Templates whose size differs from a chosen chip replace the chip (the template wins; a muted line says `Uses the template's size`). |
| **Name** | `Untitled design` pre-selected (optional; Studio focuses it again if left). | — |
| `More ▾` | Pages (`1`, 1–50), Background (swatch, default white), Orientation lock, Units default. | Folded (DENSITY-DISCLOSURE §8.3). |
| Footer | `Cancel` · primary `Create` | Create → Studio at `/s/<id>` with the title focused (F-01 step 2); history replaces `/new`. |

The `▾` half of the header button is a menu with the same formats and `Custom size…` (opens the dialog on `Custom`
with W focused), so a returning person creates a Post in one click and a custom size in two. Keyboard: Tab order
Formats → W → H → lock → orientation → Units → Presets → Start from → Name → More → Cancel → Create; arrows move
among chips; `Mod+Enter` creates from anywhere. A11y: the chips are a `radiogroup` named `Format`; the size pair is a
`group` named `Size` with each field labelled (`Width in pixels`); the orientation switcher announces `Landscape`.
**Code:** `src/home/formats.ts` has five fixed formats and no custom size; **missing:** the size field pair as a kit
block (`<sf-size-field>`: W/H, lock, orientation, unit, presets slot — StaticFlux kit, generic), the New design dialog
(`src/home/new-design.ts`), `format=custom&w=&h=&unit=` query on `/new` (NAVIGATION §2.2, view), the preset table
(`src/home/size-presets.ts`), page size on `createDocument`.

### 1.4 First run

No tour, no questionnaire, no sample document (departure from Canva's onboarding quiz and Figma's tutorial file:
people learn by making; the owner's run showed Standard density teaches the model). The first visit to `/` differs
from every later visit in exactly these ways:

1. **One welcome card** replaces the empty Jump back in section: a white 18 px card, 760 px wide, Bricolage 20
   heading `Your designs live on this device`, one sentence (`Instaflow saves as you work, in this browser. Move them
   to a folder any time from Settings.`), and **one button** `Keep my designs on this device` (primary). Pressing it
   requests `navigator.storage.persist()` on the gesture (Chrome grants more readily with a gesture than at boot;
   GAP-AUDIT Q-E), then the card becomes a one-line status `Saved on this device · Settings` for the session and is
   gone on the next visit. If persistence is refused the card's line reads `Chrome may clear this workspace under
   storage pressure · Pin this site` (HOME-FILES §4). The card is dismissable (`×`); dismissed = seen.
2. **The formats row** carries a muted line under it, once: `Pick a size to start. You can change it later.`
3. **Studio's first open** runs F-01: Standard density, the title focused, first-use hints per tool (OVERLAYS §5), the
   Layers empty state teaching `R` and `T`.
4. **No accounts** (D3), so nothing asks for a sign-in, an email or a name. The guest identity is created silently.
5. **Unsupported browser**: the blocking screen instead of Home (OVERLAYS §3.1).

Seen state lives in `instaflow/ui/first-run` (per device). `Reset hints` in Settings › General also resets it, so the
owner can replay the first run. **Code:** **missing** (`src/home/first-run.ts`, the persist request in
`src/workspace/browser.ts` moved behind a gesture).

## 2. Files, projects and the model

### 2.1 Model

- A **design** is a library entry of kind `composition`; a **template** is kind `template`; media are `image` /
  `video` / `audio` / `font`. The library already holds title, tags, folder, favourite, trash state and renditions
  (`src/library/library.ts`: `rename`, `setFolder`, `setFavorite`, `trash`, `restore`, `LIBRARY_FILTERS`).
- A **project** is a **folder path** in the library (`entry.folder`, `/`-separated; `validateFolder`). Decision:
  **one level of nesting in M1** (projects only, no sub-projects); the data model allows deeper paths, the UI exposes
  one level so that Home stays flat and understandable (Canva's "Folders", Figma's "Projects"). Sub-folders are a
  later decision, not blocked.
- A project has no record of its own: it exists while at least one entry has that folder; an empty new project is
  kept in the Home index as `projects: [{ name, createdAt }]` until it gets a design (plumbing §5).
- **Recents** are not a place: Jump back in is a sort of all live designs by `editedAt`. A design is always in exactly
  one project or at the top level ("No project").
- **Favourites** (`setFavorite`) show a star on the card and a `Favourites` filter in Files.

### 2.2 Files (`/files`)

A full list of everything in the workspace, Files-app style:

- Toolbar: filter switcher `All · Designs · Templates · Media · Favourites` (over `LIBRARY_FILTERS`), project filter
  `Project ▾`, sort `Sort ▾` (Last edited, Created, Name A–Z, Kind), view switcher `Grid / List`, and the search field.
- **Grid** = the card from Home. **List** = 44 px rows: checkbox (appears on hover / selection), thumbnail 32 px,
  title, kind tag, project, edited, size (pages or px), `⋯`.
- **Bulk select:** click the checkbox, `Shift+click` range, `Mod+click` toggle, `Mod+A` all; a bottom action bar
  (pill, 44 px, slides up 160 ms) shows `3 selected · Move to project ▾ · Duplicate · Move to trash · ×`.
- Sort and filter persist per device.

### 2.3 Project view (`/p/:name`)

Header: back chevron, project name (Bricolage 24, click to rename), count, `⋯` (Rename, Delete project — designs go
to "No project", never to trash). Below: the same grid/list as Files, scoped. Drop zone: dragging a card from Home or
Files onto a project card or onto the project view's sidebar list moves it (a tangerine insertion highlight on the
target card, toast "Moved to Spring campaign · Undo").

### 2.4 Trash (`/trash`)

Rows with `Restore` and `Delete forever`, grouped by day, a line "Items are kept for 30 days" (the library's retention,
`TRASH_RETENTION_MS`), and `Empty trash` (confirm inline: "Delete 4 designs forever? · Delete · Cancel"). Trashed
designs do not appear anywhere else and cannot be opened; a direct URL to a trashed design shows the read-only banner
"This design is in the trash · Restore".

## 3. Every file operation

Operations live in **three places that always agree**: the card's `⋯` menu (hover or focus reveals it), the **context
menu** (right-click, `Shift+F10`) and the **keyboard** on a focused card. Studio's top bar title handles rename from
inside a document. Each operation is a capability (`instaflow/rename-design`, `instaflow/trash-designs`, …; plumbing §5).

| Operation | Where | Behaviour and feedback | Undo / conflicts |
|---|---|---|---|
| Open | click / Enter on a card | Studio opens (`/s/:asset`); modified clicks open a new tab | — |
| Rename | `⋯ › Rename`, `F2` / `Enter` on a focused title (Mac: `Enter` opens, `⌘⇧R` or the menu renames), double-click the title, Studio top-bar title | Inline field over the title (12 px corners, text pre-selected); Enter saves, Escape cancels; empty → "A name is required" inline. Title max 200 chars (`validateTitle`). | Undo via toast "Renamed to 'Spring sale' · Undo" (3 s). If the design is open in another tab, that tab's title updates (the index broadcast). |
| Duplicate | `⋯ › Duplicate`, `Mod+D` on a focused card | Creates `<title> copy` next to it (same project) from Latest, as "New document from milestone" of a fresh snapshot; the new card appears first with a 160 ms rise; focus moves to it. | Toast "Duplicated · Open · Undo" (undo = trash the copy). |
| Move to project | `⋯ › Move to ▾` (lists projects + `New project…` + `No project`), drag onto a project card, bulk bar | Card leaves the current list (fade 120 ms) unless the view shows all. | Toast "Moved to Spring campaign · Undo". |
| Favourite | `⋯ › Add to favourites`, star on hover | Star fills (tangerine). | Silent, toggle. |
| Move to trash | `⋯ › Move to trash`, `Delete` / `Backspace` on a focused card, bulk bar | No confirmation for ≤ 5 items; ≥ 6 asks inline in the bulk bar. Card fades out. | Toast "Moved 'Night market' to trash · Undo" (8 s). Restore from Trash any time within 30 days. An open design moved to trash from another tab shows the banner "This design was moved to trash · Restore" in Studio and becomes read-only. |
| Restore | Trash page, toast Undo | Returns to its project. | Toast "Restored · Open". |
| Delete forever | Trash page only | Inline confirm, then blobs are left to GC. | None; the copy says "This can't be undone." |
| Use template | `Use` on a template card, `⋯ › Use` | Creates a design in the current project, opens Studio with the title field focused. | The design is an ordinary design afterwards. |
| Save as template | Studio overflow | Toast "Saved as template · Open Home"; the template appears under Templates. | Trash it like any entry. |
| New project | `＋ New project`, `Move to › New project…` | Inline name field in a new card; Enter creates. | Delete project moves its designs to No project. |
| Rename / delete project | project header `⋯` | Inline. | Toast with Undo for rename; delete asks inline when the project has designs ("Keep designs, delete project? · Delete · Cancel"). |
| Export | `⋯ › Export…` | Opens Studio on the design with the Export dialog (C1). | — |
| Find | the search field, `/` | Filters live across titles, tags and project names; matches highlighted; "No results for 'flyer'" with `Clear`. | — |
| Import | header `⋯`-free: Files toolbar `Import` (secondary), drop anywhere on Home or Files, `Mod+I`, paste | §3.1 | per file, toast with Undo (trash) |

### 3.1 Import (Home and Studio)

One importer behind every entry; the entry decides only **where the result lands**. Departure: Figma imports only into
a file and Canva only into Uploads; here the same drop works on Home (library), on a project (library, in that
project), on the Studio canvas (library **and** placed) and on the Assets panel (library). Nothing is ever imported
twice (content hash dedupe, F-14).

| What is dropped / picked | Home, Files, project view | Studio canvas | Studio Assets panel |
|---|---|---|---|
| Images (PNG, JPG, WebP, GIF, AVIF, HEIC where decodable) | Media in the library (project = the one open); toast `Imported 3 images · Show in Files` | Library + **placed** at the drop point (several: a 24 px-stepped stack, all selected) | Library; the new rows highlight |
| SVG | **Before C2:** as an image. **After C2:** a `Vector` media entry; on the canvas: vector elements grouped | placed as above | library |
| `.iflow` | A **design** in the library (project = the one open), card appears first with a rise; toast `Imported 'Night market' · Open` | Opens a question row in a toast: `Open 'Night market' as a new design · Open · Add its pages here`; `Add its pages here` appends the pages after the current page (one undo step `Import pages`) | as Home |
| PDF | M1: a design with **one page per PDF page as a 2× raster image** (page size from the PDF), toast says so once: `Imported 'brief.pdf' as 4 image pages · Open` (GAP-AUDIT Q-G); M2: vector import | as `.iflow`'s question row | as Home |
| Fonts (TTF, OTF, WOFF2) | `Font` media; usable in the font picker under `In this workspace`; licence line in Settings › About lists them as "yours" | same, and the font picker opens filtered to it when a text element is selected | same |
| Video, audio | **M1:** refused with `IF-LIB-001` and the fix `Video arrives with the Timeline lens`; **M2:** media with proxies (IF-8.5) | — | — |
| A folder | Each supported file as above; unsupported ones counted in one toast `Imported 12 files · 3 skipped (unsupported) · Details` | — | — |
| Anything else (`.txt`, `.docx`) | Toast `Couldn't import 'notes.txt' · Images, SVG, PDF, fonts and .iflow files are supported` | same | same |

Behaviour: a drop target highlights with the tangerine outline while dragging (the whole page column on Home, the
project card, the canvas room, the panel); a progress row appears in Assets (Studio) or as a toast with a count on Home
for ≥ 2 s imports (`Importing 12 files · 4 of 12 · Cancel`); files over 100 MB ask inline once (`'video.mov' is 1.2
GB · Import · Skip`); quota failures follow §4. The browser's `Open with` (file handler, C2) opens `.iflow` directly in
Studio. Keyboard and a11y: `Mod+I` opens the picker anywhere; the drop zones are announced (`Drop files to import`);
every imported item is announced once. Undo: `Imported …` toasts carry `Undo` (moves the imports to trash) for 8 s.
**Code:** `src/library/ingest.ts` (images, dedupe), `src/library/library-panel.ts` (panel drop); **missing:** Home and
canvas drop targets (`src/home`, `src/app/studio-canvas.ts`), `.iflow`/SVG (C2), PDF rasteriser (pdf.js in a worker,
`src/library/pdf-import.ts`), font ingest + Local Font Access merge (`src/app/fonts.ts`), the question toast.

Conflicts: a rename or move that loses the head CAS (`IF-HOME-005`) retries three times, then shows "Someone else
changed this just now · Try again". Two tabs renaming the same design: last write wins, both show the final title.

## 4. Storage

- **Where:** documents in IndexedDB, blobs in OPFS (D8), per browser profile, this device only. Home's storage line in
  the footer reads `1.2 GB used on this device · Settings`. `navigator.storage.persist()` is requested on first run;
  if refused, Settings › Storage shows "Chrome may clear this workspace under storage pressure · Pin this site".
- **Open folder (D8):** Settings › Storage `Move workspace to a folder` (File System Access; Chrome only) and Home's
  footer link. After moving, the footer reads `Workspace: ~/Designs/instaflow`; the blob **folder mirror** keeps the
  folder in step (never on the ack path). Firefox shows `Back up workspace (.zip)` instead.
- **Open from a real folder:** Home nav `Files › Open folder…` picks a folder containing `.iflow` files or a mirrored
  workspace; designs appear with an `On disk` tag. (M1 after C2 import; the menu item is hidden before.)
- **Storage full:** when a write fails with quota (`SF-STORE-*`): Studio's save status turns `● Not saved · Storage
  full`, a toast "Storage is full. Free space or move the workspace to a folder · Open Storage settings", and Home shows
  a banner above the hero with the same text. Editing continues in memory; nothing is lost until the tab closes, and
  the banner says so.
- At ~2 GB used, a one-time toast suggests moving to a folder (D8).

## 5. Plumbing needed

| Need | Where |
|---|---|
| Home index carries `folder`, `favorite`, `trashedAt`, `createdAt`, `pages`, and a `projects` list for empty projects | `src/home/index-record.ts`, `src/workspace/home-index-writer.ts` (`projectHomeIndex`) |
| Capabilities: rename-design, duplicate-design, move-to-project, favourite, trash-designs, restore-designs, delete-forever, new-project, rename-project, delete-project, search | `src/home/capabilities.ts` (declarations; implementations over `createLibrary` on main, Home-safe: the library document opens without the engine) |
| Duplicate design = frozen snapshot of Latest → `createDocumentFromMilestone`-style new asset | `src/versioning/new-document.ts`, `src/workspace/templates.ts` sibling `duplicate.ts` |
| Routes `/files`, `/p/:name`, `/trash`, `/settings` | `src/home/routes.ts` |
| Files page, project view, trash page, bulk bar, card menu, context menu, inline rename, drag to project | `src/home/home-element.ts` → split into `home-page.ts`, `files-page.ts`, `project-page.ts`, `trash-page.ts`, shared `design-card.ts` |
| Trashed-design banner and read-only in Studio; cross-tab index broadcast | `src/workspace/studio-session.ts`, `src/versioning/readonly.ts`, `BroadcastChannel` on the index writer |
| Storage facts (usage, persisted, mirror state) and the quota toast | `src/workspace/blobs.ts`, `@staticflux/blob` quota helpers, `src/settings/` |
| Covers for cards | A6 projection cover job in the rendition queue (`src/library/renditions.ts`, role `cover`) |
