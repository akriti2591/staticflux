/**
 * Isolated realms for untrusted plugins (R3.4). A realm hands the host ONE
 * MessagePort-backed `Port`; nothing else crosses the boundary.
 *
 * - `iframeRealm`  `<iframe sandbox="allow-scripts">` — never `allow-same-origin`, so the
 *                  plugin runs in an opaque origin (no cookies, storage, or parent DOM).
 *                  `srcdoc` carries a CSP meta (`default-src 'none'`, `connect-src 'none'`):
 *                  the plugin cannot fetch; it can only call granted capabilities.
 *                  Cross-origin module entries must be served with CORS (`Origin: null`).
 * - `workerRealm`  dedicated module worker: no DOM, but SAME ORIGIN (network + storage). Only
 *                  for semi-trusted code, or host the worker inside a sandboxed iframe; you must
 *                  pass `acknowledgeSameOrigin: true`.
 * - `inMemoryRealm` in-thread over a port pair (tests, devtools). Not isolated.
 *
 * In-realm JS sandboxes (Realms/SES shims) are not a security boundary (research §2).
 */
import { err, ok, type Result, toSfError } from '@staticflux/core';
import { createPortPair, fromMessagePort, type Port, type PortPair } from '@staticflux/worker';
import { SandboxUnsupportedError } from './errors.js';
import type { PluginEntryKind, PluginManifest } from './manifest.js';
import { CONNECT_TAG, type ConnectMessage, SANDBOX_PROTOCOL_VERSION } from './protocol.js';

export interface RealmContext {
  readonly manifest: PluginManifest;
  /** Host-provided slot (iframe mode). Plugins without `render` are mounted hidden. */
  readonly slot: Element | undefined;
  /** The plugin holds the `render` permission. */
  readonly visible: boolean;
  /** 1-based (re)start attempt. */
  readonly attempt: number;
  readonly signal: AbortSignal;
}

export interface PluginRealm {
  readonly port: Port;
  /** The iframe element (iframe realms). */
  readonly element?: HTMLIFrameElement;
  /** Apply a plugin's resize request (already validated and permission-checked). */
  resize?(height: number): void;
  /** Hard stop: remove the iframe / terminate the worker / close the pair. */
  terminate(): void;
}

export type RealmFactory = (context: RealmContext) => Result<PluginRealm>;
export type RealmFactories = Partial<Record<PluginEntryKind, RealmFactory>>;

/** A message channel: our side as a Port, the other end to transfer into the realm. */
export interface RealmChannel {
  readonly local: Port;
  readonly remote: unknown;
}

function messageChannel(): Result<RealmChannel> {
  if (typeof MessageChannel !== 'function') return err(SandboxUnsupportedError({ details: { missing: 'MessageChannel' } }));
  const channel = new MessageChannel();
  return ok({ local: fromMessagePort(channel.port1), remote: channel.port2 });
}

function connectMessage(manifest: PluginManifest): ConnectMessage {
  return { sf: CONNECT_TAG, plugin: manifest.id, protocol: SANDBOX_PROTOCOL_VERSION };
}

// ---------------------------------------------------------------- iframe

/** Extra sandbox tokens a host may allow. `allow-same-origin` / `allow-top-navigation*` are never possible. */
export type IframeSandboxToken = 'allow-forms' | 'allow-modals' | 'allow-popups' | 'allow-downloads' | 'allow-pointer-lock';

const FORBIDDEN_TOKENS = new Set(['allow-same-origin', 'allow-top-navigation', 'allow-top-navigation-by-user-activation', 'allow-popups-to-escape-sandbox']);

export interface CspContext {
  /** `script-src` source for the entry (an origin, `blob:`, or a nonce source). */
  readonly scriptSrc: string;
}

