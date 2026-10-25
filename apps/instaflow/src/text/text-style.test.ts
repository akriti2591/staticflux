import { describe, expect, it } from 'vitest';
import { createLoroEngine } from '@staticflux/document/loro-crdt';
import type { PeerId, PartOp } from '@staticflux/document/v2';
import { TEXT_MARK_EXPAND } from './model.js';
import { createTextOps, readTextBlock, setCharStyleOps, setParagraphStyleOps } from './rich-text.js';
import { type BrandTokenSource, parseCssColor, resolveColor, resolveFont, resolveTextLayout } from './text-style.js';

const brand: BrandTokenSource = {
  color: (t) => (({ 'color.primary': '#2255ff', 'color.bad': 'nonsense' }) as Record<string, string>)[t.token],
  font: (t) => (t.token === 'font.display' ? { font: 'sha256:aa' } : t.token === 'font.loop' ? { token: 'font.loop' } : undefined),
};
const families = (hash: string): readonly string[] | undefined => ({ 'sha256:aa': ['Display Sans'], 'sha256:bb': ['Body Serif'] })[hash];

describe('colour and font resolution', () => {
  it('parses CSS colours', () => {
    expect(parseCssColor('#f00')).toEqual({ ok: true, value: [255, 0, 0, 255] });
    expect(parseCssColor('#11223344')).toEqual({ ok: true, value: [17, 34, 51, 68] });
    expect(parseCssColor('rgba(1, 2, 3, 0.5)')).toEqual({ ok: true, value: [1, 2, 3, 128] });
    expect(parseCssColor('rgb(300 2 3 / 50%)')).toEqual({ ok: true, value: [255, 2, 3, 128] });
    expect(parseCssColor('White')).toEqual({ ok: true, value: [255, 255, 255, 255] });
    expect(parseCssColor('hsl(1 2 3)').ok).toBe(false);
  });

  it('resolves brand tokens and reports unresolved ones as IF-TXT-009', () => {
    expect(resolveColor({ token: 'color.primary' }, brand)).toEqual({ ok: true, value: [34, 85, 255, 255] });
    const missing = resolveColor({ token: 'color.none' }, brand);
    expect(!missing.ok && missing.error.code).toBe('IF-TXT-009');
    expect(resolveFont({ token: 'font.display' }, brand, families)).toEqual({ ok: true, value: ['Display Sans'] });
    expect(resolveFont({ font: 'sha256:bb' }, undefined, families)).toEqual({ ok: true, value: ['Body Serif'] });
    expect(resolveFont({ token: 'font.loop' }, brand, families).ok).toBe(false);
    expect(resolveFont({ font: 'sha256:cc' }, brand, families).ok).toBe(false);
  });
});

describe('resolveTextLayout', () => {
  it('builds spans per run, a deduplicated brush table and paragraph settings; problems fall back', () => {
    const part = createLoroEngine({ marks: TEXT_MARK_EXPAND }).create({ peer: '1' as PeerId });
    const meta = { actor: { kind: 'human', id: 'u' }, label: 'x' };
    const apply = (ops: { ok: boolean; value?: PartOp[] }): void => {
      if (!ops.ok || ops.value === undefined) throw new Error('ops');
      const r = part.transact(meta, ops.value);
      if (!r.ok) throw r.error;
    };
    apply(createTextOps({ node: 't', parent: null, text: 'Big blue link' }));
    const block = () => {
      const b = readTextBlock(part, 't');
      if (!b.ok) throw b.error;
      return b.value;
    };
    apply(setCharStyleOps(block(), 0, 3, { bold: true, size: 40, font: { token: 'font.display' } }));
    apply(setCharStyleOps(block(), 4, 8, { color: { token: 'color.primary' }, italic: true }));
    apply(setCharStyleOps(block(), 9, 13, { link: { href: 'https://x.test' }, color: { token: 'color.bad' } }));
    apply(setParagraphStyleOps(block(), 0, 0, { align: 'center', lineHeight: 1.4, spaceAfter: 6, indent: 10 }));
    const r = resolveTextLayout(block(), { width: 300, defaults: { font: { font: 'sha256:bb' }, size: 16, color: '#000000', fallback: ['Noto Sans'] }, brand, families });
    const p = r.spec.paragraphs[0];
    expect(p?.align).toBe('center');
    expect([p?.lineHeight, p?.spaceAfter, p?.indent]).toEqual([1.4, 6, 10]);
    expect(p?.spans.map((s) => [s.start, s.end, s.family, s.size, s.weight, s.italic, s.underline, s.brush])).toEqual([
      [0, 3, '"Display Sans", "Noto Sans"', 40, 700, false, false, 0],
      [3, 4, '"Body Serif", "Noto Sans"', 16, 400, false, false, 0],
      [4, 8, '"Body Serif", "Noto Sans"', 16, 400, true, false, 1],
      [8, 9, '"Body Serif", "Noto Sans"', 16, 400, false, false, 0],
      [9, 13, '"Body Serif", "Noto Sans"', 16, 400, false, true, 2],
    ]);
    expect(r.brushes).toEqual([{ color: [0, 0, 0, 255] }, { color: [34, 85, 255, 255] }, { color: [0, 0, 0, 255], link: 'https://x.test' }]);
    expect(r.problems.map((e) => e.code)).toEqual(['IF-TXT-001']);
    const fallback = resolveTextLayout(block(), { width: 0, defaults: { font: { token: 'font.none' }, size: 12, color: { token: 'color.none' } }, families });
    expect(fallback.problems.length).toBeGreaterThanOrEqual(2);
    part.dispose();
  });
});
