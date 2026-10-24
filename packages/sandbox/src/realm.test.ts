import { allowAllDecidePort, alwaysActivePort, createCapabilityRegistry, defineCapability, failClosedConfirmPort, implementCapability, s, unmeteredPort } from '@staticflux/capabilities';
import { ok } from '@staticflux/core';
import { createPortPair, type Port } from '@staticflux/worker';
import { describe, expect, it, vi } from 'vitest';
import {
  buildPluginDocument,
  type ConnectMessage,
  connectToHost,
  createPluginHost,
  defaultPluginCsp,
  definePluginManifest,
  iframeRealm,
  inMemoryRealm,
  type PluginManifest,
  type RealmContext,
  workerRealm,
} from './index.js';

const base = {
  id: 'acme/counter',
  version: '1.0.0',
  name: 'Counter <b>',
  capabilities: ['test/echo'],
  events: [],
  permissions: ['render'],
} as const;

const urlManifest: PluginManifest = definePluginManifest({ ...base, entry: { kind: 'iframe', url: 'https://plugins.example/p.js?a=1&b="2"' } });
const codeManifest: PluginManifest = definePluginManifest({ ...base, entry: { kind: 'iframe', code: 'const x = "</script><script>alert(1)</script>"; <!-- x' } });
const workerManifest: PluginManifest = definePluginManifest({ ...base, entry: { kind: 'worker', url: 'https://plugins.example/w.js' } });

function context(manifest: PluginManifest, overrides: Partial<RealmContext> = {}): RealmContext {
  return { manifest, slot: undefined, visible: true, attempt: 1, signal: new AbortController().signal, ...overrides };
}

describe('buildPluginDocument', () => {
  it('pins scripts to the entry origin with a no-network CSP and escapes attributes', () => {
    const html = buildPluginDocument(urlManifest, { baseUrl: 'https://app.example/' });
    expect(html.ok).toBe(true);
    if (!html.ok) return;
    expect(html.value).toContain('script-src https://plugins.example');
    expect(html.value).toContain("connect-src 'none'");
    expect(html.value).toContain("default-src 'none'");
    expect(html.value).toContain('src="https://plugins.example/p.js?a=1&amp;b=%222%22"');
    expect(html.value).toContain('<title>Counter &lt;b&gt;</title>');
  });

  it('runs inline code under a nonce and neutralises </script> breakouts', () => {
    const html = buildPluginDocument(codeManifest, { baseUrl: 'https://app.example/', nonce: () => 'n0nce' });
    if (!html.ok) throw html.error;
    expect(html.value).toContain("script-src 'nonce-n0nce'");
    expect(html.value).toContain('nonce="n0nce"');
    expect(html.value).not.toContain('</script><script>alert(1)');
    expect(html.value.match(/<\/script>/g)).toHaveLength(1);
    expect(html.value).toContain('<\\!--');
    const random = buildPluginDocument(codeManifest, { baseUrl: 'https://app.example/' });
    expect(random.ok && /'nonce-[0-9a-f]{32}'/.test(random.value)).toBe(true);
  });

  it('resolves relative and blob entries; supports a custom CSP; refuses worker entries', () => {
    const rel = buildPluginDocument({ ...urlManifest, entry: { kind: 'iframe', url: '/plugins/p.js' } }, { baseUrl: 'https://app.example/x/' });
    expect(rel.ok && rel.value).toContain('src="https://app.example/plugins/p.js"');
    const blob = buildPluginDocument({ ...urlManifest, entry: { kind: 'iframe', url: 'blob:https://app.example/123' } }, { baseUrl: 'https://app.example/', csp: (c) => `script-src ${c.scriptSrc}` });
    expect(blob.ok && blob.value).toContain('content="script-src blob:"');
    expect(buildPluginDocument(workerManifest, { baseUrl: 'https://app.example/' }).ok).toBe(false);
    expect(defaultPluginCsp({ scriptSrc: "'self'" })).toContain("frame-src 'none'");
  });
});

