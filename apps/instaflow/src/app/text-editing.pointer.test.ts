// @vitest-environment node
// FIX-TEXT-FIRST-KEY item 2 (owner: "can't place the cursor by clicking, can't use Ctrl/Cmd+A, can't make a selection"):
// the pointer path into the text (TEXT-FONTS §3.2) and the caret / selection the overlay draws, on the real document,
// text layer and layout engine.
import { ok } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { placeTextOps } from '../text/commands.js';
import { textEditBatch } from '../tools/overlay.js';
import { type TextEditing, startTextEditing } from './text-editing.js';
import { authoringBuilt, createStudioFixture, person, scriptedTextInput, unwrap } from './test-helpers.js';
import { createTextLayer, textBlockTransform } from './text-layer.js';

const TEXT = 'Hello world';

async function rig(zoom = 1) {
  const f = await createStudioFixture();
  unwrap(f.document.commitOps('p1', person, 'Add text', unwrap(placeTextOps({ node: 't', parent: 'p1', x: 100, y: 50, text: TEXT }))));
  const layer = createTextLayer({ document: f.document, page: 'p1', fonts: f.fonts, scope: f.scope });
  const input = scriptedTextInput();
  const editing: TextEditing = unwrap(
    startTextEditing({
      document: f.document,
      page: 'p1',
      node: 't',
      layer,
      fonts: f.fonts,
      host: { open: () => ok(input), place: () => undefined, close: () => undefined },
      camera: () => ({ tx: 0, ty: 0, zoom }),
      actor: () => person,
      onExit: () => undefined,
      scope: f.scope,
    }),
  );
  const blockId = layer.blockId('t');
  const laid = unwrap(layer.layout('t'));
  /** Page point in the middle of the line, at the caret position before `offset`. */
  const at = (offset: number, dy = 0): { x: number; y: number } => {
    const c = unwrap(f.fonts.engine.caret(blockId, { offset, upstream: false }));
    const [a, b, cc, d, e, ff] = textBlockTransform(f.document, 't', laid);
    const bx = c.x0 + 0.5;
    const by = (c.y0 + c.y1) / 2 + dy;
    return { x: a * bx + cc * by + e, y: b * bx + d * by + ff };
  };
  return { f, editing, input, at, laid, dispose: () => f.scope.dispose() };
}

describe.skipIf(!authoringBuilt)('caret and selection by pointer and keyboard while editing (FIX-TEXT-FIRST-KEY item 2)', () => {
  it('a click places the caret at the hit; a drag selects; Shift+click extends from the anchor', async () => {
    const r = await rig();
    expect(r.editing.session.selection).toEqual([TEXT.length, TEXT.length]); // editing starts at the end
    expect(r.editing.pointer({ phase: 'down', ...r.at(3), clicks: 1 })).toBe(true);
    expect(r.editing.pointer({ phase: 'up', ...r.at(3) })).toBe(true);
    expect(r.editing.session.selection).toEqual([3, 3]);
    // Drag from 1 to 8: one selection, anchor at the press.
    r.editing.pointer({ phase: 'down', ...r.at(1), clicks: 1 });
    r.editing.pointer({ phase: 'move', ...r.at(5) });
    r.editing.pointer({ phase: 'move', ...r.at(8) });
    r.editing.pointer({ phase: 'up', ...r.at(8) });
    expect(r.editing.session.selection).toEqual([1, 8]);
    expect(r.editing.session.state.anchor).toBe(1);
    // Dragging back past the press keeps the press as the anchor; above the first line selects to the start.
    r.editing.pointer({ phase: 'down', ...r.at(6), clicks: 1 });
    r.editing.pointer({ phase: 'move', ...r.at(0, -200) });
    r.editing.pointer({ phase: 'up', ...r.at(0, -200) });
    expect([r.editing.session.state.anchor, r.editing.session.state.focus.offset]).toEqual([6, 0]);
    // Shift+click extends from the anchor.
    r.editing.pointer({ phase: 'down', ...r.at(2), clicks: 1 });
    r.editing.pointer({ phase: 'up', ...r.at(2) });
    r.editing.pointer({ phase: 'down', ...r.at(9), clicks: 1, shift: true });
    r.editing.pointer({ phase: 'up', ...r.at(9) });
    expect(r.editing.session.selection).toEqual([2, 9]);
    await r.dispose();
  });

  it('double click selects the word, triple the paragraph, quadruple all; a press outside the box is not the text’s', async () => {
    const r = await rig();
    r.editing.pointer({ phase: 'down', ...r.at(8), clicks: 2 });
    r.editing.pointer({ phase: 'up', ...r.at(8) });
    expect(r.editing.session.selection).toEqual([6, 11]); // "world"
    r.editing.pointer({ phase: 'down', ...r.at(2), clicks: 2 });
    r.editing.pointer({ phase: 'move', ...r.at(8) }); // double-click-drag extends by word
    r.editing.pointer({ phase: 'up', ...r.at(8) });
    expect(r.editing.session.selection).toEqual([0, 11]);
    r.editing.pointer({ phase: 'down', ...r.at(2), clicks: 3 });
    r.editing.pointer({ phase: 'up', ...r.at(2) });
    expect(r.editing.session.selection).toEqual([0, 11]);
    r.editing.pointer({ phase: 'down', ...r.at(2), clicks: 4 });
    r.editing.pointer({ phase: 'up', ...r.at(2) });
    expect(r.editing.session.selection).toEqual([0, 11]);
    const far = r.at(0);
    expect(r.editing.pointer({ phase: 'down', x: far.x - 500, y: far.y, clicks: 1 })).toBe(false);
    await r.dispose();
  });

  it('Mod+A selects all the text and Shift+arrows extend; the overlay draws the selection, else the caret', async () => {
    const r = await rig(0.25);
    const caret = r.editing.overlay(0.25);
    expect(caret?.selection).toEqual([]);
    expect(caret?.caret).toBeDefined();
    expect((caret?.caret?.x1 ?? 0) - (caret?.caret?.x0 ?? 0)).toBeCloseTo(4, 3); // ≥ 1 screen px at 25 %: 4 page px
    r.input.emit({ kind: 'key', key: 'SelectAll', shift: false, mod: true, alt: false });
    expect(r.editing.session.selection).toEqual([0, TEXT.length]);
    const all = r.editing.overlay(0.25);
    expect(all?.caret).toBeUndefined();
    expect(all?.selection.length).toBe(1);
    expect(all?.selection[0]?.x1).toBeCloseTo(r.laid.width, 0);
    const ids: number[] = [];
    textEditBatch(all!, { clear: false, firstId: 11, ids });
    expect(ids).toEqual([11]);
    r.input.emit({ kind: 'key', key: 'End', shift: false, mod: false, alt: false });
    r.input.emit({ kind: 'key', key: 'ArrowLeft', shift: true, mod: false, alt: false });
    r.input.emit({ kind: 'key', key: 'ArrowLeft', shift: true, mod: false, alt: false });
    expect(r.editing.session.selection).toEqual([9, 11]);
    await r.dispose();
  });
});
