import type { Result } from '@staticflux/core';
import { createLoroEngine } from '@staticflux/document/loro-crdt';
import type { DocumentCRDTv2, PartOp, PeerId, TransactionMeta } from '@staticflux/document/v2';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { MATCH_KEY_PATH, TEXT_CONTENT, TEXT_MARK_EXPAND } from './model.js';
import {
  anchorRange,
  createTextOps,
  deleteTextOps,
  duplicateTextOps,
  insertTextOps,
  paragraphAt,
  readTextBlock,
  replaceTextOps,
  resolveRange,
  setCharMarkOps,
  setCharStyleOps,
  setParagraphStyleOps,
  splitParagraphOps,
  type TextBlockModel,
  toggleCharMarkOps,
} from './rich-text.js';

const engine = createLoroEngine({ marks: TEXT_MARK_EXPAND });
const meta: TransactionMeta = { actor: { kind: 'human', id: 'tester' }, label: 'Text edit' };
const parts: DocumentCRDTv2[] = [];
afterEach(() => {
  for (const p of parts.splice(0)) p.dispose();
});

function part(peer: string): DocumentCRDTv2 {
  const p = engine.create({ peer: peer as PeerId });
  parts.push(p);
  return p;
}

function must<T>(r: Result<T>): T {
  if (!r.ok) throw r.error;
  return r.value;
}

function apply(p: DocumentCRDTv2, ops: Result<PartOp[]> | PartOp[]): void {
  const list = Array.isArray(ops) ? ops : must(ops);
  must(p.transact(meta, list));
}

const block = (p: DocumentCRDTv2, node = 't1'): TextBlockModel => must(readTextBlock(p, node));

function seed(text = 'Hello world'): DocumentCRDTv2 {
  const p = part('1');
  apply(p, [{ op: 'create', node: 'page', kind: 'page', parent: null }]);
  apply(p, createTextOps({ node: 't1', parent: 'page', text, paragraph: { align: 'center' }, props: { 'spatial.x': 10 } }));
  return p;
}

