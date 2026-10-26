// @vitest-environment node
// FIX-TEXT-FIRST-KEY (Studio smoke "ello StudioH"): a new text element, its editing session in the editor module and the
// EditContext on main, joined by B9's TextInput port with both message queues under the test's control. The person's
// second key lands between two of the editor's messages for the first one: main must never see the first key's text
// with the caret still before it (the session's own commit used to re-enter `refresh` through the document
// invalidation and push exactly that).
import { describe, expect, it } from 'vitest';
import type { TextHostCommand } from '../workers/text-port.js';
import { authoringBuilt, textPortRig as rig } from './test-helpers.js';

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
