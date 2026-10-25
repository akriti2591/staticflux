# apps/instaflow/src/text — AGENTS.md

**Work package:** Instaflow M1b **B2** (SF-Δ27, IF-7.6, IF-7.7, IF-21.1–21.29; from spike S3). **Layer:** app.
**Depends on:** `@staticflux/core`, `document` (`v2`; `loro-crdt` in tests), `surface` (`text-input`, `AccessibleNode`
types), `blob` (font storage), `kit` + `ui` + `lit` (Typography panel), B0's `src/spec` (contribution tokens), B1's
`src/elements/components` (element components, `P` paths), `src/render/scene-ir` (scene IR v3). Tests: `testkit`,
`harfbuzzjs` (shaping parity), `fast-check`.
**Budgets:** this folder's JS ≤ 17.5 KB brotli excluding framework packages (measured 17.3 KB; `.size-limit.json`); the
`authoring-text` Wasm ≤ 350 KB brotli (measured 302.4 KB), the lazy `authoring-text-complex` ≤ 2.3 MB (2,236 KB);
`@staticflux/surface/text-input` ≤ 3.75 KB (3.66 KB). See `../../engine/AGENTS.md` for the Wasm side.

## Purpose
Rich text for Instaflow: the document model and its ops, Parley layout in the editor worker, fonts as content-addressed
assets, text editing through the framework's `TextInput` port, the scene projection the render module draws, the
Typography panel / HUD contributions, and the accessibility data B6 exposes. Headless services plus contributions; no
screen layout (M1B-NOTES).