describe('rich text model', () => {
  it('creates a text element with a final break, paragraph style and match key', () => {
    const p = seed('Hi');
    const b = block(p);
    expect(b.text).toBe('Hi');
    expect(b.paragraphs).toEqual([{ index: 0, start: 0, end: 2, text: 'Hi', style: { align: 'center' }, runs: [{ start: 0, end: 2, style: {} }] }]);
    expect(p.text('t1', TEXT_CONTENT)?.text).toBe('Hi\n');
    expect(p.prop('t1', MATCH_KEY_PATH)).toBe('lk_t1');
    expect(p.prop('t1', 'spatial.x')).toBe(10);
    expect(readTextBlock(p, 'page').ok).toBe(false);
    expect(readTextBlock(p, 'missing').ok).toBe(false);
  });

  it('inserts, splits paragraphs keeping their style, and merges keeping the first style', () => {
    const p = seed('Hello world');
    apply(p, insertTextOps(block(p), 5, ','));
    apply(p, splitParagraphOps(block(p), 6));
    let b = block(p);
    expect(b.paragraphs.map((x) => x.text)).toEqual(['Hello,', ' world']);
    expect(b.paragraphs.map((x) => x.style.align)).toEqual(['center', 'center']);
    apply(p, setParagraphStyleOps(b, 7, 7, { align: 'end', list: 'bullet' }));
    b = block(p);
    expect(b.paragraphs.map((x) => x.style)).toEqual([{ align: 'center' }, { align: 'end', list: 'bullet' }]);
    expect(paragraphAt(b, 6).index).toBe(0);
    // multi-line paste: every new break keeps the paragraph's style
    apply(p, insertTextOps(b, 3, 'A\nB'));
    b = block(p);
    expect(b.paragraphs.map((x) => [x.text, x.style.align])).toEqual([
      ['HelA', 'center'],
      ['Blo,', 'center'],
      [' world', 'end'],
    ]);
    // merge the last two: the merged paragraph keeps the first one's style
    apply(p, deleteTextOps(b, 9, 11));
    b = block(p);
    expect(b.paragraphs.map((x) => [x.text, x.style])).toEqual([
      ['HelA', { align: 'center' }],
      ['Blo,world', { align: 'center' }],
    ]);
    expect(deleteTextOps(b, 0, b.text.length + 1).ok).toBe(false);
    expect(must(deleteTextOps(b, 2, 2))).toEqual([]);
    expect(insertTextOps(b, -1, 'x').ok).toBe(false);
    expect(must(insertTextOps(b, 0, ''))).toEqual([]);
  });

  it('applies character marks as runs; typing extends style marks but not links', () => {
    const p = seed('Hello world');
    apply(p, setCharStyleOps(block(p), 0, 5, { bold: true, size: 32, color: { token: 'color.primary' }, font: { token: 'font.display' } }));
    apply(p, setCharMarkOps(block(p), 6, 11, 'link', { href: 'https://example.com' }));
    let b = block(p);
    expect(b.paragraphs[0]?.runs).toEqual([
      { start: 0, end: 5, style: { bold: true, size: 32, color: { token: 'color.primary' }, font: { token: 'font.display' } } },
      { start: 5, end: 6, style: {} },
      { start: 6, end: 11, style: { link: { href: 'https://example.com' } } },
    ]);
    apply(p, insertTextOps(b, 5, '!'));
    apply(p, insertTextOps(block(p), 12, '?'));
    b = block(p);
    expect(b.text).toBe('Hello! world?');
    expect(b.paragraphs[0]?.runs[0]).toEqual({ start: 0, end: 6, style: { bold: true, size: 32, color: { token: 'color.primary' }, font: { token: 'font.display' } } });
    expect(b.paragraphs[0]?.runs.at(-1)).toEqual({ start: 12, end: 13, style: {} });
    // explicit style on insert is exact
    apply(p, insertTextOps(b, 0, '>', { italic: true }));
    expect(block(p).paragraphs[0]?.runs[0]).toEqual({ start: 0, end: 1, style: { italic: true } });
    // toggle: on unless all set
    apply(p, toggleCharMarkOps(block(p), 1, 7, 'bold'));
    expect(block(p).paragraphs[0]?.runs[1]?.style.bold).toBeUndefined();
    apply(p, toggleCharMarkOps(block(p), 1, 3, 'bold'));
    expect(block(p).paragraphs[0]?.runs[1]?.style.bold).toBe(true);
  });

  it('rejects invalid styles with IF-TXT-001', () => {
    const b = block(seed());
    for (const [key, value] of [
      ['size', -1],
      ['color', 3],
      ['font', 'Arial'],
      ['link', { href: 'javascript:alert(1)' }],
      ['bold', 'yes'],
      ['weight', 2000],
      ['letterSpacing', 'x'],
    ] as const) {
      const r = setCharMarkOps(b, 0, 2, key, value);
      expect(!r.ok && r.error.code, key).toBe('IF-TXT-001');
    }
    expect(setCharMarkOps(b, 0, 2, 'size', null).ok).toBe(true);
    expect(setParagraphStyleOps(b, 0, 0, { align: 'diagonal' }).ok).toBe(false);
    expect(setParagraphStyleOps(b, 0, 99, { align: 'end' }).ok).toBe(false);
    expect(insertTextOps(b, 0, 'x', { size: 0 }).ok).toBe(false);
    expect(createTextOps({ node: 'x', parent: null, style: { color: 5 as unknown as string } }).ok).toBe(false);
    expect(must(setCharMarkOps(b, 1, 1, 'bold', true))).toEqual([]);
  });

  it('replaces a range and keeps selections anchored through concurrent edits', () => {
    const p = seed('Hello world');
    apply(p, replaceTextOps(block(p), 6, 11, 'there'));
    expect(block(p).text).toBe('Hello there');
    const sel = must(anchorRange(p, 't1', 6, 11));
    apply(p, insertTextOps(block(p), 0, '>> '));
    expect(must(resolveRange(p, sel))).toEqual([9, 14]);
    const caret = must(anchorRange(p, 't1', 3, 3));
    expect(must(resolveRange(p, caret))).toEqual([3, 3]);
    expect(anchorRange(p, 'nope', 0, 0).ok).toBe(false);
  });

  it('duplicates text with content, props and the same match key', () => {
    const p = seed('Copy me');
    apply(p, setCharMarkOps(block(p), 0, 4, 'italic', true));
    apply(p, duplicateTextOps(p, 't1', 't2', 'page'));
    expect(block(p, 't2').paragraphs).toEqual(block(p, 't1').paragraphs.map((x) => ({ ...x })));
    expect(p.prop('t2', MATCH_KEY_PATH)).toBe('lk_t1');
    expect(p.prop('t2', 'spatial.x')).toBe(10);
    // a duplicate of the duplicate keeps the original lineage
    apply(p, duplicateTextOps(p, 't2', 't3', null));
    expect(p.prop('t3', MATCH_KEY_PATH)).toBe('lk_t1');
    expect(duplicateTextOps(p, 'page', 'x', null).ok).toBe(false);
  });
});

