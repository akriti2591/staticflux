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
