# Instaflow navigation and deep links (Layer 1)

> Status: **normative.** One URL scheme for every addressable state, what belongs in the path, the query or nowhere,
> history semantics, fallbacks and the "Copy link" affordances. Layer 2 specs name their routes from here and never
> invent a parameter. Mapped to `@staticflux/router` and `@staticflux/urlstate` in §7. Conventions: **Figma** (node
> ids in links, "Copy link to selection"), **Linear** (every view has a URL, Escape never navigates), **Google Docs**
> (links open the thing, not the author's viewport).

## 1. Principles

1. **Every state a person could want to send someone has a URL.** If it can be opened, it can be linked, and the link
   opens the same thing on a cold boot.
2. **A link shows the thing, not the viewport.** The receiver's camera is computed from the target (fit page, zoom to
   selection); the sender's zoom and scroll are never in the URL.
3. **Escape dismisses; Back navigates.** Escape never leaves a surface; Back never closes a popover.
4. **A missing or forbidden target degrades one level, says so once, and never blocks.** Design → Home page; element →
   its design; milestone → Latest; dialog → the surface. Client gating is UX, not security (rule 9).
5. **The URL is declared once.** Every path and key is a typed route or binding (`defineRoute`, `defineUrlBinding`,
   `defineIntent`, `defineDialog`); the CI check refuses duplicates.

## 2. The scheme

### 2.1 Paths (what resource)

| Surface | Path | Notes |
|---|---|---|
| Home | `/` | |
| Files | `/files` | |
| Project | `/p/:project` | the project name, URL-encoded |
| Templates | `/templates` | the Templates nav |
| Trash | `/trash` | |
| Settings (Home shell) | `/settings/:section?` | `general` (default) · `shortcuts` · `storage` · `assistant` · `about` |
| New design | `/new?format=&template=` | replaces itself with `/s/:asset` once created (exists) |
| Studio | `/s/:asset` | |
| Milestone preview | `/s/:asset/m/:milestone` | read-only takeover (`OVERLAYS-FEEDBACK.md` §2.3) |
| Routable dialog | `<surface path>/d/:dialog` | one at a time, always last in the path (urlstate rule): `export` · `share` · `settings` |
| Chat (M2) | `/c/:thread` | the Chat surface |
| Release (D10, later) | `/r/:release` | reserved; the read-only published asset |

Home and Studio are separate pages (separate boots, D17), so a link between them is a full navigation; within a surface
every change below is a same-document navigation.

### 2.2 Query (where within it)

Three kinds, after `@staticflux/urlstate`: **view** (synced from the store, replaced in history, restored on reload),
**intent** (consumed once on arrival, never written back), **sticky** (kept across navigations by its package).

| Key | Kind | Values | Means |
|---|---|---|---|
| `lens` | view | `canvas` · `pages` (M2: `pixel` · `timeline` · `flow`) | the active lens; absent = canvas |
| `page` | view | a page id | the current page (Pages lens camera; Canvas lens: which page `Fit` uses) |
| `dock` | view | `layers` · `pages` · `assets` · `milestones` (M2: `brand`) | the open dock tab; absent = last used on this device |
| `el` | intent | one or more element ids, comma-separated, ≤ 20 | select these and zoom to them on arrival; never written by the editor (selection is `hidden`) |
| `inspect` | intent | a section id (`fill`, `stroke`, `text`, `effects`, `layer`, `page`) | expand and scroll the inspector to that section once |
| `compare` | view (milestone preview only) | `latest` or a milestone id | the Compare takeover |
| `section` | view (dialog `settings`) | as `/settings/:section` | the Settings dialog's section in Studio |
| `step` | view (dialog `share`, `export`) | `link-settings` · `publish` · `advanced` | the dialog step |
| `tab` | view (dialog `export`) | `export` · `share` | the Export dialog tab (`/d/share` = `/d/export?tab=share`) |
| `thread` | view (Studio, M2) | a thread id | the Chat side panel docked on that thread |
| `turn` | intent (Chat, M2) | a turn id | scroll to and highlight that turn |
| `comment` | intent (reserved, D11) | a comment thread id | select the anchored element and open its thread in the comments panel |
| `q` | view (Files, Home) | text | the search query |
| `filter` · `sort` · `view` | view (Files) | as HOME-FILES §2.2 | list state |
| `sf-debug` | sticky | a level spec | DevTools verbosity (`DEVTOOLS-UX-SPEC.md`) |

Order when building a URL: path, then `lens`, `page`, `dock`, `el`, `inspect`, then dialog params. Ids are the
document's stable ids (CRDT ids), never names or indices, so a renamed page keeps its links.

### 2.3 Nowhere (ephemeral)

Camera (pan, zoom), hover, the active tool and its stickiness, text caret and range, drag state, open menus and
non-routable popovers, the HUD's position, density (a device setting), dock width, collapsed inspector sections, the
command palette, toasts. Camera and dock width are remembered **per device per document** in local view state
(`instaflow/ui/*`), never in the URL. A design opened by a bare `/s/:asset` restores that device's last camera; one
opened with `el=` or `page=` computes its camera from the target instead.

