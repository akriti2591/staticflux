// @vitest-environment node
/**
 * The text pipeline end to end on the built authoring Wasm and a Loro part: model → styles → layout → scene IR,
 * an editing session driven by TextInput intents (typing, IME preview/commit, deletes by grapheme, Enter, arrows),
 * the typography service (Fit to box) and the accessibility data for B6.
 */
import { err, ok, type Result } from '@staticflux/core';
import { createLoroEngine } from '@staticflux/document/loro-crdt';
import type { DocumentCRDTv2, PartOp, PeerId } from '@staticflux/document/v2';
import type { TextInput, TextInputState, TextIntent, TextRange } from '@staticflux/surface/text-input';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSceneWriter } from '../render/scene-ir.js';
import { textAccessibility, textAccessibleNode } from './a11y.js';
import { TEXT_HUD_COMMANDS, TextIds } from './contributions.js';
import { encodeLayoutSpec } from './layout-spec.js';
import type { TextLayout } from './layout-result.js';
import { TEXT_MARK_EXPAND } from './model.js';
import { createTextOps, readTextBlock, setCharMarkOps, type TextBlockModel } from './rich-text.js';
import type { TextLayoutEngine } from './text-engine.js';
import { createSceneFontTable, hashBytes, textSceneNodes } from './text-scene.js';
import { createTextSession } from './text-session.js';
import { resolveTextLayout } from './text-style.js';
import { authoringBuilt, testFont, testTextEngine } from './test-helpers.js';
import { createTypographyService, summarizeTypography } from './typography.js';

const required = process.env['SF_REQUIRE_RUST'] === '1';
const meta = { actor: { kind: 'human', id: 'u' }, label: 'Edit' };
const NOTO = testFont('NotoSans-Latin.wght.ttf');
const ARABIC = testFont('NotoSansArabic.wght.ttf');
const DEVA = testFont('NotoSansDevanagari.wght.ttf');
const families = (hash: string): readonly string[] | undefined => ({ [NOTO.hash]: ['Noto Sans'], [ARABIC.hash]: ['Noto Sans Arabic'], [DEVA.hash]: ['Noto Sans Devanagari'] })[hash];

/** A scripted TextInput: tests emit intents; the session's pushes are recorded. */
function fakeInput() {
  const intents = new Set<(i: TextIntent) => void>();
  const bounds = new Set<(r: TextRange) => void>();
  let state: TextInputState = { text: '', selection: [0, 0] };
  const log = { selectionBounds: [] as { x: number; y: number }[], characterBounds: [] as { start: number; count: number }[] };
  let composing = false;
  const input: TextInput = {
    kind: 'hidden-textarea',
    focus: () => undefined,
    blur: () => undefined,
    focused: true,
    get composing() {
      return composing;
    },
    get state() {
      return state;
    },
    setState: (s) => {
      state = s;
    },
    setControlBounds: () => undefined,
    setSelectionBounds: (r) => log.selectionBounds.push({ x: r.x, y: r.y }),
    setCharacterBounds: (start, rects) => log.characterBounds.push({ start, count: rects.length }),
    onIntent: (l) => {
      intents.add(l);
      return () => intents.delete(l);
    },
    onBoundsRequest: (l) => {
      bounds.add(l);
      return () => bounds.delete(l);
    },
    dispose: () => undefined,
  };
  const emit = (i: TextIntent): void => {
    if (i.kind === 'compose-start') composing = true;
    if (i.kind === 'compose-commit' || i.kind === 'compose-cancel') composing = false;
    for (const l of [...intents]) l(i);
  };
  return { input, emit, requestBounds: (r: TextRange) => [...bounds].forEach((l) => l(r)), log, get state() { return state; } };
}

