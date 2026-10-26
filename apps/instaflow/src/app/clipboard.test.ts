// @vitest-environment node
/** B11b slice 4: the clipboard payload (STUDIO §8.1): copy, offsets, re-minted ids, the `text/html` carrier. */
import { ok } from '@staticflux/core';
import type { NodeId, PartOp } from '@staticflux/document/v2';
import { describe, expect, it } from 'vitest';
import { commitEdit } from '../elements/actions.js';
import { P } from '../elements/components.js';
import { CLIPBOARD_FORMAT, CLIPBOARD_VERSION, type ClipboardPayload, copyPayload, parsePayload, pasteOffset, pasteOps, payloadFromHtml, payloadToHtml } from './clipboard.js';
import { authoringBuilt, createStudioFixture, person, unwrap } from './test-helpers.js';

const rect = (node: string, x: number, parent = 'p1'): PartOp => ({ op: 'create', node, kind: 'shape', parent, props: { [P.x]: x, [P.y]: 10, [P.w]: 50, [P.h]: 50, name: `R ${node}` } });

const payload = (over: Partial<ClipboardPayload> = {}): ClipboardPayload => ({
  format: CLIPBOARD_FORMAT,
  version: CLIPBOARD_VERSION,
  asset: 'as_1',
  page: 'p1',
  sources: ['a'],
  ops: [{ op: 'create', node: 'c1', kind: 'shape', parent: null, props: { [P.x]: 10, [P.y]: 20 } }],
  text: 'Rectangle',
  ...over,
});

let n = 0;
const target = (over: Partial<Parameters<typeof pasteOps>[1]> = {}): Parameters<typeof pasteOps>[1] => ({
  asset: 'as_1',
  page: 'p1',
  parent: 'p1',
  exists: () => true,
  newId: () => `n${(n += 1)}` as NodeId,
  count: 0,
  inPlace: false,
  ...over,
});

describe('paste offsets', () => {
  it('stack by 24 on the source page while the source exists; same coordinates elsewhere or in place', () => {
    const p = payload();
    expect(pasteOffset(p, target())).toEqual([24, 24]);
    expect(pasteOffset(p, target({ count: 2 }))).toEqual([72, 72]);
    expect(pasteOffset(p, target({ inPlace: true }))).toEqual([0, 0]);
    expect(pasteOffset(p, target({ page: 'p2' }))).toEqual([0, 0]);
    expect(pasteOffset(p, target({ asset: 'as_2' }))).toEqual([0, 0]);
    expect(pasteOffset(p, target({ exists: () => false }))).toEqual([0, 0]);
  });

  it('pasteOps re-mints every id, parents the top level under the target and offsets only the top level', () => {
    const p = payload({ ops: [{ op: 'create', node: 'g', kind: 'group', parent: null, props: { [P.x]: 0, [P.y]: 0 } }, { op: 'create', node: 'k', kind: 'shape', parent: 'g', props: { [P.x]: 5, [P.y]: 5 } }] });
    const made = unwrap(pasteOps(p, target({ parent: 'frame-1' })));
    const [top, child] = made.ops as Extract<PartOp, { op: 'create' }>[];
    expect(made.select).toEqual([top?.node]);
    expect(top?.node).not.toBe('g');
    expect(top?.parent).toBe('frame-1');
    expect(top?.props?.[P.x]).toBe(24);
    expect(child?.parent).toBe(top?.node);
    expect(child?.props?.[P.x]).toBe(5);
  });

  it('an empty payload is not applicable', () => {
    expect(pasteOps(payload({ ops: [] }), target()).ok).toBe(false);
  });
});

describe('the text/html carrier', () => {
  it('round-trips a payload (UTF-8 names included) and escapes the visible text', () => {
    const p = payload({ text: 'Café <b>&' });
    const html = payloadToHtml(p);
    expect(html).toContain('Café &lt;b&gt;&amp;');
    expect(payloadFromHtml(html)).toEqual(p);
  });

  it('ignores HTML from other apps and payloads of another format or version', () => {
    expect(payloadFromHtml('<p>hello</p>')).toBeUndefined();
    expect(payloadFromHtml('<span data-instaflow-clipboard="!!!">x</span>')).toBeUndefined();
    expect(parsePayload({ ...payload(), version: 2 })).toBeUndefined();
    expect(parsePayload({ ...payload(), format: 'other' })).toBeUndefined();
    expect(parsePayload(null)).toBeUndefined();
  });
});

describe.skipIf(!authoringBuilt)('copyPayload over a document', () => {
  it('serialises the selection as top-level creates (children follow) with names for other apps', async () => {
    const f = await createStudioFixture();
    const doc = f.document;
    unwrap(commitEdit(doc.target('p1'), person, 'Seed', ok([rect('a', 0), rect('b', 100)])));
    const p = unwrap(copyPayload({ ...doc.context(), stage: doc.base }, ['a', 'b'], { asset: 'as_1', page: 'p1' }, () => undefined));
    expect(p.sources).toEqual(['a', 'b']);
    const creates = p.ops.filter((op): op is Extract<PartOp, { op: 'create' }> => op.op === 'create');
    expect(creates.filter((op) => op.parent === null)).toHaveLength(2);
    expect(p.text).toBe('R a\nR b');
    // Paste on the same page: two new elements 24 px down-right; one undo step removes them.
    const made = unwrap(pasteOps(p, { asset: 'as_1', page: 'p1', parent: 'p1', exists: (x) => doc.base.read(x) !== undefined, newId: () => doc.newId(), count: 0, inPlace: false }));
    unwrap(doc.commitOps('p1', person, 'Paste', made.ops));
    expect([...doc.view.children('p1')]).toHaveLength(4);
    expect(doc.view.value(made.select[0] as NodeId, P.x)).toBe(24);
    unwrap(await doc.undo.undo(person, f.signal));
    expect([...doc.view.children('p1')]).toHaveLength(2);
    await f.scope.dispose();
  });
});