## Public API (by file; export `@instaflow/app/text`)
- `model.ts` — `TextComponent` (`text.content` rich text, `box`, `align`, `verticalAlign`), `TEXT_KIND`, `TEXT_CONTENT`,
  `TEXT_KIND_COMPONENTS` / `TEXT_REGISTRY_OPTIONS` (B1's `ELEMENT_COMMON_COMPONENTS` + `text`; pass to
  `createElementRegistry`), `MATCH_KEY_PATH` (= B1's `lineage.key`), `CharMark` / `ParaMark` keys, **`TEXT_MARK_EXPAND`**
  (every peer's Loro engine: `createLoroEngine({ marks: TEXT_MARK_EXPAND })`), `CharStyle`, `ParagraphStyle`, `FontRef`,
  `ColorRef`, `TokenRef`, validators (`checkCharMark`, `checkParagraphField`, `isTokenRef`), `charStyleOf`,
  `paragraphStyleOf`, `paragraphMarks`.
- `rich-text.ts` — `readTextBlock(part, node)` → `TextBlockModel` (paragraphs with styled runs; block offsets = layout
  offsets), op builders `insertTextOps`, `deleteTextOps`, `replaceTextOps`, `splitParagraphOps`, `setCharMarkOps`,
  `setCharStyleOps`, `toggleCharMarkOps`, `setParagraphStyleOps`, `createTextOps`, `duplicateTextOps` (keeps the match key),
  `previewReplace` (IME preview), `anchorRange` / `resolveRange`, `paragraphAt`.
- `layout-spec.ts` — `encodeLayoutSpec(spec)` (byte-identical with the Rust `SpecWriter`), `familyList`.
- `layout-result.ts` — `decodeTextLayout(f32s)` → `TextLayout` (`paragraphs()`, `lines()`, `runs()`, **`clusters()`,
  `words()`** with stable indices and bounds, `decorations()`, `clusterAt`, `clustersOf`), `ClusterFlag`.
- `authoring-module.ts` — `loadAuthoringModule({ manifestUrl, build: 'base' | 'complex' })` (ABI 2, IF-TXT-004),
  `AuthoringWasm`, `TextEngineWasm`, `AUTHORING_BUILDS`.
- `text-engine.ts` — `createTextLayoutEngine({ wasm, loadComplex })` → `registerFont(hash, bytes)`, `fontOf`,
  `setFallbacks(script, families)`, `setGeneric`, `prepare(text)` (lazy complex-scripts build), `layout(id, spec, text)`,
  `hitTest`, `caret`, `selectionRects`, `charBounds`, `wordAt`, `move(id, from, motion, xHint)`, `drop`, `dispose`;
  `needsComplexScripts`, `CaretMotion`.
- `text-style.ts` — `resolveTextLayout(block, { width, align, defaults, brand, families })` → `{ spec, brushes, problems }`,
  `BrandTokenSource` (B1/B4 brand kits implement it), `resolveColor`, `resolveFont`, `parseCssColor`.
- `text-scene.ts` — `textSceneNodes(layout, { id, transform, brushes, fontId, nextId })` (group + glyph leaves + decoration
  rects), `createSceneFontTable()` (`idFor`, `ensure`, `resnapshot`, `reset`), `hashBytes`.
- `fonts.ts` — `createFontLibrary({ blobs, register, platform })` → `checkLocalFonts`, `requestLocalFonts` (gesture),
  `importLocalFont`, `importUpload`, `load(hash)`, `assets`, `bytesOf`, `families`; `LocalFontsMachine`
  (`instaflow/local-fonts`), `isFontFile`, `FONT_MIME`.
- `text-session.ts` — `createTextSession({ input, target, engine, blockId, layout, toClient, onExit, onProblem })` →
  `state`, `selection`, `select`, `refresh`, `setTypingStyle`, `onChange`, `dispose`. The control bounds are the committed
  block's size, never the composition preview's (B8 fix of the owner's IME check finding 2; `text-session.ime.test.ts`).
- `typography.ts` — `createTypographyService(...)` (`summary`, `setFont`, `setSize`, `setWeight`, `toggle`, `setColor`,
  `setLetterSpacing`, `setLink`, `setAlign`, `setLineHeight`, `fitToBox`, `fontChoices`, `colorChoices`, `onChange`),
  `TypographyServiceToken`, `summarizeTypography`, `fitToBoxOps`, `MIXED`.
- `typography-panel.ts` — `<if-typography-panel>` (kit only), `defineTypographyPanel`, `fontLabel`, `ALIGN_OPTIONS`,
  `TYPOGRAPHY_TEXT`.
- `contributions.ts` — **B0 contributions** (Canvas and Pages lenses; they replace Studio's placeholders under the same
  ids): `textTool` (`instaflow/text`, `T`), `typographyPanel` (`instaflow/typography`; Studio places it in the inspector of
  both lenses), `textHudActions` (Font, Size, Fit to box; selection scope, so not in Studio's asset-scope HUD row),
  `TEXT_HUD_COMMANDS`, `textContributionUnits()` (the panel needs
  `TypographyServiceToken`), `placeTextOps` (the Text tool's create action), `TextIds`.
- `a11y.ts` — `textAccessibility(block, layout, { id, semanticRole, editing, selection, toSurface })` and
  `textAccessibleNode(data)` (the B6 seam: text, paragraphs, lines, links, selection, role), `SEMANTIC_TEXT_ROLES`.
- `errors.ts` — `IF-TXT-001` style · `002` not text · `003` range · `004` Wasm load/ABI · `005` layout · `006` font file ·
  `007` LFA refused · `008` LFA unavailable · `009` token unresolved · `010` font store.
- `ime-check/` — the human IME check page (serve-only; not built, not tested in CI).

## Wiring (editor worker + main)
```ts
const engine = createTextLayoutEngine({ wasm: await loadAuthoringModule({ manifestUrl }), loadComplex: (s) => loadAuthoringModule({ manifestUrl, build: 'complex', signal: s }) });
const fonts = createFontLibrary({ blobs, register: (h, b) => engine.registerFont(h, b), platform: { queryLocalFonts: globalThis.queryLocalFonts } });
engine.setFallbacks('Arab', ['Noto Sans Arabic']);                     // per script (S3 lesson), not one long list
const resolved = resolveTextLayout(readTextBlock(part, node).value, { width, defaults, brand, families: fonts.families });
await engine.prepare(block.text);                                      // Thai & co. load the complex chunk once
const layout = engine.layout(blockId, encodeLayoutSpec(resolved.spec), block.text);
table.ensure(writer, hash, () => fonts.bytesOf(hash));                 // fonts to the render scene, once per hash
for (const n of textSceneNodes(layout.value, { id, transform, brushes: resolved.brushes, fontId, nextId })) writer.upsert(n);
// main: injector with ...textInputBindings({ editContext: () => facts.snapshot().apis.editContext })
const input = (await injector.get(TextInputFactoryToken)).value.create({ host: canvasHost, label });
createTextSession({ input, target: { read, commit }, engine, blockId, layout: relayout, toClient });
```

## Rules
- UTF-16 offsets everywhere; block text = content without its final `\n`; never delete the final break (TXT-1).
- Compositions are previews until commit (TXT-2); collapsed deletes are expanded by the layout (TXT-3).
- Every Loro peer uses `TEXT_MARK_EXPAND` (TXT-5). Paragraph styles live on breaks; never add a separate paragraph list.
- No browser checks: the TextInput implementation is a variant binding (TXT-8). Thai/Lao/Khmer/Myanmar choose the complex
  build by data (`needsComplexScripts`).
- Fonts are keyed by sha-256 (the blob digest); never by family name (TXT-6). Local fonts are copied into the workspace.
- Brand tokens never throw: unresolved ones fall back and are reported (IF-TXT-009).
- UI only from kit components under Clean Pop; no one-off styles.

## Human IME check (owner, desktop Chrome, ~5 minutes) — LIFECYCLES TXT-10 is **INCONCLUSIVE** until done
**As a zip for the owner's machine** (automated CDP check + a prompt for an agent with computer use):
`pnpm build && bash apps/instaflow/src/text/ime-check/pack/pack.sh <out-dir>`; instructions inside (`pack/HOW-TO-RUN.txt`).
In the repo: run `pnpm ime-check` at the repo root (builds, then serves) and open the printed URL
(`http://localhost:4174/apps/instaflow/src/text/ime-check/index.html`) in Chrome. The status line says `Ready (edit-context)`.
The four steps are on the page: Japanese `nihongo`, Chinese `zhongwen`, Korean `gksrmf`, then a wrapped line, an Arabic
word and page zoom, then `?input=textarea` (the hidden-textarea adapter; the M1 question "hidden textarea on Chrome too?").
Pass = the candidate window sits at the caret / composition every time. Report pass or fail per step; on a failure paste
`copy(JSON.stringify(window.__imeCheck.log))`. A candidate at the box corner means `setCharacterBounds` /
`setSelectionBounds` are wrong (see the log); switching adapters is the fallback.

## Test
`pnpm vitest run apps/instaflow/src/text` (rich text + 3-peer convergence property, styles, fonts and the LFA flow, the
model on B1's registry, panel + contributions with an a11y audit; on the built Wasm: shaping parity vs HarfBuzz,
caret ↔ hit-test round trip, clusters/words/lines, complex-scripts lazy load, session with IME preview and grapheme
deletes, typography Fit to box, a11y data) · `pnpm vitest run packages/testkit/src/text-input-contract.test.ts` (the
TextInput contract on both implementations) · `cargo test` in `engine/` · golden renders:
`pnpm build && SF_GPU=1 NODE_PATH=/opt/node-tools/node_modules pnpm test:gpu` (`render.gpu.test.ts`: `gpu-text`,
`ts-text`, golden `render-gpu-text`).

## Open items for the coordinator / follow-ups
- B1's `duplicate` (elements/actions.ts) copies props only: duplicating a text element loses its rich text. Use
  `duplicateTextOps` for text nodes (or copy `texts` in `duplicate`).
- Emoji: colour glyphs (COLR/CBDT) draw only outline fallbacks in the render module (budget: see engine AGENTS.md).
