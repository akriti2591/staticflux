// @vitest-environment node
/**
 * Shaping parity (IF-7.6; S3 measured 100%): Parley in the built authoring Wasm vs HarfBuzz (harfbuzzjs) on 40 Arabic
 * and 40 Devanagari strings. Per Parley run, HarfBuzz shapes the same run with the full string as context, same font,
 * same direction, at size = upem. Glyph ids and absolute positions (pen + offsets) must match. A negative control
 * (HarfBuzz with the script's shaping features off) must NOT match, so the comparison is meaningful.
 */
import * as hb from 'harfbuzzjs';
import { beforeAll, describe, expect, it } from 'vitest';
import { encodeLayoutSpec, familyList } from './layout-spec.js';
import type { TextLayoutEngine } from './text-engine.js';
import { authoringBuilt, testFont, testTextEngine } from './test-helpers.js';
import { ARABIC_CORPUS, DEVANAGARI_CORPUS } from './testing/corpus.js';

const required = process.env['SF_REQUIRE_RUST'] === '1';

interface Score {
  readonly glyphs: number;
  readonly matched: number;
  readonly strings: number;
  readonly exact: number;
  readonly mismatches: string[];
}

function makeFont(file: string): { font: hb.Font; upem: number } {
  const { bytes } = testFont(file);
  const face = new hb.Face(new hb.Blob(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
  return { font: new hb.Font(face), upem: face.upem };
}

describe.skipIf(!authoringBuilt && !required)('shaping parity: Parley (authoring Wasm) vs HarfBuzz', () => {
  let engine: TextLayoutEngine;
  const hbFonts: { font: hb.Font; upem: number }[] = [];
  beforeAll(async () => {
    expect(authoringBuilt, 'run `pnpm build` (authoring Wasm)').toBe(true);
    engine = await testTextEngine();
    for (const f of ['NotoSans-Latin.wght.ttf', 'NotoSansArabic.wght.ttf', 'NotoSansDevanagari.wght.ttf']) hbFonts.push(makeFont(f));
  });

  function compare(corpus: readonly string[], family: string, features: hb.Feature[] = []): Score {
    let glyphs = 0;
    let matched = 0;
    let exact = 0;
    const mismatches: string[] = [];
    corpus.forEach((text, n) => {
      const size = hbFonts[1]?.upem ?? 1000;
      const spec = encodeLayoutSpec({ width: 0, paragraphs: [{ text, spans: [{ start: 0, end: text.length, family: familyList([family, 'Noto Sans']), size }] }] });
      const layout = engine.layout(1000 + n, spec, text);
      if (!layout.ok) throw layout.error;
      let ok = true;
      for (const run of layout.value.runs()) {
        const line = layout.value.lines()[run.line];
        const target = hbFonts[run.font];
        if (line === undefined || target === undefined) throw new Error(`run without line or font: ${JSON.stringify(run)}`);
        const buf = new hb.Buffer();
        buf.addText(text, run.start, run.end - run.start);
        buf.guessSegmentProperties();
        buf.setDirection(run.rtl ? hb.Direction.RTL : hb.Direction.LTR);
        hb.shape(target.font, buf, features);
        const infos = buf.getGlyphInfos();
        const pos = buf.getGlyphPositions();
        let pen = (run.glyphs[0]?.x ?? 0) - (pos[0]?.xOffset ?? 0);
        const count = Math.max(infos.length, run.glyphs.length);
        for (let i = 0; i < count; i++) {
          glyphs += 1;
          const p = run.glyphs[i];
          const h = infos[i];
          const hp = pos[i];
          const same = p !== undefined && h !== undefined && hp !== undefined && p.id === h.codepoint && Math.abs(p.x - (pen + hp.xOffset)) < 0.1 && Math.abs(line.baseline - p.y - hp.yOffset) < 0.1;
          if (hp !== undefined) pen += hp.xAdvance;
          if (same) matched += 1;
          else {
            ok = false;
            if (mismatches.length < 5) mismatches.push(`${text} [${run.start},${run.end}) #${i}: parley ${JSON.stringify(p)} harfbuzz ${JSON.stringify({ id: h?.codepoint, ...hp })}`);
          }
        }
      }
      if (ok) exact += 1;
      engine.drop(1000 + n);
    });
    return { glyphs, matched, strings: corpus.length, exact, mismatches };
  }

  it('Arabic: 100% glyph ids and positions (lam-alef, harakat, Persian/Urdu, bidi digits, mirroring)', () => {
    const s = compare(ARABIC_CORPUS, 'Noto Sans Arabic');
    expect(s.mismatches).toEqual([]);
    expect(s.matched).toBe(s.glyphs);
    expect(s.glyphs).toBeGreaterThan(500);
    const control = compare(ARABIC_CORPUS, 'Noto Sans Arabic', ['init', 'medi', 'fina', 'rlig', 'calt'].map((t) => new hb.Feature(t, 0)));
    expect(control.matched / control.glyphs).toBeLessThan(0.8);
  });

  it('Devanagari: 100% glyph ids and positions (conjuncts, reph, pre-base matra, nukta, ZWJ/ZWNJ)', () => {
    const s = compare(DEVANAGARI_CORPUS, 'Noto Sans Devanagari');
    expect(s.mismatches).toEqual([]);
    expect(s.matched).toBe(s.glyphs);
    expect(s.glyphs).toBeGreaterThan(200);
    const control = compare(DEVANAGARI_CORPUS, 'Noto Sans Devanagari', ['half', 'blwf', 'rphf', 'pres', 'blws', 'akhn', 'cjct'].map((t) => new hb.Feature(t, 0)));
    expect(control.matched / control.glyphs).toBeLessThan(0.8);
  });
});