describe('iframeRealm', () => {
  it('mounts a sandboxed iframe without allow-same-origin into the slot and connects on load', () => {
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    const pair = createPortPair();
    const connect = vi.fn<(iframe: HTMLIFrameElement, message: ConnectMessage, remote: unknown) => void>();
    const realm = iframeRealm({ channel: () => ok({ local: pair.a, remote: pair.b }), connect, sandbox: ['allow-forms'], maxHeight: 300 })(
      context(urlManifest, { slot }),
    );
    if (!realm.ok) throw realm.error;
    const iframe = realm.value.element as HTMLIFrameElement;
    expect(iframe.parentElement).toBe(slot);
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-forms');
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(iframe.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(iframe.getAttribute('allow')).toBe('');
    expect(iframe.getAttribute('data-sf-plugin')).toBe('acme/counter');
    expect(iframe.srcdoc).toContain('Content-Security-Policy');
    expect(iframe.style.display).not.toBe('none');
    iframe.dispatchEvent(new Event('load'));
    iframe.dispatchEvent(new Event('load'));
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect.mock.calls[0]?.[1]).toEqual({ sf: 'sandbox/connect', plugin: 'acme/counter', protocol: 1 });
    expect(connect.mock.calls[0]?.[2]).toBe(pair.b);
    realm.value.resize?.(1000);
    expect(iframe.style.height).toBe('300px');
    realm.value.resize?.(-5);
    expect(iframe.style.height).toBe('0px');
    realm.value.terminate();
    expect(iframe.isConnected).toBe(false);
    expect(pair.a.closed).toBe(true);
  });

  it('mounts plugins without `render` hidden, and refuses isolation-breaking tokens', () => {
    const realm = iframeRealm({ channel: () => ok({ local: createPortPair().a, remote: null }), connect: () => undefined })(
      context(urlManifest, { visible: false }),
    );
    if (!realm.ok) throw realm.error;
    expect(realm.value.element?.style.display).toBe('none');
    expect(realm.value.element?.getAttribute('aria-hidden')).toBe('true');
    expect(realm.value.element?.parentElement).toBe(document.body);
    realm.value.terminate();
    const bad = iframeRealm({ sandbox: ['allow-same-origin' as never] })(context(urlManifest));
    expect(!bad.ok && bad.error.code).toBe('SF-SBX-010');
    const wrong = iframeRealm()(context(workerManifest));
    expect(!wrong.ok && wrong.error.code).toBe('SF-SBX-010');
  });

  it('end to end: host ⇄ SDK over a real MessageChannel transferred on load', async () => {
    const Echo = defineCapability({
      id: 'test/echo',
      description: 'Echo.',
      input: s.object({ text: s.string() }),
      output: s.object({ text: s.string() }),
      requiresConfirmation: false,
      destructive: false,
    });
    const registry = createCapabilityRegistry({
      decide: allowAllDecidePort,
      confirm: failClosedConfirmPort,
      meter: unmeteredPort,
      activation: alwaysActivePort,
      implementations: [implementCapability(Echo, (input) => ok({ text: input.text.toUpperCase() }))],
    });
    // The shim plays the iframe's window: it receives the connect message with the transferred port.
    const pluginWindow = new EventTarget();
    const realm = iframeRealm({
      connect: (_iframe, message, remote) => {
        pluginWindow.dispatchEvent(new MessageEvent('message', { data: message, ports: [remote as MessagePort] }));
      },
    });
    const host = createPluginHost({ registry, realms: { iframe: realm }, heartbeatMs: false });
    const slot = document.createElement('section');
    document.body.appendChild(slot);
    const registered = host.register(urlManifest, { slot });
    if (!registered.ok) throw registered.error;
    const running = registered.value.start();
    const clientPromise = connectToHost({ pluginId: 'acme/counter', target: pluginWindow, timeoutMs: 1000 });
    registered.value.element?.dispatchEvent(new Event('load'));
    const client = await clientPromise;
    expect(await running).toEqual(ok());
    if (!client.ok) throw client.error;
    expect(slot.querySelector('iframe')).toBe(registered.value.element);
    expect(await client.value.invoke(Echo, { text: 'hey' })).toEqual(ok({ text: 'HEY' }));
    client.value.close();
    await host.dispose();
    expect(slot.querySelector('iframe')).toBeNull();
  });
});

