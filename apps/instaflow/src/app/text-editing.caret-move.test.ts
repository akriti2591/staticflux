// @vitest-environment node
// B12b P1 (IF-37.23–37.26): the editor moves the caret (End, a click, Shift+arrows, Home) and main's EditContext learns
// it only from the editor's next state. The test holds that state back and types (or composes) on main first, as a
// person does within one round trip. Before the fix the character went in at main's old caret ("Hello 日本語Studio" in
// the smoke); now the editor rebases the intent onto its own selection and the next state resyncs main.
import { describe, expect, it } from 'vitest';
import { authoringBuilt, person, textPortRig, type TextPortRig } from './test-helpers.js';

async function typed(text: string): Promise<TextPortRig> {
  const r = await textPortRig();
  r.platform().type(text);
  r.settle();
  return r;
}

/** Main and the editor agree: the same text, and main's caret is the editor's. */
function agreed(r: TextPortRig, text: string, caret: readonly [number, number]): void {
  expect(r.text()).toBe(text);
  expect(r.platform().text).toBe(text);
  expect([r.platform().selectionStart, r.platform().selectionEnd]).toEqual(caret);
  expect(r.editing.session.selection).toEqual(caret);
}

describe.skipIf(!authoringBuilt)('typing right after an editor caret move, across the TextInput port (B12b P1)', () => {
  it('End, then a key before the caret reached main: the key lands at the end', async () => {
    const r = await typed('Hello Studio');
    r.editing.session.select(6, 6);
    r.settle();
    r.key('End');
    r.editorStep(); // the editor moves the caret to 12; its state is still on the way to main
    expect(r.toMain.some((c) => c.op === 'state')).toBe(true);
    r.platform().type('!'); // main's caret is still at 6
    r.editorStep();
    r.settle();
    agreed(r, 'Hello Studio!', [13, 13]);
    await r.dispose();
  });

  it('a click (the editor places the caret), then a key: the key lands at the click', async () => {
    const r = await typed('Hello Studio');
    r.editing.session.select(0, 0); // what `TextEditing.pointer` does for a click at the start
    r.platform().type('X');
    r.editorStep();
    r.settle();
    agreed(r, 'XHello Studio', [1, 1]);
    await r.dispose();
  });

  it('Shift+arrows, then a key: the key replaces the selection the editor draws', async () => {
    const r = await typed('Hello Studio');
    for (let i = 0; i < 6; i += 1) r.key('ArrowLeft', { shift: true });
    r.editorStep(); // selection [6, 12] in the editor; main still has a caret at 12
    r.platform().type('Z');
    r.editorStep();
    r.settle();
    agreed(r, 'Hello Z', [7, 7]);
    await r.dispose();
  });

  it('Backspace right after End deletes before the new caret', async () => {
    const r = await typed('Hello Studio');
    r.editing.session.select(5, 5);
    r.settle();
    r.key('End');
    r.editorStep();
    r.platform().deleteBackward();
    r.editorStep();
    r.settle();
    agreed(r, 'Hello Studi', [11, 11]);
    await r.dispose();
  });

  it('Home, then an IME composition: the composition goes in at the start, its bounds in main’s offsets', async () => {
    const r = await typed('Hello Studio');
    r.key('Home');
    r.editorStep(); // caret 0 in the editor, 12 on main
    r.platform().compose(['に', 'にほ'], '日本');
    r.editorStep();
    // Character bounds the editor pushes for its composition (at 0) reach main at main's composition (at 12).
    const chars = r.toMain.filter((c): c is Extract<typeof c, { op: 'chars' }> => c.op === 'chars').map((c) => c.start);
    expect(chars.length).toBeGreaterThan(0);
    expect(new Set(chars)).toEqual(new Set([12]));
    r.settle();
    agreed(r, '日本Hello Studio', [2, 2]);
    await r.dispose();
  });

  it('keys typed in a burst after End coalesce into one undo step (B12 T-2), all at the end', async () => {
    const r = await typed('Hello Studio');
    r.editing.session.select(0, 0);
    r.settle();
    const steps = r.fixture.document.undo.history(person.id).undo.length;
    r.key('End');
    r.editorStep();
    for (const ch of 'abc') {
      r.platform().type(ch); // no state reaches main in between: every key is at main's stale caret
      r.editorStep();
    }
    r.settle();
    agreed(r, 'Hello Studioabc', [15, 15]);
    expect(r.fixture.document.undo.history(person.id).undo.length).toBe(steps + 1);
    await r.dispose();
  });
});
