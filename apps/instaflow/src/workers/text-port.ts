/**
 * The TextInput port across the worker boundary (B9, IF-33.9–33.11; ARCHITECTURE §5.3). EditContext (or the hidden
 * textarea) stays on main on the text host; B2's text session runs in the editor module.
 *
 * - main → editor (`TextHostEvent`): the platform's intents in order, bounds requests, focus changes.
 * - editor → main (`TextHostCommand`): open / place / close the host, the session's state, and the caret, selection,
 *   control and character bounds (surface px; main adds the surface's client offset when it applies them).
 *
 * **Ordering.** `composing` on the editor side follows the intents exactly as the platform input does (true from
 * `compose-start` through updates, false before `compose-commit` / `compose-cancel` is handled). Each `state` command
 * carries how many intents the editor had handled; main applies it only when no intent is still in flight, so a late
 * state never rewinds what the person typed meanwhile (the next state follows the remaining intents).
 * Events of an earlier host (`session` mismatch) are dropped on both sides.
 */
import { ok, type Result, type SfError } from '@staticflux/core';
import type { NodeId } from '@staticflux/document/v2';
import type { ClientRect, TextInput, TextInputKind, TextInputState, TextIntent, TextRange } from '@staticflux/surface/text-input';
import type { TextExitReason, TextHostPort } from '../app/text-editing.js';

export type TextHostCommand =
  | { readonly op: 'open'; readonly session: number; readonly node: NodeId; readonly label: string }
  | { readonly op: 'place'; readonly session: number; readonly rect: ClientRect }
  | { readonly op: 'close'; readonly session: number; readonly reason: TextExitReason }
  | { readonly op: 'state'; readonly session: number; readonly state: TextInputState; readonly seen: number }
  | { readonly op: 'control'; readonly session: number; readonly rect: ClientRect }
  | { readonly op: 'selection'; readonly session: number; readonly rect: ClientRect }
  | { readonly op: 'chars'; readonly session: number; readonly start: number; readonly rects: readonly ClientRect[] }
  | { readonly op: 'focus'; readonly session: number }
  | { readonly op: 'blur'; readonly session: number };

export type TextHostEvent =
  | { readonly op: 'intent'; readonly session: number; readonly intent: TextIntent }
  | { readonly op: 'bounds'; readonly session: number; readonly range: TextRange }
  | { readonly op: 'focus'; readonly session: number; readonly focused: boolean };

// ---------------------------------------------------------------- editor side

export interface RemoteTextHost extends TextHostPort {
  /** Deliver an event from main. */
  receive(event: TextHostEvent): void;
  /** The open session (0: none). */
  readonly session: number;
}

/** The editor side: a `TextHostPort` whose TextInputs talk to main through `send`. */
export function createRemoteTextHost(send: (command: TextHostCommand) => void, kind: TextInputKind): RemoteTextHost {
  let session = 0;
  let current: { readonly session: number; readonly input: RemoteInput } | undefined;
  interface RemoteInput extends TextInput {
    deliver(event: TextHostEvent): void;
  }
  const remoteInput = (id: number): RemoteInput => {
    const intents = new Set<(intent: TextIntent) => void>();
    const requests = new Set<(range: TextRange) => void>();
    let state: TextInputState = { text: '', selection: [0, 0] };
    let composing = false;
    let focused = false;
    let seen = 0;
    let disposed = false;
    const post = (command: TextHostCommand): void => {
      if (!disposed) send(command);
    };
    return {
      kind,
      focus: () => post({ op: 'focus', session: id }),
      blur: () => post({ op: 'blur', session: id }),
      get focused() {
        return focused;
      },
      get composing() {
        return composing;
      },
      get state() {
        return state;
      },
      setState(next) {
        state = next;
        post({ op: 'state', session: id, state: next, seen });
      },
      setControlBounds: (rect) => post({ op: 'control', session: id, rect }),
      setSelectionBounds: (rect) => post({ op: 'selection', session: id, rect }),
      setCharacterBounds: (start, rects) => post({ op: 'chars', session: id, start, rects: [...rects] }),
      onIntent(listener) {
        intents.add(listener);
        return () => intents.delete(listener);
      },
      onBoundsRequest(listener) {
        requests.add(listener);
        return () => requests.delete(listener);
      },
      dispose() {
        disposed = true;
        intents.clear();
        requests.clear();
      },
      deliver(event) {
        if (disposed) return;
        if (event.op === 'focus') {
          focused = event.focused;
          return;
        }
        if (event.op === 'bounds') {
          for (const l of [...requests]) l(event.range);
          return;
        }
        const intent = event.intent;
        seen += 1;
        if (intent.kind === 'compose-start' || intent.kind === 'compose-update') composing = true;
        if (intent.kind === 'compose-commit' || intent.kind === 'compose-cancel') composing = false;
        for (const l of [...intents]) l(intent);
      },
    };
  };
  return {
    get session() {
      return current?.session ?? 0;
    },
    open(node, label): Result<TextInput> {
      session += 1;
      const input = remoteInput(session);
      current = { session, input };
      send({ op: 'open', session, node, label });
      return ok(input);
    },
    place(rect) {
      if (current !== undefined) send({ op: 'place', session: current.session, rect });
    },
    close(reason) {
      if (current === undefined) return;
      send({ op: 'close', session: current.session, reason });
      current = undefined;
    },
    receive(event) {
      if (current !== undefined && event.session === current.session) current.input.deliver(event);
    },
  };
}

