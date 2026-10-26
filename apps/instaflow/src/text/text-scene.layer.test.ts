// @vitest-environment node
// FIX-TEXT-FIRST-KEY item 3: the element's layer look (opacity, blend, effects) sits on the text **group**, as for
// shapes, so glyphs composite as one layer and effects take the text's outline. Pure: no Wasm (an empty layout).
import { describe, expect, it } from 'vitest';
import type { TextLayout } from './layout-result.js';
import { textSceneNodes } from './text-scene.js';

const empty = { runs: () => [], decorations: () => [], clusters: () => [] } as unknown as TextLayout;
const base = { id: 10, brushes: [], fontId: () => 1, nextId: () => 99 } as const;

describe('text scene: the layer look on the group (FIX-TEXT-FIRST-KEY item 3)', () => {
  it('puts opacity, blend and effects on the group node only', () => {
    const shadow = { kind: 'drop-shadow', x: 0, y: 4, blur: 8, spread: 0, color: [0, 0, 0, 128] } as const;
    const [group] = textSceneNodes(empty, { ...base, layer: { opacity: 0.4, blend: 'multiply', effects: [shadow] } });
    expect(group).toMatchObject({ id: 10, geometry: { kind: 'group' }, opacity: 0.4, blend: 'multiply', effects: [shadow] });
  });

  it('leaves the defaults out (opaque, normal, no effects), as before', () => {
    const [plain] = textSceneNodes(empty, { ...base, layer: { opacity: 1, blend: 'normal', effects: [] } });
    expect(plain).toEqual({ id: 10, geometry: { kind: 'group' } });
    expect(textSceneNodes(empty, base)[0]).toEqual({ id: 10, geometry: { kind: 'group' } });
  });
});
