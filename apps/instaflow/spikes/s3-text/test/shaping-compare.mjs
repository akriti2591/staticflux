// Compares Parley 0.12 (HarfRust) shaping against HarfBuzz (harfbuzzjs 1.6.4, C++ HarfBuzz HB_TINY build)
// for Arabic and Devanagari. Per Parley bidi run, HarfBuzz shapes the same run with the full string as
// context (addText itemOffset/itemLength), same font, same direction, font size = upem (font units).
// Usage: node test/shaping-compare.mjs [variant]   (variant = base|complex|outlines|complex+outlines)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as hb from 'harfbuzzjs';
import { createEngine } from '../web/engine.mjs';
import { arabic, devanagari } from './corpus.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const variant = process.argv[2] ?? 'outlines';
const eng = await createEngine(fs.readFileSync(path.join(root, `web/wasm/s3_text.${variant}.wasm`)));

const fontFiles = ['NotoSans.ttf', 'NotoSansArabic.ttf', 'NotoSansDevanagari.ttf'];
const hbFonts = [];
const families = [];
for (const f of fontFiles) {
  const bytes = fs.readFileSync(path.join(root, 'fonts', f));
  families.push(eng.addFont(bytes).families[0]);
  const face = new hb.Face(new hb.Blob(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
  hbFonts.push({ font: new hb.Font(face), upem: face.upem });
}
const upem = hbFonts[1].upem;

function compare(name, corpus, primaryFamily, hbFeatures = [], css = null) {
  eng.setFamily(css ?? `"${primaryFamily}", "${families[0]}"`);
  let glyphsTotal = 0, idMatch = 0, posMatch = 0, stringsExact = 0, runsTotal = 0;
  const mismatches = [];
  for (const text of corpus) {
    const L = eng.layout(text, { fontSize: upem, width: 0 });
    let exact = true;
    for (const line of L.lines) for (const run of line.runs) {
      runsTotal++;
      const buf = new hb.Buffer();
      buf.addText(text, run.start, run.end - run.start);
      buf.guessSegmentProperties();
      buf.setDirection(run.rtl ? hb.Direction.RTL : hb.Direction.LTR);
      hb.shape(hbFonts[run.font].font, buf, hbFeatures);
      const infos = buf.getGlyphInfos();
      const pos = buf.getGlyphPositions();
      // Parley positioned glyphs: x = pen + xOffset, y = baseline - yOffset (y down)
      let pen = run.glyphs.length ? run.glyphs[0].x - (pos[0]?.xOffset ?? 0) : 0;
      const n = Math.max(infos.length, run.glyphs.length);
      const base = line.baseline;
      for (let i = 0; i < n; i++) {
        glyphsTotal++;
        const p = run.glyphs[i], h = infos[i], hp = pos[i];
        const idOk = p && h && p.id === h.codepoint;
        let posOk = false;
        if (idOk) {
          const dx = p.x - pen, dy = base - p.y;
          posOk = Math.abs(p.advance - hp.xAdvance) < 0.05 && Math.abs(dx - hp.xOffset) < 0.05 && Math.abs(dy - hp.yOffset) < 0.05;
          pen += p.advance;
        }
        if (idOk) idMatch++;
        if (posOk) posMatch++;
        if (!idOk || !posOk) {
          exact = false;
          if (mismatches.length < 15) mismatches.push({ text, run: [run.start, run.end, run.rtl ? 'rtl' : 'ltr', fontFiles[run.font]], i, parley: p && { id: p.id, adv: +p.advance.toFixed(2), dx: +(p.x - pen + (idOk ? p.advance : 0)).toFixed(2) }, harfbuzz: h && { id: h.codepoint, adv: hp.xAdvance, dx: hp.xOffset, dy: hp.yOffset } });
        }
      }
    }
    if (exact) stringsExact++;
  }
  return { script: name, strings: corpus.length, runs: runsTotal, glyphs: glyphsTotal, glyphIdMatchPct: +(100 * idMatch / glyphsTotal).toFixed(2), glyphIdAndPositionMatchPct: +(100 * posMatch / glyphsTotal).toFixed(2), stringsExactPct: +(100 * stringsExact / corpus.length).toFixed(2), mismatches };
}

// Sanity: shaping actually did something (joining forms / conjunct reordering): count glyph ids != cmap ids.
function nonTrivial(corpus, fontIdx, family) {
  eng.setFamily(`"${family}"`);
  let changed = 0, total = 0;
  for (const text of corpus) {
    const L = eng.layout(text, { fontSize: upem });
    const ids = L.lines.flatMap((l) => l.runs.flatMap((r) => r.glyphs.map((g) => g.id)));
    const nominal = [...text].map((c) => hbFonts[fontIdx].font.nominalGlyph?.(c.codePointAt(0)));
    total++;
    if (ids.length !== nominal.length || ids.some((id, i) => id !== nominal[nominal.length - 1 - i] && id !== nominal[i])) changed++;
  }
  return { stringsWhereShapingChangedGlyphs: `${changed}/${total}` };
}

const results = {
  parleyVariant: variant,
  harfbuzz: hb.versionString(),
  upem,
  arabic: compare('Arabic', arabic, families[1]),
  devanagari: compare('Devanagari', devanagari, families[2]),
  // The app's real stack puts Noto Sans first. Google's Noto Sans also contains Devanagari, so Devanagari
  // is then shaped with Noto Sans' Devanagari glyphs, and Arabic word spaces come from Noto Sans (runs split per word).
  fullStack: (() => { const css = families.map((f) => `"${f}"`).join(', '); const strip = ({ mismatches, ...r }) => r; return { css, arabic: strip(compare('Arabic', arabic, null, [], css)), devanagari: strip(compare('Devanagari', devanagari, null, [], css)) }; })(),
  // Negative control: HarfBuzz with the script's shaping features switched off must NOT match.
  negativeControl: {
    arabicNoJoining: (({ glyphIdMatchPct, stringsExactPct }) => ({ glyphIdMatchPct, stringsExactPct }))(compare('Arabic', arabic, families[1], ['init', 'medi', 'fina', 'rlig', 'calt'].map((t) => new hb.Feature(t, 0)))),
    devanagariNoConjuncts: (({ glyphIdMatchPct, stringsExactPct }) => ({ glyphIdMatchPct, stringsExactPct }))(compare('Devanagari', devanagari, families[2], ['half', 'blwf', 'rphf', 'pres', 'blws', 'akhn', 'cjct'].map((t) => new hb.Feature(t, 0)))),
  },
  sanity: { arabic: nonTrivial(arabic, 1, families[1]), devanagari: nonTrivial(devanagari, 2, families[2]) },
};
fs.mkdirSync(path.join(root, 'results'), { recursive: true });
fs.writeFileSync(path.join(root, 'results/shaping.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify({ ...results, arabic: { ...results.arabic, mismatches: results.arabic.mismatches.slice(0, 5) }, devanagari: { ...results.devanagari, mismatches: results.devanagari.mismatches.slice(0, 5) } }, null, 2));
