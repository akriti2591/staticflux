// @vitest-environment node
/**
 * B12 text gaps (TEXT §11.2; IF-37.12–37.20): undo coalescing while typing (T-2), platform caret keys (T-3), tofu data
 * (T-4), sub/superscript (T-5), soft line breaks (T-6), Tab in lists (T-8) and fixed-box vertical alignment (T-1).
 */
import { err, ok } from '@staticflux/core';
import { createLoroEngine } from '@staticflux/document/loro-crdt';
import type { DocumentCRDTv2, PartOp, PeerId } from '@staticflux/document/v2';
import type { TextInput, TextIntent } from '@staticflux/surface/text-input';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { encodeLayoutSpec } from './layout-spec.js';
import { checkCharMark, checkParagraphField, LIST_MAX_LEVEL, ParaMark, TEXT_MARK_EXPAND } from './model.js';
import { createTextOps, listIndentOps, readTextBlock, setCharMarkOps, setParagraphStyleOps, type TextBlockModel } from './rich-text.js';
import type { TextLayoutEngine } from './text-engine.js';
import { missingGlyphs, NOTDEF_GLYPH, textSceneNodes } from './text-scene.js';
import { caretMotionFor, createTextSession, LINE_SEPARATOR, TYPING_PAUSE_MS } from './text-session.js';
import { overflowLines, resolveTextLayout, SCRIPT_METRICS, scriptMetrics, verticalAlignOffset } from './text-style.js';
import { authoringBuilt, testFont, testTextEngine } from './test-helpers.js';

const meta = { actor: { kind: 'human', id: 'u' }, label: 'Edit' };
const NOTO = testFont('NotoSans-Latin.wght.ttf');
const families = (hash: string): readonly string[] | undefined => (hash === NOTO.hash ? ['Noto Sans'] : undefined);
const defaults = { font: { font: NOTO.hash }, size: 20, color: '#111111' } as const;

describe('platform caret keys (T-3)', () => {
  it('Mac: Option jumps words, Command jumps to the line edge; elsewhere Ctrl jumps words', () => {
    expect(caretMotionFor('ArrowLeft', { mod: false, alt: true }, true)).toBe('wordLeft');
    expect(caretMotionFor('ArrowRight', { mod: true, alt: false }, true)).toBe('lineEnd');
    expect(caretMotionFor('ArrowLeft', { mod: true, alt: false }, true)).toBe('lineStart');
    expect(caretMotionFor('ArrowRight', { mod: false, alt: false }, true)).toBe('right');
    expect(caretMotionFor('ArrowRight', { mod: true, alt: false }, false)).toBe('wordRight');
    expect(caretMotionFor('ArrowLeft', { mod: false, alt: true }, false)).toBe('left');
    expect(caretMotionFor('Home', { mod: true, alt: false }, true)).toBe('textStart');
    expect(caretMotionFor('End', { mod: false, alt: false }, false)).toBe('lineEnd');
  });
});

describe('text model and style data (T-1, T-5, T-8)', () => {
  it('checks the script mark and the list level', () => {
    expect(checkCharMark('script', 'super')).toBeUndefined();
    expect(checkCharMark('script', 'up')).toBeDefined();
    expect(checkParagraphField('level', 3)).toBeUndefined();
    expect(checkParagraphField('level', LIST_MAX_LEVEL + 1)).toBeDefined();
    expect(checkParagraphField('level', 1.5)).toBeDefined();
    expect(TEXT_MARK_EXPAND.script).toBe('after');
  });

  it('scales and shifts sub/superscript; aligns only fixed boxes; counts overflowing lines', () => {
    expect(scriptMetrics(20, undefined)).toEqual({ size: 20, shift: 0 });
    expect(scriptMetrics(20, 'super')).toEqual({ size: 20 * SCRIPT_METRICS.scale, shift: 20 * SCRIPT_METRICS.superShift });
    expect(scriptMetrics(20, 'sub').shift).toBeGreaterThan(0);
    expect(verticalAlignOffset('fixed', 'middle', 100, 40)).toBe(30);
    expect(verticalAlignOffset('fixed', 'bottom', 100, 40)).toBe(60);
    expect(verticalAlignOffset('fixed', 'top', 100, 40)).toBe(0);
    expect(verticalAlignOffset('auto-height', 'bottom', 100, 40)).toBe(0);
    expect(verticalAlignOffset('fixed', 'bottom', 30, 40)).toBe(0); // overflow starts at the top
    const lines = [{ bounds: { y1: 20 } }, { bounds: { y1: 40 } }, { bounds: { y1: 60 } }];
    expect(overflowLines(lines, 40)).toBe(1);
    expect(overflowLines(lines, 100)).toBe(0);
  });
});

