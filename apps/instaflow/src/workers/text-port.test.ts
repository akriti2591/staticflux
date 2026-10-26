// @vitest-environment happy-dom
import { ok } from '@staticflux/core';
import type { TextInput, TextInputState, TextIntent } from '@staticflux/surface/text-input';
import { editContextContractSubject, hiddenTextareaContractSubject, runTextInputContract, type TextInputContractSubject } from '@staticflux/testkit';
import { describe, expect, it } from 'vitest';
import { createRemoteTextHost, createTextHostBridge, rebaseIntent, textOffsetMap, type RemoteTextHost, type TextHostCommand } from './text-port.js';

/**
 * The editor-side TextInput (B9) through the port to a platform TextInput on main: the shared TextInput contract runs
 * against the remote input, with the platform driven exactly as before (delivery is synchronous here; ordering and the
 * state rule are what the port adds).
 */
function remoteSubject(platform: TextInputContractSubject): TextInputContractSubject {
  return {
    create() {
      const inner = platform.create();
      const surface = document.createElement('div');
      document.body.append(surface);
      let bridgeReceive: (c: TextHostCommand) => void = () => undefined;
      const remote = createRemoteTextHost((command) => bridgeReceive(command), 'edit-context');
      const bridge = createTextHostBridge({ surface, create: () => ok(inner.input), send: (event) => remote.receive(event) });
      bridgeReceive = (command) => bridge.receive(command);
      const input = remote.open('t1', 'Text');
      if (!input.ok) throw input.error;
      return {
        input: input.value,
        driver: inner.driver,
        dispose: () => {
          input.value.dispose();
          remote.close('stopped');
          inner.dispose();
          surface.remove();
        },
      };
    },
  };
}

runTextInputContract('remote TextInput over the port (EditContext on main)', remoteSubject(editContextContractSubject()), { describe, it });
runTextInputContract('remote TextInput over the port (hidden textarea on main)', remoteSubject(hiddenTextareaContractSubject()), { describe, it });

/** A platform input that records what main applied. */
function recordingInput(): TextInput & { emit(intent: TextIntent): void; readonly applied: string[]; readonly bounds: { x: number; y: number }[]; focusCount: number } {
  const intents = new Set<(i: TextIntent) => void>();
  const applied: string[] = [];
  const bounds: { x: number; y: number }[] = [];
  let composing = false;
  const self = {
    kind: 'edit-context' as const,
    focusCount: 0,
    applied,
    bounds,
    focus: () => void (self.focusCount += 1),
    blur: () => undefined,
    focused: false,
    get composing() {
      return composing;
    },
    state: { text: '', selection: [0, 0] as const },
    setState: (s: { text: string }) => void applied.push(s.text),
    setControlBounds: () => undefined,
    setSelectionBounds: (r: { x: number; y: number }) => void bounds.push({ x: r.x, y: r.y }),
    setCharacterBounds: () => undefined,
    onIntent(l: (i: TextIntent) => void) {
      intents.add(l);
      return () => intents.delete(l);
    },
    onBoundsRequest: () => () => undefined,
    dispose: () => undefined,
    emit(intent: TextIntent) {
      if (intent.kind === 'compose-start') composing = true;
      if (intent.kind === 'compose-commit' || intent.kind === 'compose-cancel') composing = false;
      for (const l of [...intents]) l(intent);
    },
  };
  return self as never;
}