describe('connectToHost', () => {
  it('ignores foreign messages, honours `parent` as the only source, and times out', async () => {
    const parent = {};
    const target = Object.assign(new EventTarget(), { parent });
    const channel = new MessageChannel();
    const pending = connectToHost({ pluginId: 'acme/counter', target, timeoutMs: 50 });
    target.dispatchEvent(new MessageEvent('message', { data: { sf: 'sandbox/connect', plugin: 'acme/counter', protocol: 1 }, ports: [channel.port2] }));
    target.dispatchEvent(new MessageEvent('message', { data: { sf: 'sandbox/connect', plugin: 'other/x', protocol: 1 } }));
    const result = await pending;
    expect(!result.ok && result.error.code).toBe('SF-SBX-008');
    channel.port1.close();
    channel.port2.close();
  });

  it('fails the handshake when the host refuses, and honours an abort signal', async () => {
    const pair = createPortPair();
    const hostSide = await import('@staticflux/worker').then((w) => w.createLink({ port: pair.a }));
    hostSide.handle('sandbox/hello', () => ok({ nonsense: true }));
    const malformed = await connectToHost({ pluginId: 'acme/counter', port: pair.b, timeoutMs: 200 });
    expect(!malformed.ok && malformed.error.code).toBe('SF-SBX-008');

    const silent = createPortPair();
    const controller = new AbortController();
    const aborted = connectToHost({ pluginId: 'acme/counter', port: silent.b, signal: controller.signal, timeoutMs: 5000 });
    controller.abort();
    const result = await aborted;
    expect(!result.ok && result.error.code).toBe('SF-SBX-008');
  });
});

describe('workerRealm / inMemoryRealm', () => {
  it('posts the connect message with the transferred port and terminates the worker', () => {
    const posted: { message: unknown; transfer: unknown[] }[] = [];
    const terminate = vi.fn();
    const pair = createPortPair();
    const realm = workerRealm({
      acknowledgeSameOrigin: true,
      channel: () => ok({ local: pair.a, remote: 'remote-port' }),
      create: (url, manifest) => {
        expect(url).toBe('https://plugins.example/w.js');
        expect(manifest.id).toBe('acme/counter');
        return { postMessage: (message, transfer) => posted.push({ message, transfer }), terminate };
      },
    })(context(workerManifest));
    if (!realm.ok) throw realm.error;
    expect(posted).toEqual([{ message: { sf: 'sandbox/connect', plugin: 'acme/counter', protocol: 1 }, transfer: ['remote-port'] }]);
    realm.value.terminate();
    expect(terminate).toHaveBeenCalled();
    expect(pair.a.closed).toBe(true);
  });

  it('reports unsupported environments and wrong entries (SF-SBX-010)', () => {
    const wrong = workerRealm({ acknowledgeSameOrigin: true })(context(urlManifest));
    expect(!wrong.ok && wrong.error.code).toBe('SF-SBX-010');
    const original = (globalThis as { Worker?: unknown }).Worker;
    (globalThis as { Worker?: unknown }).Worker = undefined;
    const missing = workerRealm({ acknowledgeSameOrigin: true })(context(workerManifest));
    (globalThis as { Worker?: unknown }).Worker = original;
    expect(!missing.ok && missing.error.code).toBe('SF-SBX-010');
    const throwing = workerRealm({
      acknowledgeSameOrigin: true,
      channel: () => ok({ local: createPortPair().a, remote: null }),
      create: () => {
        throw new Error('CSP worker-src');
      },
    })(context(workerManifest));
    expect(!throwing.ok && throwing.error.code).toBe('SF-SBX-010');
  });

  it('inMemoryRealm runs the plugin in-thread and maps a throwing start to SF-SBX-010', () => {
    let pluginPort: Port | undefined;
    const realm = inMemoryRealm((port) => {
      pluginPort = port;
    })(context(urlManifest));
    expect(realm.ok && pluginPort !== undefined).toBe(true);
    if (realm.ok) realm.value.terminate();
    const broken = inMemoryRealm(() => {
      throw new Error('boom');
    })(context(urlManifest));
    expect(!broken.ok && broken.error.code).toBe('SF-SBX-010');
  });
});
