// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { AUTHORING_ABI_VERSION, loadAuthoringModule } from './authoring-module.js';
import { ClusterFlag, decodeTextLayout } from './layout-result.js';
import { encodeLayoutSpec, familyList, type LayoutParagraphSpec } from './layout-spec.js';
import { createTextLayoutEngine, needsComplexScripts } from './text-engine.js';
import { authoringBuilt, loadAuthoringInNode, STACK, testFont, testTextEngine } from './test-helpers.js';

const required = process.env['SF_REQUIRE_RUST'] === '1';
const para = (text: string, size = 20, extra: Partial<LayoutParagraphSpec> = {}): LayoutParagraphSpec => ({ text, spans: [{ start: 0, end: text.length, family: STACK, size }], ...extra });

describe('layout spec and layout decoding (no Wasm)', () => {
  it('encodes the SFTX header and rejects malformed paragraphs', () => {
    const bytes = encodeLayoutSpec({ width: 100, paragraphs: [para('hé')] });
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('SFTX');
    expect(new DataView(bytes.buffer).getFloat32(8, true)).toBe(100);
    expect(() => encodeLayoutSpec({ width: 0, paragraphs: [para('a\nb')] })).toThrow(/line feed/);
    expect(() => encodeLayoutSpec({ width: 0, paragraphs: [{ text: 'ab', spans: [{ start: 0, end: 1, family: '', size: 10 }] }] })).toThrow(/cover/);
    expect(() => encodeLayoutSpec({ width: 0, paragraphs: [{ text: 'ab', spans: [{ start: 1, end: 2, family: '', size: 10 }] }] })).toThrow(/contiguous/);
    expect(() => encodeLayoutSpec({ width: Number.NaN, paragraphs: [] })).toThrow(/finite/);
    expect(familyList(['Noto Sans', 'Evil"Font'])).toBe('"Noto Sans", "EvilFont"');
  });

  it('decodes an empty layout and rejects foreign buffers', () => {
    const empty = decodeTextLayout([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(empty.bounds).toEqual({ x0: 0, y0: 0, x1: 0, y1: 0 });
    expect(empty.clusterAt(0)).toBeUndefined();
    expect(() => decodeTextLayout([2])).toThrow(/version/);
    expect(() => decodeTextLayout([1, 0, 0, 1])).toThrow(/truncated/);
    expect(() => decodeTextLayout([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5])).toThrow(/trailing/);
  });

  it('detects scripts that need the complex-scripts build', () => {
    expect(needsComplexScripts('ภาษาไทย')).toBe(true);
    expect(needsComplexScripts('ພາສາລາວ')).toBe(true);
    expect(needsComplexScripts('ភាសាខ្មែរ')).toBe(true);
    expect(needsComplexScripts('မြန်မာ')).toBe(true);
    expect(needsComplexScripts('Hello मरहबा مرحبا 日本語')).toBe(false);
  });

  it('the loader reports a missing manifest, artifact or ABI as IF-TXT-004', async () => {
    const fetch404 = async () => ({ ok: false, status: 404, json: async () => ({}) });
    const r1 = await loadAuthoringModule({ manifestUrl: 'file:///m.json', fetch: fetch404 });
    expect(!r1.ok && r1.error.code).toBe('IF-TXT-004');
    const noEntry = async () => ({ ok: true, status: 200, json: async () => ({ format: 'sf-wasm-manifest/1', artifacts: [] }) });
    const r2 = await loadAuthoringModule({ manifestUrl: 'file:///m.json', fetch: noEntry });
    expect(!r2.ok && r2.error.message).toContain('authoring');
    const manifest = async () => ({ ok: true, status: 200, json: async () => ({ format: 'sf-wasm-manifest/1', artifacts: [{ crate: 'authoring-text-complex', wasm: 'a.wasm', js: 'a.js' }] }) });
    const wrongAbi = await loadAuthoringModule({ manifestUrl: 'file:///m.json', build: 'complex', fetch: manifest, importModule: async () => ({ default: async () => undefined, abi_version: () => 1 }) });
    expect(!wrongAbi.ok && wrongAbi.error.details).toEqual({ expected: AUTHORING_ABI_VERSION, got: 1 });
    const throws = await loadAuthoringModule({ manifestUrl: 'file:///m.json', fetch: manifest, build: 'complex', importModule: async () => Promise.reject(new Error('boom')) });
    expect(!throws.ok && throws.error.message).toContain('boom');
    const aborted = await loadAuthoringModule({ manifestUrl: 'file:///m.json', fetch: manifest, build: 'complex', signal: AbortSignal.abort() });
    expect(!aborted.ok && aborted.error.kind).toBe('aborted');
  });
});

describe.skipIf(!authoringBuilt && !required)('text layout engine on the built authoring Wasm', () => {
  it('registers fonts once per hash and reports families; bad bytes are IF-TXT-006', async () => {
    const engine = await testTextEngine();
    expect(engine.fonts.map((f) => f.families[0])).toEqual(['Noto Sans', 'Noto Sans Arabic', 'Noto Sans Devanagari', 'Noto Sans Thai']);
    const again = testFont('NotoSans-Latin.wght.ttf');
    const r = engine.registerFont(again.hash, again.bytes);
    expect(r.ok && r.value.ids).toEqual([0]);
    expect(engine.fontOf(1)?.families).toEqual(['Noto Sans Arabic']);
    const bad = engine.registerFont('sha256:00', new Uint8Array([1, 2, 3]));
    expect(!bad.ok && bad.error.code).toBe('IF-TXT-006');
    expect(engine.setFallbacks('Zzzz-nope', ['Noto Sans']).ok).toBe(false);
    engine.dispose();
  });

  it('lays out glyph runs, lines, clusters, words and decorations with stable indices', async () => {
    const engine = await testTextEngine();
    const spec = encodeLayoutSpec({ width: 120, paragraphs: [para('Hello world, this wraps'), para(''), para('مرحبا بالعالم', 20, { align: 'center' })] });
    const text = 'Hello world, this wraps\n\nمرحبا بالعالم';
    const a = engine.layout(1, spec, text);
    const b = engine.layout(2, spec, text);
    if (!a.ok || !b.ok) throw new Error('layout failed');
    const l = a.value;
    expect(l.paragraphs().map((p) => [p.start, p.end, p.rtl])).toEqual([
      [0, 23, false],
      [24, 24, false],
      [25, 38, true],
    ]);
    expect(l.lines().length).toBeGreaterThanOrEqual(4);
    expect(l.clusters()).toEqual(b.value.clusters());
    expect(l.words().map((w) => text.slice(w.start, w.end))).toEqual(['Hello', 'world', ',', 'this', 'wraps', 'مرحبا', 'بالعالم']); // UAX #29 word starts
    for (const w of l.words()) expect(l.clustersOf(w).every((c) => c.word === w.index)).toBe(true);
    for (const line of l.lines()) expect(l.clustersOf(line).every((c) => c.line === line.index)).toBe(true);
    expect(l.clusterAt(1)?.start).toBe(1);
    expect(l.clusterAt(23)).toBeUndefined();
    const space = l.clusterAt(5);
    expect(space !== undefined && (space.flags & ClusterFlag.space) !== 0).toBe(true);
    // Arabic letters use the Arabic fallback; word spaces may come from the first family (S3 surprise 2)
    expect(l.runs().filter((r) => r.rtl && r.font === 1).length).toBeGreaterThan(0);
    expect(l.runs().filter((r) => r.rtl).every((r) => r.font === 0 || r.font === 1)).toBe(true);
    for (const run of l.runs()) for (const g of run.glyphs) expect(g.cluster).toBeLessThan(l.clusters().length);
    expect(l.bounds.y1).toBeLessThanOrEqual(l.height + 0.01);
    expect(engine.layout(3, new Uint8Array([1, 2]), 'x').ok).toBe(false);
    engine.dispose();
  });

  it('caret → hit test round trip, selection and character bounds through the Wasm (S3: 393/393)', async () => {
    const engine = await testTextEngine();
    const texts = ['Hello, world', 'مرحبا بالعالم', 'नमस्ते दुनिया', 'abc مرحبا 123 def', 'a😀b'];
    const text = texts.join('\n');
    const laid = engine.layout(1, encodeLayoutSpec({ width: 160, paragraphs: texts.map((t) => para(t)) }), text);
    expect(laid.ok).toBe(true);
    let checked = 0;
    for (let offset = 0; offset <= text.length; offset++) {
      for (const upstream of [false, true]) {
        const c = engine.caret(1, { offset, upstream });
        if (!c.ok) throw c.error;
        const hit = engine.hitTest(1, (c.value.x0 + c.value.x1) / 2, (c.value.y0 + c.value.y1) / 2);
        if (!hit.ok) throw hit.error;
        const back = engine.caret(1, hit.value);
        if (!back.ok) throw back.error;
        expect(Math.abs(back.value.x0 - c.value.x0), `offset ${offset}`).toBeLessThan(1);
        expect(Math.abs(back.value.y0 - c.value.y0)).toBeLessThan(1);
        checked += 1;
      }
    }
    expect(checked).toBe((text.length + 1) * 2);
    const bounds = engine.charBounds(1, 0, text.length);
    expect(bounds.ok && bounds.value.length).toBe(text.length);
    const sel = engine.selectionRects(1, 0, 20);
    expect(sel.ok && sel.value.length).toBeGreaterThanOrEqual(2);
    expect(engine.wordAt(1, 2)).toEqual({ ok: true, value: [0, 5] });
    const right = engine.move(1, { offset: 0, upstream: false }, 'right');
    expect(right.ok && right.value.offset).toBe(1);
    const back = engine.move(1, { offset: text.length, upstream: true }, 'prevGrapheme');
    expect(back.ok && back.value.offset).toBe(text.length - 1);
    expect(engine.caret(99, { offset: 0, upstream: false }).ok).toBe(false);
    engine.drop(1);
    expect(engine.hitTest(1, 0, 0).ok).toBe(false);
    engine.dispose();
  });

  it('loads the complex-scripts build lazily, replays fonts, and Thai then wraps (S3 surprise 1)', async () => {
    const engine = await testTextEngine({ complex: true });
    const thai = 'ภาษาไทยเป็นภาษาที่สวยงามมากและมีประวัติศาสตร์ยาวนาน';
    const spec = encodeLayoutSpec({ width: 200, paragraphs: [{ text: thai, spans: [{ start: 0, end: thai.length, family: familyList(['Noto Sans Thai']), size: 20 }] }] });
    const before = engine.layout(1, spec, thai);
    expect(before.ok && before.value.lines().length).toBe(1);
    expect(engine.complexLoaded).toBe(false);
    expect((await engine.prepare('plain latin')).ok).toBe(true);
    expect(engine.complexLoaded).toBe(false);
    const prepared = await engine.prepare(thai);
    expect(prepared.ok).toBe(true);
    expect(engine.complexLoaded).toBe(true);
    const after = engine.layout(1, spec, thai);
    expect(after.ok && after.value.lines().length).toBeGreaterThan(1);
    // same font ids in both builds
    expect(after.ok && after.value.runs().every((r) => r.font === 3)).toBe(true);
    expect(engine.caret(1, { offset: 3, upstream: false }).ok).toBe(true);
    engine.dispose();
  }, 60_000);

  it('a failing complex loader leaves the base build in charge', async () => {
    const engine = createTextLayoutEngine({ wasm: await loadAuthoringInNode(), loadComplex: async () => ({ ok: false, error: new Error('offline') as never }) });
    const r = await engine.prepare('ภาษาไทย');
    expect(r.ok).toBe(false);
    expect(engine.complexLoaded).toBe(false);
    engine.dispose();
  });
});