## 3. History semantics

| Change | History | Back then does | Escape then does |
|---|---|---|---|
| Surface or design (`/` → `/s/:asset`, `/s/a` → `/s/b`) | push (full navigation) | goes back | nothing navigational |
| Lens, page, dock tab | **replace** (view) | nothing (the last pushed entry) | — |
| Milestone preview (`/m/:id`) opened in-app | push | leaves the preview | `Back to Latest` = `history.back()` |
| Milestone preview opened from a link | (arrived) | leaves the site or the previous page | **replace** to `/s/:asset` (never leaves the design) |
| Compare (`?compare=`) | push (it is a takeover) | back to the preview | same as Back |
| Routable dialog opened in-app (`/d/export`) | push | closes the dialog (`onDismissIntent: back`) | closes the dialog = `history.back()` |
| Routable dialog opened from a link | (arrived) | leaves | **replace** to the parent path (`onDismissIntent: replace`) |
| Dialog step (`?step=`) | replace | closes the whole dialog | Back inside the dialog (step 1: close) |
| Settings section (dialog or page) | replace | closes / leaves Settings | closes the dialog |
| Selection, inspector section, `el=` / `inspect=` | never written | — | the canvas ladder |
| Chat thread (`/c/:thread`) | push | previous thread or Home | — |
| Thread docked in Studio (`?thread=`) | replace | — | closes the side panel? **No**: Escape in the panel returns focus to the canvas; the panel closes by its `×` |

Rules: **Escape never changes the path except to leave a deep-linked dialog or preview by replace**; Back never closes a
menu, popover or toast; a dialog that was pushed and is closed by its `×` or primary action calls `history.back()` so the
stack has no dead entries; the router adopts urlstate's view writes without a pipeline (replace only).

## 4. The target is missing or not permitted

Fallbacks are **one level up, once announced, never blocking**:

| Target | Fallback | Feedback |
|---|---|---|
| Design not on this device (`SF-NAV-001` on `/s/:asset`) | A Home-shell page at the same URL: `This design isn't on this device` with `Go to Home` (primary), `Open a folder…` (D8) and the sentence "Designs live in this browser profile or in the folder you chose." | the page itself (section level); no toast |
| Design in the trash | opens read-only | banner `This design is in the trash · Restore` (exists) |
| Page id unknown | first page | toast `That page is no longer in this design` (neutral, 5 s) |
| Element ids unknown (all) | the design, camera fits the page | toast `That element is no longer in this design` |
| Element ids partly unknown | select the ones that exist | toast `2 of 3 linked elements are no longer in this design` |
| Element inside a hidden or locked container | select it anyway (selection by link may enter containers) | the inspector breadcrumb shows where it is |
| Milestone unknown | Latest | toast `That milestone is no longer here` |
| Dialog key unknown or not available yet (`share` before accounts, `SF-NAV-008`) | the surface, the path replaced to the parent | toast `Sharing isn't available yet` — only when a person would understand; an unknown key is dropped silently and logged |
| Dialog not permitted (gated capability) | the surface | toast with the gate's `fix` (`Set up an assistant`); DevTools `explain()` has the reason |
| `thread=` with no provider (M2) | the design without the panel | toast `Set up an assistant to open this conversation · Open settings` |
| `comment=` before comments exist | the design, `el=` honoured if present | nothing |
| Unsupported browser | the blocking error (`IF-PLAT-*`) at any URL | blocking (`OVERLAYS-FEEDBACK.md` §3.1) |

A fallback **replaces** the URL with what is actually shown, so a reload does not repeat the toast. Nothing here is
security: a link to a design not on this device fails because the bytes are not there, not because of a check (D3).

## 5. "Copy link to this"

One capability, `instaflow/copy-link`, with a target; the toast is `Link copied` (1.5 s, deduped) everywhere.

| Target | Where the affordance lives | Produces |
|---|---|---|
| The design | top bar `⋯ › Copy link`; Home card `⋯ › Copy link`; `Mod+Alt+C` | `/s/:asset` |
| The selection | context menu `Copy link to selection` (any element, multi); HUD `⋯ › Copy link` | `/s/:asset?page=&el=` |
| A page | page label menu `Copy link to page`; Pages row menu | `/s/:asset?lens=pages&page=` |
| A milestone | Milestones row `⋯ › Copy link`; the preview and Compare headers `Copy link` | `/s/:asset/m/:id` (+ `?compare=`) |
| A dialog | the `Copy link` ghost in a routable dialog's header | `…/d/:dialog?…` with its current step or section |
| Settings › Shortcuts | the Shortcuts view header | `/settings/shortcuts` (Home shell URL, so it opens standalone) |
| A chat thread (M2) | thread menu `Copy link`; a turn's hover `⋯ › Copy link to this message` | `/c/:thread` · `?turn=` |
| A comment (later) | the comment's `⋯` | `/s/:asset?el=&comment=` |