describe('the TextInput port (B9)', () => {
  it('applies a state on main only when no intent is in flight, so a late state never rewinds typing', () => {
    const surface = document.createElement('div');
    document.body.append(surface);
    const platform = recordingInput();
    const queue: TextHostCommand[] = [];
    const remote = createRemoteTextHost((c) => queue.push(c), 'edit-context');
    const pending: Parameters<typeof remote.receive>[0][] = [];
    const bridge = createTextHostBridge({ surface, create: () => ok(platform), send: (e) => pending.push(e) });
    const deliverToMain = (): void => {
      for (const c of queue.splice(0)) bridge.receive(c);
    };
    const input = remote.open('t1', 'Text');
    if (!input.ok) throw input.error;
    deliverToMain();
    let model = '';
    input.value.onIntent((i) => {
      if (i.kind === 'insert') model = model.slice(0, i.range[0]) + i.text + model.slice(i.range[1]);
      input.value.setState({ text: model, selection: [model.length, model.length] });
    });
    // The person types "a" then "b" before the editor answered "a".
    platform.emit({ kind: 'insert', text: 'a', range: [0, 0] });
    platform.emit({ kind: 'insert', text: 'b', range: [1, 1] });
    remote.receive(pending.shift() as never); // the editor handles "a" and posts state "a" (1 of 2 seen)
    deliverToMain();
    expect(platform.applied).toEqual([]); // "b" is still in flight: the state for "a" is not applied
    remote.receive(pending.shift() as never);
    deliverToMain();
    expect(platform.applied).toEqual(['ab']);
    expect(bridge.sent).toBe(2);
  });

  it('places the host in surface px, offsets bounds by the surface position, drops other sessions, and hands focus back', () => {
    const surface = document.createElement('div');
    surface.tabIndex = 0;
    document.body.append(surface);
    surface.getBoundingClientRect = () => ({ left: 100, top: 50, x: 100, y: 50, width: 800, height: 600, right: 900, bottom: 650, toJSON: () => undefined }) as DOMRect;
    const platform = recordingInput();
    const opened: string[] = [];
    const closed: string[] = [];
    const bridge = createTextHostBridge({ surface, create: () => ok(platform), send: () => undefined, onOpen: (n) => opened.push(n), onClose: (n, r) => closed.push(`${n}:${r}`) });
    bridge.receive({ op: 'open', session: 1, node: 'n1', label: 'Title' });
    expect(opened).toEqual(['n1']);
    expect([bridge.host?.getAttribute('role'), bridge.host?.getAttribute('aria-label'), bridge.host?.dataset['ifTextHost']]).toEqual(['textbox', 'Title', 'n1']);
    bridge.receive({ op: 'place', session: 1, rect: { x: 10, y: 20, width: 30, height: 40 } });
    expect([bridge.host?.style.left, bridge.host?.style.top, bridge.host?.style.width]).toEqual(['10px', '20px', '30px']);
    bridge.receive({ op: 'selection', session: 1, rect: { x: 5, y: 6, width: 1, height: 20 } });
    expect(platform.bounds).toEqual([{ x: 105, y: 56 }]);
    bridge.receive({ op: 'selection', session: 9, rect: { x: 0, y: 0, width: 1, height: 1 } }); // another session: dropped
    expect(platform.bounds.length).toBe(1);
    bridge.receive({ op: 'focus', session: 1 });
    expect(platform.focusCount).toBe(1);
    bridge.receive({ op: 'close', session: 1, reason: 'escape' });
    expect(closed).toEqual(['n1:escape']);
    expect(bridge.host).toBeUndefined();
    expect(document.activeElement).toBe(surface);
  });

  it('follows the platform composing flag from the intents (true from start through updates, false before commit)', () => {
    const remote = createRemoteTextHost(() => undefined, 'edit-context');
    const input = remote.open('n', 'T');
    if (!input.ok) throw input.error;
    const seen: boolean[] = [];
    input.value.onIntent(() => seen.push(input.value.composing));
    const session = remote.session;
    remote.receive({ op: 'intent', session, base: 0, intent: { kind: 'compose-start', range: [0, 0] } });
    remote.receive({ op: 'intent', session, base: 0, intent: { kind: 'compose-update', text: 'に', range: [0, 1], selection: [1, 1] } });
    remote.receive({ op: 'intent', session, base: 0, intent: { kind: 'compose-commit', text: '日', range: [0, 1] } });
    remote.receive({ op: 'intent', session: session + 1, base: 0, intent: { kind: 'insert', text: 'x', range: [0, 0] } }); // stale
    expect(seen).toEqual([true, true, false]);
    remote.receive({ op: 'focus', session, focused: true });
    expect(input.value.focused).toBe(true);
  });

  it('numbers the states it posts, and main stamps each intent with the version it last applied (B12b P1)', () => {
    const surface = document.createElement('div');
    document.body.append(surface);
    const platform = recordingInput();
    const events: Parameters<RemoteTextHost['receive']>[0][] = [];
    const remote = createRemoteTextHost((c) => bridge.receive(c), 'edit-context');
    const bridge = createTextHostBridge({ surface, create: () => ok(platform), send: (e) => events.push(e) });
    const input = remote.open('t1', 'Text');
    if (!input.ok) throw input.error;
    platform.emit({ kind: 'insert', text: 'a', range: [0, 0] });
    input.value.setState({ text: 'a', selection: [1, 1] }); // seen 0 ≠ sent 1: dropped
    remote.receive(events[0]!);
    input.value.setState({ text: 'a', selection: [1, 1] }); // version 2, seen 1: applied
    platform.emit({ kind: 'insert', text: 'b', range: [1, 1] });
    expect(events.map((e) => (e.op === 'intent' ? e.base : -1))).toEqual([0, 2]);
  });
});

