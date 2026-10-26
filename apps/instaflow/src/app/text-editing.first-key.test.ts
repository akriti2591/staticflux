// @vitest-environment node
// FIX-TEXT-FIRST-KEY (Studio smoke "ello StudioH"): a new text element, its editing session in the editor module and the
// EditContext on main, joined by B9's TextInput port with both message queues under the test's control. The person's
// second key lands between two of the editor's messages for the first one: main must never see the first key's text
// with the caret still before it (the session's own commit used to re-enter `refresh` through the document
// invalidation and push exactly that).
import { createEditContextTextInput, type EditContextConstructor } from '@staticflux/surface/text-input';
import { FakeEditContext } from '@staticflux/testkit';
import { describe, expect, it } from 'vitest';
import { placeTextOps } from '../text/commands.js';
import { readTextBlock } from '../text/rich-text.js';
import { createRemoteTextHost, createTextHostBridge, type TextHostCommand, type TextHostEvent } from '../workers/text-port.js';
import { startTextEditing } from './text-editing.js';
import { authoringBuilt, createStudioFixture, lendDom, person, unwrap } from './test-helpers.js';
import { createTextLayer } from './text-layer.js';

async function rig() {
  const f = await createStudioFixture();
  const dom = lendDom();
  const surface = dom.document.createElement('div');
  dom.document.body.append(surface);
  unwrap(f.document.commitOps('p1', person, 'Add text', unwrap(placeTextOps({ node: 't', parent: 'p1', x: 100, y: 50 }))));
  const layer = createTextLayer({ document: f.document, page: 'p1', fonts: f.fonts, scope: f.scope });
  // The two directions of the worker boundary, delivered only when the test says so (postMessage order is kept).
  const toMain: TextHostCommand[] = [];
  const toEditor: TextHostEvent[] = [];
  let ec: FakeEditContext | undefined;
  const Ctor = function (init?: { text?: string; selectionStart?: number; selectionEnd?: number }): FakeEditContext {
    ec = new FakeEditContext(init);
    return ec;
  } as unknown as EditContextConstructor;
  const bridge = createTextHostBridge({ surface, create: (host, label) => createEditContextTextInput({ host, document: dom.document, EditContext: Ctor, label }), send: (e) => toEditor.push(e) });
  const remote = createRemoteTextHost((c) => toMain.push(c), 'edit-context');
  const editing = unwrap(startTextEditing({ document: f.document, page: 'p1', node: 't', layer, fonts: f.fonts, host: remote, camera: () => ({ tx: 0, ty: 0, zoom: 1 }), actor: () => person, onExit: () => undefined, scope: f.scope }));
  /** Main applies the editor's next command; returns it. */
  const mainStep = (): TextHostCommand | undefined => {
    const c = toMain.shift();
    if (c !== undefined) bridge.receive(c);
    return c;
  };
  /** The editor handles every event main sent so far. */
  const editorStep = (): void => {
    for (const e of toEditor.splice(0)) remote.receive(e);
  };
  const settle = (): void => {
    while (toMain.length > 0 || toEditor.length > 0) {
      while (mainStep() !== undefined);
      editorStep();
    }
  };
  settle(); // open, the first state, place, focus
  const platform = (): FakeEditContext => {
    if (ec === undefined) throw new Error('no EditContext');
    return ec;
  };
  const text = (): string => unwrap(readTextBlock(f.document.part('p1')!, 't')).text;
  const dispose = async (): Promise<void> => {
    editing.stop();
    dom.restore();
    await f.scope.dispose();
  };
  return { toMain, mainStep, editorStep, settle, platform, text, editing, dispose };
}

describe.skipIf(!authoringBuilt)('typing into a new text element across the TextInput port (FIX-TEXT-FIRST-KEY)', () => {
  it('keeps the first character before the caret when the next key lands between the editor’s messages for it', async () => {
    const r = await rig();
    r.platform().type('H');
    r.editorStep(); // the editor commits "H" and posts its commands
    // Main applies the editor's commands for "H" up to and including the first state, then the person types "e".
    let first: TextHostCommand | undefined;
    while ((first = r.mainStep()) !== undefined && first.op !== 'state');
    expect(first?.op).toBe('state');
    r.platform().type('e');
    r.settle();
    r.platform().type('llo');
    r.settle();
    expect(r.text()).toBe('Hello');
    expect(r.platform().text).toBe('Hello');
    expect([r.platform().selectionStart, r.platform().selectionEnd]).toEqual([5, 5]);
    expect(r.editing.session.state.focus.offset).toBe(5);
    await r.dispose();
  });

  it('posts one state per handled key, with the caret after it, although the commit invalidates the element twice', async () => {
    const r = await rig();
    for (const ch of 'Hi!') {
      r.platform().type(ch);
      r.editorStep();
      const states = r.toMain.filter((c): c is Extract<TextHostCommand, { op: 'state' }> => c.op === 'state');
      expect(states.map((s) => [s.state.text, s.state.selection])).toEqual([[r.text(), [r.text().length, r.text().length]]]);
      r.settle();
    }
    expect(r.text()).toBe('Hi!');
    await r.dispose();
  });
});