describe.skipIf(!authoringBuilt && !required)('text pipeline (authoring Wasm + Loro)', () => {
  let engine: TextLayoutEngine;
  const parts: DocumentCRDTv2[] = [];
  beforeAll(async () => {
    engine = await testTextEngine();
  });
  afterEach(() => {
    for (const p of parts.splice(0)) p.dispose();
  });

  function seed(text: string): DocumentCRDTv2 {
    const part = createLoroEngine({ marks: TEXT_MARK_EXPAND }).create({ peer: '7' as PeerId });
    parts.push(part);
    const ops = createTextOps({ node: 't', parent: null, text });
    if (!ops.ok) throw ops.error;
    const r = part.transact(meta, ops.value);
    if (!r.ok) throw r.error;
    return part;
  }
  const read = (part: DocumentCRDTv2): TextBlockModel => {
    const b = readTextBlock(part, 't');
    if (!b.ok) throw b.error;
    return b.value;
  };
  const layoutOf = (block: TextBlockModel, width = 200, scale = 1): Result<TextLayout> => {
    const resolved = resolveTextLayout(block, { width, defaults: { font: { font: NOTO.hash }, size: 20 * scale, color: '#111111', fallback: ['Noto Sans Arabic', 'Noto Sans Devanagari'] }, families });
    return engine.layout(1, encodeLayoutSpec(resolved.spec), block.text);
  };

  it('projects glyph runs and decorations into the scene IR, uploading each font once per hash', () => {
    const part = seed('Hello مرحبا नमस्ते');
    const link = setCharMarkOps(read(part), 0, 5, 'link', { href: 'https://instaflow.test' });
    if (!link.ok) throw link.error;
    expect(part.transact(meta, link.value).ok).toBe(true);
    const block = read(part);
    const resolved = resolveTextLayout(block, { width: 400, defaults: { font: { font: NOTO.hash }, size: 24, color: '#000' }, families });
    const layout = engine.layout(1, encodeLayoutSpec(resolved.spec), block.text);
    if (!layout.ok) throw layout.error;
    const table = createSceneFontTable();
    const bytesByAuthoringId = (id: number) => engine.fontOf(id)?.hash;
    const writer = createSceneWriter();
    const used = new Set(layout.value.runs().map((r) => r.font));
    for (const id of used) {
      const hash = bytesByAuthoringId(id) as string;
      expect(table.ensure(writer, hash, () => testFontBytes(hash))).toBe(true);
      expect(table.ensure(writer, hash, () => undefined)).toBe(true); // already announced: no op
    }
    let next = 100;
    const nodes = textSceneNodes(layout.value, { id: 10, transform: [1, 0, 0, 1, 50, 60], brushes: resolved.brushes, fontId: (id) => table.idFor(bytesByAuthoringId(id) as string), nextId: () => next++ });
    for (const n of nodes) writer.upsert(n);
    expect(writer.ops).toBe(used.size + nodes.length);
    expect(nodes[0]).toMatchObject({ id: 10, geometry: { kind: 'group' } });
    const glyphNodes = nodes.filter((n) => n.geometry.kind === 'glyphs');
    expect(glyphNodes.length).toBe(layout.value.runs().length);
    expect(nodes.filter((n) => n.geometry.kind === 'rect')).toHaveLength(1); // the link underline
    expect(table.sent.size).toBe(used.size);
    // resnapshot: aliases only; reset: bytes again
    table.resnapshot();
    const w2 = createSceneWriter();
    table.ensure(w2, NOTO.hash, () => undefined);
    expect(w2.finish().length).toBeLessThan(200);
    table.reset();
    expect(table.ensure(createSceneWriter(), NOTO.hash, () => undefined)).toBe(false);
    expect(() => hashBytes('sha256:xyz')).toThrow(RangeError);
  });

  it('an editing session: typing, IME preview then commit, grapheme deletes, Enter, arrows, bounds for the IME', () => {
    const part = seed('Hi');
    const f = fakeInput();
    const problems: string[] = [];
    const session = createTextSession({
      input: f.input,
      engine,
      blockId: 1,
      target: {
        read: () => readTextBlock(part, 't'),
        commit: (ops: readonly PartOp[], label: string) => {
          const r = part.transact({ ...meta, label }, ops);
          return r.ok ? ok(undefined) : err(r.error);
        },
      },
      layout: (m) => layoutOf(m),
      toClient: (r) => ({ x: 1000 + r.x0, y: 500 + r.y0, width: r.x1 - r.x0, height: r.y1 - r.y0 }),
      onProblem: (e) => problems.push(e.code),
    });
    if (!session.ok) throw session.error;
    const s = session.value;
    expect(f.state).toEqual({ text: 'Hi', selection: [2, 2] });
    f.emit({ kind: 'insert', text: ' there', range: [2, 2] });
    expect(read(part).text).toBe('Hi there');
    // IME: preview is local; the document changes only on commit
    f.emit({ kind: 'compose-start', range: [8, 8] });
    f.emit({ kind: 'compose-update', text: 'にほ', range: [8, 8], selection: [10, 10] });
    expect(read(part).text).toBe('Hi there');
    expect(s.state.composition?.text).toBe('にほ');
    expect(f.log.characterBounds.at(-1)).toEqual({ start: 8, count: 2 });
    f.requestBounds([8, 10]);
    expect(f.log.characterBounds.at(-1)).toEqual({ start: 8, count: 2 });
    f.emit({ kind: 'compose-commit', text: '日本', range: [8, 10] });
    expect(read(part).text).toBe('Hi there日本');
    expect(s.selection).toEqual([10, 10]);
    // Backspace (collapsed) removes one grapheme
    f.emit({ kind: 'delete', range: [10, 10], direction: 'backward', unit: 'grapheme' });
    expect(read(part).text).toBe('Hi there日');
    // a Devanagari conjunct + matra is one grapheme: removed whole
    f.emit({ kind: 'insert', text: ' क्षा', range: [9, 9] });
    f.emit({ kind: 'delete', range: [14, 14], direction: 'backward', unit: 'grapheme' });
    expect(read(part).text).toBe('Hi there日 ');
    // word delete
    f.emit({ kind: 'delete', range: [10, 10], direction: 'backward', unit: 'word' });
    expect(read(part).text.length).toBeLessThan(10);
    // Enter splits the paragraph; arrows move through the layout
    s.select(2, 2);
    f.emit({ kind: 'key', key: 'Enter', shift: false, mod: false, alt: false });
    expect(read(part).paragraphs).toHaveLength(2);
    expect(s.selection).toEqual([3, 3]);
    f.emit({ kind: 'key', key: 'ArrowLeft', shift: false, mod: false, alt: false });
    expect(s.selection).toEqual([2, 2]);
    f.emit({ kind: 'key', key: 'End', shift: true, mod: true, alt: false });
    expect(s.selection).toEqual([2, read(part).text.length]);
    f.emit({ kind: 'key', key: 'ArrowRight', shift: false, mod: false, alt: false });
    expect(s.selection).toEqual([read(part).text.length, read(part).text.length]);
    f.emit({ kind: 'key', key: 'SelectAll', shift: false, mod: true, alt: false });
    expect(s.selection).toEqual([0, read(part).text.length]);
    f.emit({ kind: 'key', key: 'ArrowUp', shift: false, mod: false, alt: false });
    f.emit({ kind: 'selection', selection: [1, 1] });
    expect(s.selection).toEqual([1, 1]);
    // the IME anchor followed the caret in client px
    expect(f.log.selectionBounds.at(-1)?.x).toBeGreaterThan(1000);
    // typing style applies to the next insert
    s.setTypingStyle({ bold: true });
    f.emit({ kind: 'insert', text: 'B', range: [1, 1] });
    expect(read(part).paragraphs[0]?.runs.find((r) => r.style.bold === true)).toMatchObject({ start: 1, end: 2 });
    // cancelled composition leaves nothing; remote refresh keeps the selection in range
    f.emit({ kind: 'compose-start', range: [0, 0] });
    f.emit({ kind: 'compose-cancel', range: [0, 0] });
    s.refresh();
    let changes = 0;
    const off = s.onChange(() => (changes += 1));
    f.emit({ kind: 'insert', text: 'x', range: [0, 0] });
    off();
    expect(changes).toBeGreaterThan(0);
    // an invalid range is reported, not thrown
    f.emit({ kind: 'key', key: 'Escape', shift: false, mod: false, alt: false });
    expect(problems).toEqual([]);
    s.dispose();
  });

  it('typography: summary, commands and Fit to box (HUD)', () => {
    const part = seed('Fit this text into a small box please');
    let selection: [number, number] = [0, 0];
    const commit = (ops: readonly PartOp[], label: string) => {
      const r = part.transact({ ...meta, label }, ops);
      return r.ok ? ok(undefined) : err(r.error);
    };
    const service = createTypographyService({
      current: () => ({ block: read(part), from: selection[0], to: selection[1] }),
      commit,
      defaults: { size: 20 },
      measure: (scale) => {
        const l = layoutOf(read(part), 200, scale);
        return l.ok ? ok({ height: l.value.height, box: 40 }) : l;
      },
      fonts: () => [{ label: 'Noto Sans', value: { font: NOTO.hash } }],
    });
    expect(service.summary()).toMatchObject({ size: 20, bold: false, align: 'start' });
    selection = [0, 3];
    expect(service.toggle('bold').ok).toBe(true);
    expect(service.summary()).toMatchObject({ bold: true, weight: 700 });
    selection = [0, 10];
    expect(service.summary()?.bold).toBe('mixed');
    expect(service.setSize(32).ok).toBe(true);
    expect(service.setAlign('center').ok).toBe(true);
    expect(service.setColor('#ff0000').ok).toBe(true);
    expect(service.setLink('https://a.test').ok).toBe(true);
    expect(service.setLink(null).ok).toBe(true);
    expect(service.setLineHeight(1.5).ok).toBe(true);
    expect(service.setLetterSpacing(1).ok).toBe(true);
    expect(service.setWeight(500).ok).toBe(true);
    expect(service.setFont({ font: NOTO.hash }).ok).toBe(true);
    expect(service.setSize(-3).ok).toBe(false);
    expect(summarizeTypography(read(part), 0, 10, { size: 20 })).toMatchObject({ size: 32, align: 'center', color: '#ff0000', lineHeight: 1.5 });
    const fit = TEXT_HUD_COMMANDS[TextIds.hud.fit];
    expect(fit?.(service).ok).toBe(true);
    const after = layoutOf(read(part));
    expect(after.ok && after.value.height).toBeLessThanOrEqual(40.5);
    expect(TEXT_HUD_COMMANDS[TextIds.hud.font]).toBeUndefined();
    const none = createTypographyService({ current: () => undefined, commit, defaults: { size: 20 } });
    expect(none.summary()).toBeUndefined();
    expect(none.setSize(10).ok).toBe(false);
    expect(none.fontChoices()).toEqual([]);
    expect(service.fontChoices()).toHaveLength(1);
  });

  it('accessibility data for B6: text, lines, links, role and selection', () => {
    const part = seed('Big sale today and tomorrow, read the terms');
    const at = read(part).text.indexOf('the terms');
    const link = setCharMarkOps(read(part), at, at + 9, 'link', { href: 'https://terms.test' });
    if (!link.ok) throw link.error;
    part.transact(meta, link.value);
    const block = read(part);
    const layout = layoutOf(block, 150);
    if (!layout.ok) throw layout.error;
    const data = textAccessibility(block, layout.value, { id: 'n4', semanticRole: 'headline' });
    expect(data).toMatchObject({ id: 'n4', role: 'heading', level: 1, text: block.text, editing: false });
    expect(data.lines.length).toBeGreaterThan(1);
    expect(data.lines.map((l) => l.text).join(' ')).toBe(block.text);
    expect(data.links).toEqual([expect.objectContaining({ href: 'https://terms.test', text: 'the terms' })]);
    expect(data.links[0]?.bounds.width).toBeGreaterThan(0);
    const editing = textAccessibility(block, layout.value, { id: 'n4', editing: true, selection: [0, 3], toSurface: (b) => ({ x0: b.x0 * 2, y0: b.y0 * 2, x1: b.x1 * 2, y1: b.y1 * 2 }) });
    expect(editing).toMatchObject({ role: 'textbox', selection: [0, 3] });
    expect(editing.bounds.width).toBeCloseTo(layout.value.width * 2);
    const node = textAccessibleNode(data);
    expect(node).toMatchObject({ id: 'n4', role: 'heading', text: block.text, focusable: true, description: 'Heading level 1' });
    expect(node.children?.map((c) => c.role)).toEqual(['paragraph', 'link']);
    expect(textAccessibility(block, layout.value, { id: 'x', semanticRole: 'unknown-role' }).role).toBe('paragraph');
  });
});

function testFontBytes(hash: string): Uint8Array | undefined {
  return [NOTO, ARABIC, DEVA, testFont('NotoSansThai.wght.ttf')].find((f) => f.hash === hash)?.bytes;
}