describe('rebasing intents onto the editor’s state (B12b P1)', () => {
  const at = (text: string, a: number, b = a): TextInputState => ({ text, selection: [a, b] });

  it('maps offsets through one edit between the common prefix and suffix', () => {
    const map = textOffsetMap('Hello Studio', 'Hello big Studio');
    expect([0, 5, 6, 7, 12].map(map)).toEqual([0, 5, 6, 11, 16]);
    expect(textOffsetMap('abc', 'abc')(2)).toBe(2);
    const shrink = textOffsetMap('abcdef', 'af');
    expect([0, 1, 3, 5, 6].map(shrink)).toEqual([0, 1, 1, 1, 2]);
  });

  it('leaves an intent alone when main saw what the editor holds', () => {
    const intent: TextIntent = { kind: 'insert', text: 'x', range: [3, 3] };
    expect(rebaseIntent(intent, at('Hello', 3), at('Hello', 3))).toBe(intent);
  });

  it('moves an insert or composition start at main’s caret to the editor’s selection', () => {
    expect(rebaseIntent({ kind: 'insert', text: '!', range: [6, 6] }, at('Hello Studio', 6), at('Hello Studio', 12))).toEqual({ kind: 'insert', text: '!', range: [12, 12] });
    expect(rebaseIntent({ kind: 'insert', text: 'Z', range: [12, 12] }, at('Hello Studio', 12), at('Hello Studio', 12, 6))).toEqual({ kind: 'insert', text: 'Z', range: [6, 12] });
    expect(rebaseIntent({ kind: 'compose-start', range: [12, 12] }, at('Hello Studio', 12), at('Hello Studio', 0))).toEqual({ kind: 'compose-start', range: [0, 0] });
  });

  it('maps a range away from main’s caret through the text change (autocorrect after a remote edit)', () => {
    expect(rebaseIntent({ kind: 'insert', text: 'World', range: [6, 12] }, at('Hello Studio!', 13), at('Oh, Hello Studio!', 17))).toEqual({ kind: 'insert', text: 'World', range: [10, 16] });
    expect(rebaseIntent({ kind: 'selection', selection: [0, 5] }, at('Hello', 5), at('Hi Hello', 8))).toEqual({ kind: 'selection', selection: [0, 8] });
  });

  it('turns a delete at main’s caret into one at the editor’s caret, by grapheme, word or the selection', () => {
    const backspace: TextIntent = { kind: 'delete', range: [5, 6], direction: 'backward', unit: 'selection' };
    expect(rebaseIntent(backspace, at('Hello Studio', 6), at('Hello Studio', 12))).toEqual({ ...backspace, range: [12, 12], unit: 'grapheme' });
    const word: TextIntent = { kind: 'delete', range: [0, 5], direction: 'backward', unit: 'selection' };
    expect(rebaseIntent(word, at('Hello Studio', 5), at('Hello Studio', 12))).toEqual({ ...word, range: [12, 12], unit: 'word' });
    const forward: TextIntent = { kind: 'delete', range: [0, 1], direction: 'forward', unit: 'selection' };
    expect(rebaseIntent(forward, at('Hello', 0), at('Hello', 1, 4))).toEqual({ ...forward, range: [1, 4], unit: 'selection' });
    const collapsed: TextIntent = { kind: 'delete', range: [3, 3], direction: 'backward', unit: 'word' }; // hidden textarea
    expect(rebaseIntent(collapsed, at('Hi there', 3), at('Hi there', 8))).toEqual({ ...collapsed, range: [8, 8] });
    expect(rebaseIntent({ ...backspace, range: [0, 12] }, at('Hello Studio', 0, 12), at('Hello Studio', 4))).toEqual({ ...backspace, range: [4, 4], unit: 'grapheme' });
  });

  it('leaves composition updates, commits, keys and formats to the session', () => {
    const update: TextIntent = { kind: 'compose-update', text: 'に', range: [6, 6], selection: [7, 7] };
    expect(rebaseIntent(update, at('Hello Studio', 6), at('Hello Studio', 12))).toBe(update);
    const key: TextIntent = { kind: 'key', key: 'End', shift: false, mod: false, alt: false };
    expect(rebaseIntent(key, at('a', 0), at('a', 1))).toBe(key);
  });

  it('hidden textarea: two keys typed before the first state both go in at the caret, in order', () => {
    const remote = createRemoteTextHost(() => undefined, 'hidden-textarea');
    const input = remote.open('n', 'T');
    if (!input.ok) throw input.error;
    let model = '';
    input.value.onIntent((i) => {
      if (i.kind !== 'insert') return;
      model = model.slice(0, i.range[0]) + i.text + model.slice(i.range[1]);
      input.value.setState({ text: model, selection: [i.range[0] + i.text.length, i.range[0] + i.text.length] });
    });
    // The textarea cancels both inserts and still reads "" with its caret at 0 for the second.
    remote.receive({ op: 'intent', session: remote.session, base: 0, intent: { kind: 'insert', text: 'a', range: [0, 0] } });
    remote.receive({ op: 'intent', session: remote.session, base: 0, intent: { kind: 'insert', text: 'b', range: [0, 0] } });
    expect(model).toBe('ab');
  });
});