// ---------------------------------------------------------------- main side

export interface TextHostBridgeOptions {
  /** The canvas surface (the host goes inside it; rects are relative to it). */
  readonly surface: HTMLElement;
  /** Create the platform TextInput on the host (the bound `TextInputFactory`). */
  readonly create: (host: HTMLElement, label: string) => Result<TextInput>;
  /** Send an event to the editor. */
  readonly send: (event: TextHostEvent) => void;
  /** The host opened (`node`) or closed. */
  readonly onOpen?: (node: NodeId, host: HTMLElement) => void;
  readonly onClose?: (node: NodeId, reason: TextExitReason) => void;
  readonly onProblem?: (error: SfError) => void;
}

export interface TextHostBridge {
  /** Apply a command from the editor. */
  receive(command: TextHostCommand): void;
  /** The open host (tests, the shortcut focus check). */
  readonly host: HTMLElement | undefined;
  /** The platform input of the open host. */
  readonly input: TextInput | undefined;
  /** Intents sent to the editor for the open host. */
  readonly sent: number;
  dispose(): void;
}

/** The main side: one host and platform TextInput per editor session (see the module header). */
export function createTextHostBridge(options: TextHostBridgeOptions): TextHostBridge {
  interface Open {
    readonly session: number;
    readonly node: NodeId;
    readonly host: HTMLElement;
    readonly input: TextInput;
    readonly stop: () => void;
    sent: number;
  }
  let open: Open | undefined;
  const offset = (rect: ClientRect): ClientRect => {
    const box = options.surface.getBoundingClientRect();
    return { x: rect.x + box.left, y: rect.y + box.top, width: rect.width, height: rect.height };
  };
  const close = (reason: TextExitReason): void => {
    const was = open;
    if (was === undefined) return;
    open = undefined;
    was.stop();
    was.input.dispose();
    was.host.remove();
    options.onClose?.(was.node, reason);
    if (reason !== 'stopped') options.surface.focus({ preventScroll: true });
  };
  const COMMANDS: { readonly [K in TextHostCommand['op']]: (o: Open, c: Extract<TextHostCommand, { op: K }>) => void } = {
    open: () => undefined,
    place: (_o, c) => {
      const s = _o.host.style;
      s.left = `${c.rect.x}px`;
      s.top = `${c.rect.y}px`;
      s.width = `${c.rect.width}px`;
      s.height = `${c.rect.height}px`;
    },
    close: (_o, c) => close(c.reason),
    state: (o, c) => {
      if (c.seen === o.sent && !o.input.composing) o.input.setState(c.state);
    },
    control: (o, c) => o.input.setControlBounds(offset(c.rect)),
    selection: (o, c) => o.input.setSelectionBounds(offset(c.rect)),
    chars: (o, c) => o.input.setCharacterBounds(c.start, c.rects.map(offset)),
    focus: (o) => o.input.focus(),
    blur: (o) => o.input.blur(),
  };
  const openHost = (command: Extract<TextHostCommand, { op: 'open' }>): void => {
    close('stopped');
    const doc = options.surface.ownerDocument;
    const host = doc.createElement('div');
    host.dataset['ifTextHost'] = command.node;
    host.setAttribute('role', 'textbox');
    host.setAttribute('aria-multiline', 'true');
    host.setAttribute('aria-label', command.label);
    Object.assign(host.style, { position: 'absolute', outline: 'none' });
    options.surface.append(host);
    const input = options.create(host, command.label);
    if (!input.ok) {
      host.remove();
      options.onProblem?.(input.error);
      return;
    }
    const session = command.session;
    const entry: Open = {
      session,
      node: command.node,
      host,
      input: input.value,
      sent: 0,
      stop: () => {
        offIntent();
        offBounds();
        host.removeEventListener('focus', onFocus);
        host.removeEventListener('blur', onBlur);
      },
    };
    const offIntent = input.value.onIntent((intent) => {
      entry.sent += 1;
      options.send({ op: 'intent', session, intent });
    });
    const offBounds = input.value.onBoundsRequest((range) => options.send({ op: 'bounds', session, range }));
    const onFocus = (): void => options.send({ op: 'focus', session, focused: true });
    const onBlur = (): void => options.send({ op: 'focus', session, focused: false });
    host.addEventListener('focus', onFocus);
    host.addEventListener('blur', onBlur);
    open = entry;
    options.onOpen?.(command.node, host);
  };
  return {
    receive(command) {
      if (command.op === 'open') return openHost(command);
      if (open === undefined || open.session !== command.session) return;
      (COMMANDS[command.op] as (o: Open, c: TextHostCommand) => void)(open, command);
    },
    get host() {
      return open?.host;
    },
    get input() {
      return open?.input;
    },
    get sent() {
      return open?.sent ?? 0;
    },
    dispose: () => close('stopped'),
  };
}