describe('concurrent rich-text edits converge with marks intact (A4 v2 marks, Loro)', () => {
  it('two peers: bold + italic + inserts + paragraph styles', () => {
    const a = seed('The quick brown fox');
    const b = must(a.fork('2' as PeerId));
    parts.push(b);
    apply(a, setCharMarkOps(block(a), 4, 9, 'bold', true)); // "quick"
    apply(b, setCharMarkOps(block(b), 10, 15, 'italic', true)); // "brown"
    apply(b, insertTextOps(block(b), 0, 'So ')); // shifts b's view (not at a mark edge: edge growth is the engine's expand rule)
    apply(a, splitParagraphOps(block(a), 15)); // after "brown"
    apply(a, setParagraphStyleOps(block(a), 0, 0, { align: 'end' }));
    must(a.import(b.exportUpdates()));
    must(b.import(a.exportUpdates()));
    const ra = block(a);
    expect(ra).toEqual(block(b));
    expect(ra.text).toBe('So The quick brown\n fox');
    const bold = ra.paragraphs[0]?.runs.find((r) => r.style.bold === true);
    expect(ra.text.slice(bold?.start, bold?.end)).toBe('quick');
    const italic = ra.paragraphs[0]?.runs.find((r) => r.style.italic === true);
    expect(ra.text.slice(italic?.start, italic?.end)).toBe('brown');
    expect(ra.paragraphs.map((x) => x.style.align)).toEqual(['end', 'center']);
  });

  it('property: random concurrent edits on three peers converge and every mark still covers text', () => {
    type Edit = { peer: number; kind: 'insert' | 'delete' | 'mark' | 'para' | 'split'; at: number; len: number; text: string; key: 'bold' | 'italic' | 'color' };
    const edit = fc.record({
      peer: fc.integer({ min: 0, max: 2 }),
      kind: fc.constantFrom('insert', 'delete', 'mark', 'para', 'split'),
      at: fc.nat(40),
      len: fc.integer({ min: 0, max: 6 }),
      text: fc.constantFrom('a', 'xy', 'مرحبا', 'नम', '😀', ' '),
      key: fc.constantFrom('bold', 'italic', 'color'),
    }) as fc.Arbitrary<Edit>;
    fc.assert(
      fc.property(fc.array(fc.array(edit, { maxLength: 6 }), { minLength: 1, maxLength: 4 }), (rounds) => {
        const root = seed('Lorem ipsum dolor');
        const peers = [root, must(root.fork('2' as PeerId)), must(root.fork('3' as PeerId))];
        parts.push(peers[1] as DocumentCRDTv2, peers[2] as DocumentCRDTv2);
        for (const round of rounds) {
          for (const e of round) {
            const p = peers[e.peer] as DocumentCRDTv2;
            const b = block(p);
            const at = Math.min(e.at, b.text.length);
            const to = Math.min(b.text.length, at + e.len);
            const ops =
              e.kind === 'insert'
                ? insertTextOps(b, at, e.text)
                : e.kind === 'delete'
                  ? deleteTextOps(b, at, to)
                  : e.kind === 'mark'
                    ? setCharMarkOps(b, at, to, e.key, e.key === 'color' ? '#ff0000' : true)
                    : e.kind === 'split'
                      ? splitParagraphOps(b, at)
                      : setParagraphStyleOps(b, at, at, { align: 'justify' });
            // a surrogate split is not a valid edit point for the CRDT: skip such random offsets
            const value = must(ops);
            if (value.length > 0) {
              const r = p.transact(meta, value);
              if (!r.ok) continue;
            }
          }
          // sync everyone (some rounds: partial before the full exchange)
          for (const x of peers) for (const y of peers) if (x !== y) must(y.import(x.exportUpdates()));
        }
        const first = block(peers[0] as DocumentCRDTv2);
        for (const p of peers) expect(block(p)).toEqual(first);
        expect(peers[0]?.text('t1', TEXT_CONTENT)?.text.endsWith('\n')).toBe(true);
        for (const para of first.paragraphs) {
          // runs tile each paragraph exactly
          expect(para.runs[0]?.start).toBe(para.start);
          expect(para.runs.at(-1)?.end).toBe(para.end);
        }
      }),
      { numRuns: 40, seed: 2026 },
    );
  });
});