Links never carry `lens` or `dock` unless the target needs them (a page link sets `lens=pages`; a milestone list link
sets `dock=milestones`). The browser's address bar reflects view params too, so "copy the URL" is a valid, if noisier,
copy-link.

## 6. Links opened from outside and cold boot

Order of application on a cold boot of `/s/:asset?lens=pages&page=p2&el=e1,e2&dock=layers&inspect=fill/d/export`:

1. **Resolve the route** (`resolve → … → load`); the asset is opened; a skeleton Studio renders within the first frame
   with the top bar and regions (no spinner; `<sf-skeleton>` in panels).
2. **Lens and page** apply as soon as the document structure is known (before the first render of content).
3. **Dock tab** applies with the lens.
4. **Document interactive** → **selection intent** `el=` is consumed: select, enter containers as needed, camera = zoom
   to selection with 10 % padding (or fit the page when `page=` alone). Announce politely (`2 elements selected`).
5. **Inspector intent** `inspect=` is consumed: expand and scroll the section; the first field is **not** focused (focus
   stays on the canvas so Escape and shortcuts work).
6. **The dialog** opens last, after the first content frame and the intents, so the person sees the design behind it
   and Escape returns to exactly the linked state. A deep-linked dialog is `source: 'deep-link'` (Escape replaces).
7. Intents are **stripped** from the URL once consumed (`el=`, `inspect=`, `turn=`); view params stay.

Links from outside the app behave the same; the only difference is that history has no previous in-app entry, so Back
leaves the site and Escape replaces (§3). A link opened in a tab that already has that design open is a second tab of
the same document (the index broadcast keeps titles in step); nothing forces a single tab.

**Hints** (`OVERLAYS-FEEDBACK.md` §5) are suppressed on arrivals with `el=`, `page=` or a dialog: the person came for
something specific.

## 7. Map to `@staticflux/router` and `@staticflux/urlstate`

| Need | Framework piece | Instaflow piece | Status |
|---|---|---|---|
| Typed paths | `router` `defineRoute` (`/`, `/files`, `/p/:project`, `/templates`, `/trash`, `/settings/:section?`, `/new`, `/s/:asset`, `/s/:asset/m/:milestone`, `/c/:thread`) | `src/home/routes.ts` (has `/`, `/s/:asset`, `/new`) | **missing:** the rest; `/m/:milestone` as a nested route with `parent: studioRoute` |
| View params | `urlstate` `defineUrlBinding({ kind: 'view', codec, history: 'replace' })` + `createUrlSync` bound to the view-state store | `src/tools/view-state.ts` (camera, selection; local) | **missing:** `lens`, `page`, `dock`, `compare`, `section`, `step`, `tab`, `thread`, Files `q/filter/sort/view` as bindings in `src/app/url.ts`; the store ↔ URL sync is per frame and never calls the router |
| Selection and inspector intents | `urlstate` `defineIntent({ id, params: { el: codec.list }, safe: true })` + `createIntentService().consume` | — | **missing** (`src/app/url.ts`; `safe: true` because selecting and zooming never change the document) |
| Hidden state | `urlstate` kind `hidden` for selection (stripped if present) | — | declare so a stray `sel=` never leaks |
| Routable dialogs | `router` `defineDialog({ key, owner, requires, load })` + `urlstate` `formatDialogPath` + `messaging` `createRoutableDialogBridge` (`openDialog(key, params, { source })`, `onDismissIntent` back/replace) | `/d/export` bridge exists (FOUNDATIONS §4.11) | **missing:** `settings` and `share` keys, the step/section params, `Copy link` in the header |
| History strategy | `router` `createBrowserHistory` (Navigation API with History fallback), one instance bound to both `HistoryAdapterToken` and `HistoryPortToken` | Studio boot | check: one instance, `source: 'urlstate'` writes adopted as view |
| Not found | `routerUnitWith({ notFound })` → the Home-shell "not on this device" page; `SF-NAV-001`; dialog `SF-NAV-008` → drop + toast | — | **missing** (`src/home/not-found.ts`, Instaflow) |
| Gating of dialogs and features | `router` `requires` + the gate stage plugin; `SF-NAV-002` blocked → fallback + toast with the gate's `fix` | — | the gate's `explain()` feeds DevTools |
| Copy link | capability `instaflow/copy-link` building hrefs through `instaflowRoutes().build` + `urlSync.decorate` (sticky params) | — | **missing** (`src/app/links.ts`) |
| Cold-boot order | `router` pipeline (`load` → `enter` → `render`), intents consumed in `enter` of the Studio feature, dialog opened in `render` after the first content frame | `src/app/studio-app.ts` | **missing:** the ordering and the "strip after consume" |
| Sticky debug flag | `urlstate` sticky `sf-debug`, `devtools` `readDebugFlag` | — | exists in the framework; wire in `DEVTOOLS-UX-SPEC.md` |

Declaration rules: every key once, in `apps/instaflow/src/app/url-contract.ts` (`Registry['urlParams']` merge), checked
by `checkUrlDeclarations` in CI; path params are typed by the route (`PathParams`); an unknown query key is ignored and
preserved (someone else's sticky param), never an error.