/** A scripted TextInput (see text-pipeline.test.ts). */
function fakeInput() {
  const intents = new Set<(i: TextIntent) => void>();
  let state = { text: '', selection: [0, 0] as readonly [number, number] };
  const input = {
    kind: 'hidden-textarea',
    focus: () => undefined,
    blur: () => undefined,
    focused: true,
    composing: false,
    get state() {
      return state;
    },
    setState: (s: typeof state) => {
      state = s;
    },
    setControlBounds: () => undefined,
    setSelectionBounds: () => undefined,
    setCharacterBounds: () => undefined,
    onIntent: (l: (i: TextIntent) => void) => {
      intents.add(l);
      return () => intents.delete(l);
    },
    onBoundsRequest: () => () => undefined,
    dispose: () => undefined,
  } as unknown as TextInput;
  return { input, emit: (i: TextIntent) => [...intents].forEach((l) => l(i)) };
}

const key = (k: 'Enter' | 'Tab' | 'ArrowLeft' | 'ArrowRight', shift = false): TextIntent => ({ kind: 'key', key: k, shift, mod: false, alt: false });

describe.skipIf(!authoringBuilt)('text session and layout on the authoring Wasm (B12)', () => {
  let engine: TextLayoutEngine;
  const parts: DocumentCRDTv2[] = [];
  beforeAll(async () => {
    engine = await testTextEngine();
  });
  afterEach(() => {
    for (const p of parts.splice(0)) p.dispose();
  });
  const seed = (text: string, extra: (block: TextBlockModel) => PartOp[] = () => []): DocumentCRDTv2 => {
    const part = createLoroEngine({ marks: TEXT_MARK_EXPAND }).create({ peer: '9' as PeerId });
    parts.push(part);
    const ops = createTextOps({ node: 't', parent: null, text });
    if (!ops.ok) throw ops.error;
    if (!part.transact(meta, ops.value).ok) throw new Error('seed');
    const more = extra(read(part));
    if (more.length > 0 && !part.transact(meta, more).ok) throw new Error('seed marks');
    return part;
  };
  const read = (part: DocumentCRDTv2): TextBlockModel => {
    const b = readTextBlock(part, 't');
    if (!b.ok) throw b.error;
    return b.value;
  };
  const layoutOf = (block: TextBlockModel) => engine.layout(1, encodeLayoutSpec(resolveTextLayout(block, { width: 400, defaults, families }).spec), block.text);

  function session(part: DocumentCRDTv2, clock: { t: number }, extra: Partial<Parameters<typeof createTextSession>[0]> = {}) {
    const f = fakeInput();
    const steps: { label: string; step: string | undefined }[] = [];
    const exits: string[] = [];
    const s = createTextSession({
      input: f.input,
      engine,
      blockId: 1,
      target: {
        read: () => readTextBlock(part, 't'),
        commit: (ops, label, step) => {
          steps.push({ label, step });
          const r = part.transact({ ...meta, label }, ops);
          return r.ok ? ok(undefined) : err(r.error);
        },
      },
      layout: (m) => layoutOf(m),
      toClient: (r) => ({ x: r.x0, y: r.y0, width: r.x1 - r.x0, height: r.y1 - r.y0 }),
      onExit: (reason) => exits.push(reason),
      now: () => clock.t,
      ...extra,
    });
    if (!s.ok) throw s.error;
    return { f, s: s.value, steps, exits };
  }

  it('coalesces continuous typing into one step until a pause, a caret move or another kind of edit (T-2)', () => {
    const clock = { t: 0 };
    const part = seed('');
    const { f, s, steps } = session(part, clock);
    for (const [i, ch] of [...'Hello'].entries()) {
      clock.t += 100;
      f.emit({ kind: 'insert', text: ch, range: [i, i] });
    }
    expect(read(part).text).toBe('Hello');
    expect(new Set(steps.map((x) => x.step)).size).toBe(1);
    expect(steps[0]?.step).toBeDefined();
    clock.t += TYPING_PAUSE_MS + 1; // a pause starts a new step
    f.emit({ kind: 'insert', text: '!', range: [5, 5] });
    expect(steps.at(-1)?.step).not.toBe(steps[0]?.step);
    const typed = steps.at(-1)?.step;
    clock.t += 10;
    f.emit({ kind: 'delete', range: [6, 6], direction: 'backward', unit: 'grapheme' });
    clock.t += 10;
    f.emit({ kind: 'delete', range: [5, 5], direction: 'backward', unit: 'grapheme' });
    const deletes = steps.slice(-2).map((x) => x.step);
    expect(deletes[0]).toBe(deletes[1]); // deletes coalesce with each other…
    expect(deletes[0]).not.toBe(typed); // …separately from typing
    f.emit(key('ArrowLeft')); // a caret move ends the run
    clock.t += 10;
    f.emit({ kind: 'insert', text: 'x', range: [3, 3] });
    expect(steps.at(-1)?.step).not.toBe(deletes[0]);
    const before = steps.at(-1)?.step;
    clock.t += 10;
    f.emit({ kind: 'insert', text: 'pasted', range: [4, 4] }); // a paste is its own step
    expect(steps.at(-1)).toEqual({ label: 'Paste', step: undefined });
    clock.t += 10;
    f.emit({ kind: 'insert', text: 'y', range: [10, 10] });
    expect(steps.at(-1)?.step).not.toBe(before);
    s.setTypingStyle({ bold: true }); // a style change ends the run too
    const styled = steps.at(-1)?.step;
    clock.t += 10;
    f.emit({ kind: 'insert', text: 'z', range: [11, 11] });
    expect(steps.at(-1)?.step).not.toBe(styled);
    s.dispose();
  });

  it('an outside change (undo, a collaborator) ends the run', () => {
    const clock = { t: 0 };
    const part = seed('ab');
    const { f, s, steps } = session(part, clock);
    f.emit({ kind: 'insert', text: 'c', range: [2, 2] });
    const first = steps.at(-1)?.step;
    const r = part.transact(meta, [{ op: 'text.delete', node: 't', path: 'text.content', from: 0, to: 1 }]);
    expect(r.ok).toBe(true);
    s.refresh();
    clock.t += 10;
    f.emit({ kind: 'insert', text: 'd', range: [2, 2] });
    expect(steps.at(-1)?.step).not.toBe(first);
    s.dispose();
  });

  it('Shift+Enter is a soft line break: one paragraph, two lines (T-6); Tab never leaves editing (T-8)', () => {
    const part = seed('ab');
    const { f, s, steps, exits } = session(part, { t: 0 });
    s.select(1, 1);
    f.emit(key('Enter', true));
    expect(read(part).text).toBe(`a${LINE_SEPARATOR}b`);
    expect(read(part).paragraphs).toHaveLength(1);
    expect(steps.at(-1)).toEqual({ label: 'Line break', step: undefined });
    const laid = layoutOf(read(part));
    expect(laid.ok && laid.value.lines().length).toBe(2);
    f.emit(key('Tab'));
    expect(exits).toEqual([]); // not a list: Tab does nothing (TEXT Q1)
    expect(read(part).text).toBe(`a${LINE_SEPARATOR}b`);
    s.dispose();
  });

  it('Tab indents list paragraphs and Shift+Tab outdents them, one step each (T-8)', () => {
    const part = seed('one\ntwo', (b) => {
      const r = setParagraphStyleOps(b, 0, b.text.length, { list: 'bullet' });
      return r.ok ? r.value : [];
    });
    const { f, s, steps } = session(part, { t: 0 });
    s.select(5, 5);
    f.emit(key('Tab'));
    expect(read(part).paragraphs.map((p) => p.style.level)).toEqual([undefined, 1]);
    expect(steps.at(-1)?.label).toBe('Indent');
    expect(s.selection).toEqual([5, 5]);
    f.emit(key('Tab', true));
    expect(read(part).paragraphs.map((p) => p.style.level)).toEqual([undefined, undefined]);
    expect(steps.at(-1)?.label).toBe('Outdent');
    const block = read(part);
    expect(listIndentOps(block, 0, 0, -1)).toEqual(ok([])); // level 0 stays
    const plain = seed('plain');
    expect(listIndentOps(read(plain), 0, 0, 1)).toBeUndefined();
    const deep = listIndentOps(block, 0, block.text.length, 1);
    expect(deep?.ok && deep.value.every((op) => op.op === 'text.mark' && op.key === ParaMark.level)).toBe(true);
    s.dispose();
  });

  it('lays superscript out smaller and draws it above the baseline (T-5)', () => {
    const part = seed('x2', (b) => {
      const r = setCharMarkOps(b, 1, 2, 'script', 'super');
      return r.ok ? r.value : [];
    });
    const block = read(part);
    const resolved = resolveTextLayout(block, { width: 400, defaults, families });
    expect(resolved.spec.paragraphs[0]?.spans.map((sp) => sp.size)).toEqual([20, 20 * SCRIPT_METRICS.scale]);
    const shifted = resolved.brushes.find((b) => b.shift !== undefined);
    expect(shifted?.shift).toBeCloseTo(20 * SCRIPT_METRICS.superShift, 6);
    const laid = layoutOf(block);
    if (!laid.ok) throw laid.error;
    let id = 10;
    const nodes = textSceneNodes(laid.value, { id: 1, brushes: resolved.brushes, fontId: () => 1, nextId: () => (id += 1) });
    const ys = nodes.flatMap((n) => (n.geometry.kind === 'glyphs' ? [n.geometry.glyphs[0]?.[2] ?? 0] : []));
    expect(ys).toHaveLength(2);
    expect((ys[1] as number) - (ys[0] as number)).toBeCloseTo(20 * SCRIPT_METRICS.superShift, 3);
  });

  it('reports characters no font covers as .notdef glyphs (T-4: drawn as tofu)', () => {
    const covered = layoutOf(read(seed('abc')));
    if (!covered.ok) throw covered.error;
    expect(missingGlyphs(covered.value)).toEqual({ glyphs: 0, clusters: 0 });
    const missing = layoutOf(read(seed('a日本')));
    if (!missing.ok) throw missing.error;
    expect(missingGlyphs(missing.value).clusters).toBe(2);
    expect(missing.value.runs().some((r) => r.glyphs.some((g) => g.id === NOTDEF_GLYPH))).toBe(true);
  });
});
