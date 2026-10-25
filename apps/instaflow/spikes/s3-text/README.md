# S3 — Text: Parley in a worker + EditContext IME round trip

**Verdict: proceed with Parley 0.12 + EditContext, without the `complex-scripts` feature in the main authoring
module.** Arabic and Devanagari shaping, caret placement and the size budget pass. Candidate-window placement for a
real IME needs a person to check it on a desktop (steps below).

## What was built
- `wasm/`: a Rust `cdylib` with **parley 0.12.0** (the latest on crates.io, released 2026-10-09; it uses HarfRust 0.12,
  skrifa 0.44 and ICU4X 2.4). It has a hand-written C ABI, so there is no wasm-bindgen and the module has **zero
  imports** (it also runs in Node). Calls: `add_font`, `set_family`, `layout` (returns glyph runs and line metrics),
  `hit_test` (x,y → index), `caret_rect`, `selection_rects`, `char_bounds` (one rect per UTF-16 code unit), and
  `glyph_path` (skrifa outlines, honouring the run's variation coordinates). Indices crossing the ABI are UTF-16,
  which is what EditContext uses; Parley's UTF-8 offsets are mapped inside the module.
  Features: `complex` = `parley/complex-scripts`, `outlines` = skrifa outline export.
- `web/worker.mjs`: the authoring-worker stand-in. Font bytes are transferred to it, and every edit returns layout,
  caret, selection and character bounds, plus outlines only for glyphs main has not seen yet.
- `web/main.mjs` + `index.html`: a canvas-only renderer (Parley glyph outlines, no `fillText`) and a specimen next to
  Chrome DOM text set in the same font files. It holds an **EditContext bound to the canvas**: `textupdate` updates
  the buffer, which goes to the worker, and then the page calls `updateControlBounds`, `updateSelectionBounds` and
  `updateCharacterBounds`. It also handles `characterboundsupdate` and `textformatupdate`, does click hit-testing and
  handles Enter and the arrow keys. The page also runs a Local Font Access probe and the benchmarks.
- `test/shaping-compare.mjs` compares the shaping against HarfBuzz 15.0.0 (harfbuzzjs 1.6.4). For each Parley bidi
  run it shapes the same run with the full string as context, the same font and direction, at size = upem. It
  includes a negative control. `test/run-browser.cjs` uses Playwright plus CDP `Input.imeSetComposition` to drive
  the editor. `test/thai-breaks.mjs` shows what `complex-scripts` adds.
- Fonts (`fetch-fonts.sh`, not committed, 34 MB): Noto Sans, Noto Sans Arabic, Noto Sans Devanagari, Noto Sans JP
  and Noto Sans KR from google/fonts, plus Noto Color Emoji. **All are SIL OFL 1.1** (`fonts/OFL.txt`). The local-font
  test uses the machine's DejaVu Sans (Bitstream Vera licence) and the Thai test uses Loma (GPL with the font
  exception). Neither is bundled.

## Criteria (cloud container, headless Chromium 153, 4 shared cores; medians/p95 over repeated runs, noisy)
| Criterion | Result | Evidence |
|---|---|---|
| Arabic shaped correctly | **PASS** | 40 strings, 788 glyphs: **100%** glyph id + advance + offset match with HarfBuzz. This covers lam-alef, harakat, Persian/Urdu letters, bidi digits and mirroring. Negative control (HarfBuzz with init/medi/fina/rlig off): only 49.75% match. The same 100% holds with the full font stack (199 runs) and without `complex-scripts`. |
| Devanagari shaped correctly | **PASS** | 40 strings, 286 glyphs: **100%** match. This covers conjuncts, reph, pre-base i-matra reordering, nukta, ZWJ/ZWNJ and eyelash ra. Negative control (half/blwf/rphf/pres/… off): 36.68%. Visual: `results/specimen-parley.png` and `specimen-chrome-dom.png` show identical shaping and line breaks to Chrome. |
| Caret correctly placed | **PASS** (geometry) | Caret rect → hit-test → same visual position for **393/393** indices across Latin, RTL, Devanagari, CJK, mixed bidi and emoji (351 are exact; the rest are indices inside a cluster that snap to the cluster boundary). The rect given to `updateSelectionBounds` equals the canvas origin + padding + Parley caret, to within 1 px. Composition character bounds are contiguous, left-to-right for Japanese and **right-to-left for Arabic**. |
| IME candidate correctly placed (ja/zh/ko) | **INCONCLUSIVE — needs a human** | Composition via CDP passes for all three: ja にほんご→日本語 commit, ko ㅎ→하→한, zh zhongwen→中文. The `characterboundsupdate` → worker → `updateCharacterBounds` path delivers 3 rects for 日本語, inside the canvas. Headless has no candidate window, and CDP sends no IME text spans, so `textformatupdate` formats were empty and the underline was not exercised. |
| Authoring Wasm ≤ 350 KB brotli | **PASS** without `complex-scripts`; **FAIL** with it | Layout only: **266.8 KB br** (768 KB raw, 329 KB gz). Layout + outlines: **329.5 KB br**. With `complex-scripts`: **2,154 KB br** (3.7 MB raw), and 2,218 KB with outlines too. `wasm-opt -Oz` does not reduce the brotli size. (`results/sizes.json`) |
| Local Font Access bytes → Parley | **PASS** with permission | `queryLocalFonts` and `FontData` exist. The permission state is `prompt` by default, and calling without permission fails with `SecurityError: User activation is required`. With the permission granted (Playwright `grantPermissions(['local-fonts'])`): 108 fonts in 3 ms; `DejaVuSans.blob()` gives 759,720 bytes in 7–14 ms. The worker registered it and Parley laid out with it, end to end. In the product this needs a click and the permission prompt. |

