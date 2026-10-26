/** B11b slice 4: the clipboard controller (STUDIO §8.1) over a fake editor and fake clipboard events. */
import { createScope, err, ok, type Result, type SfError } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { CLIPBOARD_FORMAT, CLIPBOARD_VERSION, type ClipboardPayload, payloadToHtml } from './clipboard.js';
import { clipboardMessages, createClipboardController, fromEditable } from './clipboard-controller.js';
import { ActionNotApplicableError } from '../elements/errors.js';

const PAYLOAD: ClipboardPayload = { format: CLIPBOARD_FORMAT, version: CLIPBOARD_VERSION, asset: 'as_1', page: 'p1', sources: ['a'], ops: [{ op: 'create', node: 'c', kind: 'shape', parent: null, props: {} }], text: 'Rectangle' };

function rig(options: { selection?: string[]; editing?: boolean; copyFails?: boolean; system?: { write?: (items: readonly ClipboardItem[]) => Promise<void>; writeText?: (text: string) => Promise<void> } } = {}) {
  const calls: string[] = [];
  const warned: string[] = [];
  const problems: SfError[] = [];
  const placed: File[][] = [];
  const controller = createClipboardController({
    editor: {
      copy: async (nodes, cut): Promise<Result<ClipboardPayload>> => {
        calls.push(`copy ${nodes.join(',')} ${cut}`);
        return options.copyFails === true ? err(ActionNotApplicableError({ details: { needs: 'x' } })) : ok(PAYLOAD);
      },
      paste: async (payload, inPlace) => {
        calls.push(`paste ${payload.text} ${inPlace}`);
        return ok();
      },
      pasteText: async (text) => {
        calls.push(`text ${text}`);
        return ok();
      },
    },
    selection: () => options.selection ?? ['a'],
    editing: () => options.editing === true,
    placeFiles: async (files) => void placed.push([...files]),
    selectedText: async () => 'Hello',
    problem: (e) => problems.push(e),
    warn: (m) => warned.push(m),
    ...(options.system === undefined ? {} : { system: options.system }),
  });
  return { controller, calls, warned, problems, placed };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function clipEvent(type: string, data: Record<string, string> = {}, files: File[] = []): ClipboardEvent {
  const e = new Event(type, { cancelable: true, bubbles: true }) as ClipboardEvent;
  Object.defineProperty(e, 'clipboardData', { value: { getData: (t: string) => data[t] ?? '', files } });
  return e;
}

describe('clipboard controller', () => {
  it('Copy keeps the payload in memory; a blocked system clipboard warns and Paste still works from memory', async () => {
    const { controller, calls, warned } = rig({ system: { writeText: () => Promise.reject(new Error('blocked')) } });
    await controller.copy(false);
    expect(controller.held.get()).toEqual(PAYLOAD);
    expect(warned).toEqual([clipboardMessages.blocked]);
    await controller.paste(false);
    await controller.paste(true);
    expect(calls).toEqual(['copy a false', 'paste Rectangle false', 'paste Rectangle true']);
  });

  it('Cut asks the editor to cut; nothing selected copies nothing; a failed copy reports and holds nothing', async () => {
    const a = rig();
    await a.controller.copy(true);
    expect(a.calls).toEqual(['copy a true']);
    const none = rig({ selection: [] });
    await none.controller.copy(false);
    expect(none.calls).toEqual([]);
    const failed = rig({ copyFails: true });
    await failed.controller.copy(false);
    expect(failed.controller.held.get()).toBeUndefined();
    expect(failed.problems).toHaveLength(1);
  });

  it('Paste with nothing held says so', async () => {
    const { controller, warned, calls } = rig();
    await controller.paste(false);
    expect(warned).toEqual([clipboardMessages.nothing]);
    expect(calls).toEqual([]);
  });

  it('the paste event reads Studio’s payload first, then images, then text from other apps', async () => {
    const ours = rig();
    const e = clipEvent('paste', { 'text/html': payloadToHtml(PAYLOAD) });
    ours.controller.onPaste(e);
    await settle();
    expect(e.defaultPrevented).toBe(true);
    expect(ours.calls).toEqual(['paste Rectangle false']);
    expect(ours.controller.held.get()).toEqual(PAYLOAD);

    const image = rig();
    const file = new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' });
    image.controller.onPaste(clipEvent('paste', { 'text/plain': '' }, [file]));
    await settle();
    expect(image.placed).toEqual([[file]]);

    const text = rig();
    text.controller.onPaste(clipEvent('paste', { 'text/plain': 'Hello from elsewhere' }));
    await settle();
    expect(text.calls).toEqual(['text Hello from elsewhere']);
  });

  it('our own copy whose system write held only the names pastes from memory; Mod+Shift+V pastes in place', async () => {
    const { controller, calls } = rig();
    await controller.copy(false);
    const target = new EventTarget();
    const scope = createScope('test');
    controller.attach(target, () => true, scope);
    const key = new Event('keydown') as KeyboardEvent;
    Object.assign(key, { key: 'V', shiftKey: true, ctrlKey: true, metaKey: false });
    target.dispatchEvent(key);
    target.dispatchEvent(clipEvent('paste', { 'text/plain': 'Rectangle' }));
    await settle();
    expect(calls.at(-1)).toBe('paste Rectangle true');
    await scope.dispose();
    target.dispatchEvent(clipEvent('paste', { 'text/plain': 'Rectangle' }));
    await settle();
    expect(calls.filter((c) => c.startsWith('paste'))).toHaveLength(1);
  });

  it('leaves events alone while text is edited, and copy events with nothing selected', () => {
    const editing = rig({ editing: true });
    const e = clipEvent('paste', { 'text/plain': 'x' });
    editing.controller.onPaste(e);
    expect(e.defaultPrevented).toBe(false);
    const empty = rig({ selection: [] });
    const c = clipEvent('copy');
    empty.controller.onCopy(c, false);
    expect(c.defaultPrevented).toBe(false);
  });

  it('copy events prevent the default and copy through the editor', async () => {
    const { controller, calls } = rig();
    const c = clipEvent('copy');
    controller.onCopy(c, false);
    await settle();
    expect(c.defaultPrevented).toBe(true);
    expect(calls).toEqual(['copy a false']);
  });

  it('Copy as text writes the selected text', async () => {
    const written: string[] = [];
    const { controller } = rig({ system: { writeText: async (t) => void written.push(t) } });
    await controller.copyAsText();
    expect(written).toEqual(['Hello']);
  });

  it('fromEditable: inputs and contenteditable regions handle their own clipboard', () => {
    const input = document.createElement('input');
    document.body.append(input);
    const e = new Event('paste', { bubbles: true, composed: true });
    let seen = false;
    document.body.addEventListener('paste', (ev) => (seen = fromEditable(ev)), { once: true });
    input.dispatchEvent(e);
    expect(seen).toBe(true);
    input.remove();
    expect(fromEditable(new Event('paste'))).toBe(false);
  });
});
