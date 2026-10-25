# apps/instaflow/src/home — AGENTS.md

**Work package:** Instaflow M1c **C0 Home route** (D17, D18; IF-28.4–28.25, LIFECYCLES §30, `IF-HOME-001…007`). **Layer:** app.
**Entry point:** `@instaflow/app/home` (`dist/home/index.js`; the dev page `dev/home/main.ts`).
**Depends on:** `@staticflux/core`, `@staticflux/ui` (+ `/theme`), `@staticflux/kit` (`button`, `card`, `tag`), `@staticflux/i18n`,
`@staticflux/capabilities`, `@staticflux/router` (route table only), `@staticflux/loader` (boot plan data), `@staticflux/document/v2`
(types, `HeadConflictError`), `../workspace/browser.ts` + `document-store.ts` (IndexedDB), `../library` (`kinds`, `library-doc` constants),
`../theme`. **Never** the editor, render, Loro, worker, Wasm or GPU code (D17; `home-imports.test.ts` fails the build otherwise).
**Budgets:** Home's whole boot 52.5 KB, Home's own code 10.75 KB brotli (`.size-limit.json`, "@instaflow/app/home").

## Purpose
The light surface a person lands on: recents, files, templates and quick actions, with "New design" going straight into Studio.
It reads the **Home index** (a projection of the library kept in the library head by Studio's store side, `../workspace`) and links
into Studio; everything it does is a capability, so agents can do it too.

## Public API (by file)
- `index-record.ts` — `HomeIndex` (`instaflow.home-index/1`), `HomeEntry`, `DesignSize`, `HOME_INDEX_APP_KEY` (`home`), `readHomeIndex`
  (tolerant), `readHomeEntry`, `withHomeIndex`, `sameHomeIndex`, `byEdited`, `recentDesigns`, `workspaceFiles`, `workspaceTemplates`.
- `formats.ts` — `DESIGN_FORMAT_IDS`, `DESIGN_FORMATS` (data), `DEFAULT_DESIGN_FORMAT`, `designFormat`, `designFormats`, `aspectOf`.
- `routes.ts` — `homeRoute` (`/`), `studioRoute` (`/s/:asset`), `newDesignRoute` (`/new?format|template`), `instaflowRoutes()`, `homeHref`,
  `studioHref`, `newDesignHref`, `readStudioIntent` → `StudioIntent` (`open | new | demo`).
- `capabilities.ts` — `NewDesignCapability`, `OpenDesignCapability`, `UseTemplateCapability` (output `{ href }`), `HOME_CAPABILITIES`,
  `HomeQuickAction`, `HOME_QUICK_ACTIONS` (data rows over capabilities: one per format in M1).
- `model.ts` — `createHomeModel({ source, host, signal, capabilities? })` → `HomeModel` (`state`, `error`, `index`, `recents()`, `files()`,
  `templates()`, `quickActions`, `capabilities`, `hrefOf`, `refresh`, `newDesign`, `open`, `useTemplate`, `runQuickAction`, `dispose`);
  `HomeMachine` (`instaflow/home`), `storeIndexSource(store)`, `HomeHost` (`navigate`), `ENTRY_HREFS` (kind → href, data).
- `home-element.ts` — `<if-home>` (`defineHome`, render dep `HomeModelToken`, lazy `I18nToken`), `isPlainActivation`.
- `boot.ts` — `bootHome({ container, scope, store?, host?, theme? })` → `{ model, element }`; refreshes on bfcache restore and visibility.
- `boot-plan.ts` — `INSTAFLOW_CHUNKS`, `HOME_BOOT_PLAN`, `STUDIO_BOOT_PLAN`, `bootClosure` (Δ26 loader data for the production build).
- `messages.ts` — `homeMessages` (`instaflow-home`), `homeText`, `relativeTime`. `tokens.ts` — `HomeModelToken`. `errors.ts` — `IF-HOME-001…007`.

## Semantics (do not regress)
- **No engine** (D17): Home reads heads only (`readHead`), never opens a document; the graph test and the size budget hold it.
- **One pipeline** (D18): buttons, cards, file links and agents all invoke the capabilities; cards are real links (`<sf-card href>`) whose
  plain click / Enter runs the capability instead, modified clicks stay the browser's.
- **Data, not branches**: what an entry links to (`ENTRY_HREFS`), kind labels, quick actions and formats are tables.
- Keyboard: one native focusable per action, reading order; "Try again" on a failed read. Results and problems in a polite live region.

## Rules
- Repo rules 1–10. UI from the kit under Clean Pop only (`docs/instaflow/design/HomeCP.dc.html`); layout CSS uses theme tokens.
- Add a quick action as a row with its own capability (M2: remove background, resize, …), never as a branch in the element.
- Studio-side work (planning the document, listing it, writing the index, templates) belongs in `../workspace`, not here.

## Test
`pnpm vitest run apps/instaflow/src/home` (index record, routes and formats, model and capabilities, `<if-home>` with the a11y audit in
every state, boot, boot plans, the import graph) · `NODE_PATH=/opt/node-tools/node_modules pnpm --filter @instaflow/app smoke:home`.