**Other numbers** (`results/browser.json`):
- **Wasm load:** compile 4–7 ms. Instantiate 0.3 ms median (p95 0.6 ms); the `complex` build takes 3.2 ms. The
  worker is ready, including the wasm fetch, in about 60 ms.
- **Fonts:** registering the 6 fonts (34 MB) takes 36 ms.
- **1,000 paragraphs:** 5 mixed scripts, 123 chars average, width 360, 3,125 lines. Layout takes 264–291 ms median
  (p95 277–393 ms), so **about 0.27 ms per paragraph**. With the glyph dump it takes 307–350 ms. The cold first pass
  takes 322–646 ms.
- **Edit round trip** (a 162-char paragraph: post → layout → caret, selection and char bounds → reply): **1.1 ms
  median, 4.7 ms p95**. Worker layout alone is 0.48 ms median; a bare ping is 0.03 ms.

## Surprises
1. **`complex-scripts` is not about complex shaping.** HarfRust always shapes Arabic and Indic. The feature only swaps
   in ICU4X **dictionary segmenters**: line breaking for Thai, Lao, Khmer and Myanmar, and word segmentation for
   Chinese and Japanese. It adds about 1.9 MB brotli. Without it, a Thai paragraph does not wrap at all (1 line,
   670 px wide in a 200 px box). With it, the paragraph wraps into 4 correct lines (`results/thai-breaks.json`).
2. **Google's Noto Sans also contains Devanagari,** so with Noto Sans first in the stack it shapes Devanagari. This is
   correct, but the font is not the one we expected. **Spaces in Arabic text come from the first family** (Noto Sans):
   46 runs become 199, and the space width and any kerning across spaces differ from the Arabic font. CSS behaves the
   same way. Order fallbacks per script (fontique `set_fallbacks`) or tag spans by language.
3. **Variable CJK fonts default to weight 100.** The renderer must use each run's `normalized_coords` or text renders
   thin. This was a bug in the spike that has been fixed; the same rule applies to Vello.
4. **Emoji:** ZWJ families, skin tones and flags shape to one glyph each. Noto Color Emoji is CBDT bitmaps with no
   outlines, so the canvas draws placeholders. Vello's bitmap or COLR path must handle emoji.
5. EditContext handles Backspace across a surrogate pair natively. Enter, the arrow keys and visual bidi movement
   (Parley `Cursor::next_visual`, not wired here) belong to the app.
6. **Harness bug, for the coordinator:** `_harness/serve-and-run.cjs` prints `true`, not the page result, because
   `waitForFunction` resolves to the predicate value. This spike reads `window.__result` in its own driver instead.

## Recommendation for M1
- Ship parley **without** `complex-scripts` in the authoring module (267 KB br, or 330 KB with outlines).
- Build a second, lazy Wasm with `complex-scripts`. Load it only when text contains Thai, Lao, Khmer or Myanmar, or
  when CJ double-click word selection matters. This is the plan's "lazy module" fallback, triggered only for those
  scripts.
- Keep UTF-16 indices at the `TextInput` port, push character bounds on each composition update and also answer
  `characterboundsupdate`, and keep the hidden-textarea adapter for Firefox only. Nothing so far suggests Chrome
  needs it.
- Keep a per-script fallback map in fontique rather than one long family list.

## Rerun
```bash
cd apps/instaflow/spikes/s3-text
npm install && ./fetch-fonts.sh && ./build.sh        # needs rustup target wasm32-unknown-unknown
npm run shaping && npm run thai                      # Node: HarfBuzz comparison, Thai line breaks
npm run browser                                      # headless: page metrics + EditContext/IME/LFA tests → results/
NODE_PATH=… node test/run-browser.cjs --headed --real-gpu   # same, on a desktop Chrome
npm run serve                                        # then open the printed URL in Chrome for manual checks
```

## Manual IME test (owner, desktop Chrome, about 10 minutes) — closes the INCONCLUSIVE row
1. Run `npm run serve`, open the URL in Chrome stable, and click the editor canvas. A red caret appears.
2. **Japanese** (macOS: Japanese – Romaji; Windows: Microsoft IME): type `nihongo`, then press Space twice.
   Pass: the candidate list sits directly under the underlined reading, with its left edge at the first composed
   character. It follows the text when you press Space again, and the committed 日本語 appears where the
   composition was.
3. **Chinese** (Pinyin): type `zhongwen`. Pass: the candidate bar is anchored at the composition start, not at the
   canvas corner or the screen origin.
4. **Korean** (2-Set): type `gksrmf` (한글). Pass: syllables build up in place and the caret is not left behind.
5. Repeat step 2 after the text has wrapped to a second line, and after an Arabic word (type `مرحبا`). Pass: the
   candidate follows the second line or the RTL position.
6. Also check that the composition underline appears (driven by `textformatupdate`) and that zooming the page
   (Ctrl +) still positions the candidate correctly.

If the candidate window sits at the canvas corner, `updateCharacterBounds` or `updateSelectionBounds` is wrong. Read
`window.__editor.log`. A fix there is cheap; switching to the hidden-textarea adapter is the documented fallback.
