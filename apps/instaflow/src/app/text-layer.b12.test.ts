// @vitest-environment node
// B12 T-1 and A-2 on the Studio document: a fixed text box keeps its height and sits at its vertical alignment; the
// box height never follows the text; hidden text is not drawn (the text layer is what the canvas and export draw).
import { describe, expect, it } from 'vitest';
import { P } from '../elements/components.js';
import { placeTextOps } from '../text/commands.js';
import { readTextBlock } from '../text/rich-text.js';
import { authoringBuilt, createStudioFixture, person, unwrap } from './test-helpers.js';
import { createTextLayer, textBlockTransform, textBoxOps } from './text-layer.js';

describe.skipIf(!authoringBuilt)('text layer: fixed boxes and hidden text (B12)', () => {
  it('lays a fixed box out at its vertical alignment and keeps its height; hidden text leaves the scene', async () => {
    const f = await createStudioFixture();
    const { document } = f;
    unwrap(document.commitOps('p1', person, 'Seed', unwrap(placeTextOps({ node: 't', parent: 'p1', x: 100, y: 50, width: 300, text: 'Hello' }))));
    const layer = createTextLayer({ document, page: 'p1', fonts: f.fonts, scope: f.scope, sceneParent: () => 2 });
    const laid = unwrap(layer.layout('t'));
    expect(textBlockTransform(document, 't', laid)[5]).toBe(50); // auto height: no offset
    unwrap(document.commitOps('p1', person, 'Fixed', [
      { op: 'set', node: 't', path: 'text.box', value: 'fixed' },
      { op: 'set', node: 't', path: P.h, value: 200 },
      { op: 'set', node: 't', path: 'text.verticalAlign', value: 'bottom' },
    ]));
    expect(textBlockTransform(document, 't', laid)[5]).toBeCloseTo(50 + 200 - laid.height, 6);
    unwrap(document.commitOps('p1', person, 'Middle', [{ op: 'set', node: 't', path: 'text.verticalAlign', value: 'middle' }]));
    expect(textBlockTransform(document, 't', laid)[5]).toBeCloseTo(50 + (200 - laid.height) / 2, 6);
    expect(textBoxOps(document, 't', laid)).toEqual([]); // a fixed box never resizes to its text
    expect(readTextBlock(document.part('p1')!, 't').ok).toBe(true);

    expect(layer.changes(true)?.ir).toBeDefined();
    expect(layer.nodes).toEqual(['t']);
    unwrap(document.commitOps('p1', person, 'Hide', [{ op: 'set', node: 't', path: P.hidden, value: true }]));
    expect(layer.changes(false)?.ir).toBeDefined(); // the remove
    expect(layer.nodes).toEqual([]);
    unwrap(document.commitOps('p1', person, 'Show', [{ op: 'set', node: 't', path: P.hidden, value: null }]));
    layer.changes(false);
    expect(layer.nodes).toEqual(['t']);
    await f.scope.dispose();
  });
});