/** Default CSP of the plugin document: scripts from the entry only, no network, no frames, no forms. */
export function defaultPluginCsp(context: CspContext): string {
  return [
    "default-src 'none'",
    `script-src ${context.scriptSrc}`,
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

export interface IframeRealmOptions {
  readonly document?: Document;
  readonly sandbox?: readonly IframeSandboxToken[];
  readonly csp?: (context: CspContext) => string;
  /** Upper bound for plugin resize requests (px). Default 4000. */
  readonly maxHeight?: number;
  /** Default: a real MessageChannel. */
  readonly channel?: () => Result<RealmChannel>;
  /** Default: `iframe.contentWindow.postMessage(message, '*', [remote])` on the first `load`. */
  readonly connect?: (iframe: HTMLIFrameElement, message: ConnectMessage, remote: unknown) => void;
  readonly nonce?: () => string;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeInlineScript(code: string): string {
  return code.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (typeof c?.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The `srcdoc` of a plugin iframe (exported for tests and audits). */
export function buildPluginDocument(
  manifest: PluginManifest,
  options: { readonly baseUrl: string; readonly csp?: (context: CspContext) => string; readonly nonce?: () => string },
): Result<string> {
  const entry = manifest.entry;
  if (entry.kind !== 'iframe') return err(SandboxUnsupportedError({ details: { plugin: manifest.id, entry: entry.kind, realm: 'iframe' } }));
  const csp = options.csp ?? defaultPluginCsp;
  let script: string;
  let scriptSrc: string;
  if ('code' in entry) {
    const nonce = (options.nonce ?? randomNonce)();
    scriptSrc = `'nonce-${nonce}'`;
    script = `<script type="module" nonce="${escapeAttribute(nonce)}">${escapeInlineScript(entry.code)}</script>`;
  } else {
    let url: URL;
    try {
      url = new URL(entry.url, options.baseUrl);
    } catch (error) {
      return err(SandboxUnsupportedError({ cause: toSfError(error), details: { plugin: manifest.id, url: entry.url } }));
    }
    scriptSrc = url.protocol === 'blob:' ? 'blob:' : url.origin;
    script = `<script type="module" src="${escapeAttribute(url.href)}"></script>`;
  }
  const title = escapeAttribute(manifest.name ?? manifest.id);
  return ok(
    '<!doctype html><html><head><meta charset="utf-8">' +
      `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp({ scriptSrc }))}">` +
      `<meta name="referrer" content="no-referrer"><title>${title}</title></head><body>${script}</body></html>`,
  );
}

export function iframeRealm(options: IframeRealmOptions = {}): RealmFactory {
  return (context) => {
    const doc = options.document ?? (globalThis as { document?: Document }).document;
    if (doc === undefined) return err(SandboxUnsupportedError({ details: { plugin: context.manifest.id, missing: 'document' } }));
    const tokens = ['allow-scripts', ...(options.sandbox ?? [])];
    const forbidden = tokens.find((t) => FORBIDDEN_TOKENS.has(t));
    if (forbidden !== undefined) {
      return err(SandboxUnsupportedError({ message: `Sandbox token "${forbidden}" would break isolation.`, details: { token: forbidden } }));
    }
    const html = buildPluginDocument(context.manifest, {
      baseUrl: doc.baseURI,
      ...(options.csp === undefined ? {} : { csp: options.csp }),
      ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
    });
    if (!html.ok) return html;
    const channel = (options.channel ?? messageChannel)();
    if (!channel.ok) return channel;
    const maxHeight = options.maxHeight ?? 4000;

    const iframe = doc.createElement('iframe');
    iframe.setAttribute('sandbox', tokens.join(' '));
    iframe.setAttribute('allow', '');
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.setAttribute('credentialless', '');
    iframe.setAttribute('loading', 'eager');
    iframe.setAttribute('data-sf-plugin', context.manifest.id);
    iframe.title = context.manifest.name ?? context.manifest.id;
    iframe.style.border = '0';
    iframe.style.width = '100%';
    if (!context.visible) {
      iframe.style.display = 'none';
      iframe.setAttribute('aria-hidden', 'true');
      iframe.tabIndex = -1;
    }
    iframe.srcdoc = html.value;

    const connect =
      options.connect ??
      ((frame: HTMLIFrameElement, message: ConnectMessage, remote: unknown) => {
        // Opaque-origin iframe: '*' is the only possible targetOrigin; we post to this exact window.
        frame.contentWindow?.postMessage(message, '*', [remote as Transferable]);
      });
    const controller = new AbortController();
    iframe.addEventListener(
      'load',
      () => {
        connect(iframe, connectMessage(context.manifest), channel.value.remote);
      },
      { once: true, signal: controller.signal },
    );
    const parent = context.slot ?? doc.body;
    parent.appendChild(iframe);

    return ok({
      port: channel.value.local,
      element: iframe,
      resize(height) {
        iframe.style.height = `${Math.min(Math.max(0, Math.round(height)), maxHeight)}px`;
      },
      terminate() {
        controller.abort();
        channel.value.local.close();
        iframe.remove();
      },
    });
  };
}

// ---------------------------------------------------------------- worker

export interface WorkerLike {
  postMessage(message: unknown, transfer: Transferable[]): void;
  terminate(): void;
}

export interface WorkerRealmOptions {
  /** Workers share the app origin (network, storage). Required to make that choice explicit. */
  readonly acknowledgeSameOrigin: true;
  /** Default `new Worker(url, { type: 'module', name: manifest.id })`. */
  readonly create?: (url: string, manifest: PluginManifest) => WorkerLike;
  readonly channel?: () => Result<RealmChannel>;
}

export function workerRealm(options: WorkerRealmOptions): RealmFactory {
  return (context) => {
    const entry = context.manifest.entry;
    if (entry.kind !== 'worker') return err(SandboxUnsupportedError({ details: { plugin: context.manifest.id, entry: entry.kind, realm: 'worker' } }));
    const WorkerCtor = (globalThis as { Worker?: new (url: string, options: WorkerOptions) => WorkerLike }).Worker;
    const create =
      options.create ??
      (WorkerCtor === undefined ? undefined : (url: string, manifest: PluginManifest) => new WorkerCtor(url, { type: 'module', name: manifest.id }));
    if (create === undefined) return err(SandboxUnsupportedError({ details: { plugin: context.manifest.id, missing: 'Worker' } }));
    const channel = (options.channel ?? messageChannel)();
    if (!channel.ok) return channel;
    let worker: WorkerLike;
    try {
      worker = create(entry.url, context.manifest);
    } catch (error) {
      channel.value.local.close();
      return err(SandboxUnsupportedError({ cause: toSfError(error), details: { plugin: context.manifest.id, url: entry.url } }));
    }
    worker.postMessage(connectMessage(context.manifest), [channel.value.remote as Transferable]);
    return ok({
      port: channel.value.local,
      terminate() {
        channel.value.local.close();
        worker.terminate();
      },
    });
  };
}

// ---------------------------------------------------------------- in-memory (tests)

export interface InMemoryRealmContext extends RealmContext {
  readonly pair: PortPair;
}

/** Run `start(pluginPort, context)` in-thread. `context.pair.crash()` simulates a realm crash. NOT isolated. */
export function inMemoryRealm(start: (port: Port, context: InMemoryRealmContext) => void): RealmFactory {
  return (context) => {
    const pair = createPortPair();
    try {
      start(pair.b, { ...context, pair });
    } catch (error) {
      pair.close();
      return err(SandboxUnsupportedError({ cause: toSfError(error), details: { plugin: context.manifest.id, realm: 'in-memory' } }));
    }
    return ok({ port: pair.a, terminate: () => pair.close() });
  };
}
