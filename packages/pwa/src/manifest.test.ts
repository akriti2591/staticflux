import { createInjector, ok, unwrap } from '@staticflux/core';
import { manifestUnit, type SfManifest } from '@staticflux/loader';
import { describe, expect, it } from 'vitest';
import {
  createFakePageEnv,
  defineWebAppManifest,
  FakeLaunchQueue,
  FakeServiceWorker,
  isMessageOf,
  isPwaMessage,
  type LaunchIntent,
  launchIntentPortUnit,
  LaunchQueueToken,
  launchQueueUnit,
  MutationQueueToken,
  mutationQueueUnit,
  nextMessageId,
  PWA_MESSAGE,
  pwaOptionsUnit,
  pwaPageEnvUnit,
  PwaUpdaterToken,
  pwaUpdaterUnit,
  reinitializePortUnit,
  shareTargetParamsOf,
  SwWarmupToken,
  swWarmupUnit,
  updatePromptUnit,
  webAppManifestJson,
  type WebAppManifestDeclaration,
} from './index.js';

const base: WebAppManifestDeclaration = {
  name: 'Studio',
  icons: [{ src: '/icons/192.png', sizes: '192x192', type: 'image/png', purpose: ['any', 'maskable'] }],
};

describe('web app manifest builder', () => {
  it('maps the typed declaration to spec JSON (snake_case, defaults)', () => {
    const result = defineWebAppManifest({
      ...base,
      id: '/studio',
      shortName: 'St',
      description: 'Editor',
      startUrl: '/studio',
      scope: '/',
      display: 'standalone',
      displayOverride: ['window-controls-overlay', 'standalone'],
      themeColor: '#123456',
      backgroundColor: '#fff',
      orientation: 'any',
      lang: 'en',
      dir: 'ltr',
      categories: ['productivity'],
      shortcuts: [{ name: 'New', shortName: 'N', url: '/studio/new', icons: [{ src: '/n.png', sizes: '96x96' }] }],
      shareTarget: {
        action: '/share',
        method: 'POST',
        params: { title: 'title', text: 'text', url: 'url', files: [{ name: 'files', accept: ['image/*', '.studio'] }] },
      },
      fileHandlers: [{ action: '/open', accept: { 'application/x-studio': ['.studio'] }, launchType: 'single-client' }],
      protocolHandlers: [{ protocol: 'web+Studio', url: '/open?url=%s' }],
      launchHandler: { clientMode: ['focus-existing', 'auto'] },
    });
    expect(result.ok).toBe(true);
    const json = unwrap(result);
    expect(json).toMatchObject({
      id: '/studio',
      short_name: 'St',
      start_url: '/studio',
      scope: '/',
      display_override: ['window-controls-overlay', 'standalone'],
      theme_color: '#123456',
      background_color: '#fff',
      icons: [{ src: '/icons/192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' }],
      shortcuts: [{ name: 'New', short_name: 'N', url: '/studio/new', icons: [{ src: '/n.png', sizes: '96x96' }] }],
      share_target: { action: '/share', method: 'POST', enctype: 'multipart/form-data', params: { files: [{ name: 'files', accept: ['image/*', '.studio'] }] } },
      file_handlers: [{ action: '/open', accept: { 'application/x-studio': ['.studio'] }, launch_type: 'single-client' }],
      protocol_handlers: [{ protocol: 'web+studio', url: '/open?url=%s' }],
      launch_handler: { client_mode: ['focus-existing', 'auto'] },
    });
    expect(JSON.parse(webAppManifestJson(json))).toEqual(json);
    expect(unwrap(defineWebAppManifest(base))).toEqual({ name: 'Studio', start_url: '/', scope: '/', icons: [{ src: '/icons/192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' }] });
    expect(shareTargetParamsOf({ action: '/s', params: { text: 't', files: [{ name: 'f', accept: [] }] } })).toEqual({ text: 't', files: 'f' });
  });

  it.each([
    [{ ...base, name: ' ' }, 'name'],
    [{ ...base, icons: [] }, 'icons'],
    [{ ...base, icons: [{ src: '/a.png', sizes: '192' }] }, 'icons[0].sizes'],
    [{ ...base, scope: '/app/', startUrl: '/other' }, 'startUrl'],
    [{ ...base, shortcuts: [{ name: 'x', url: 'https://evil.test/' }] }, 'shortcuts[0].url'],
    [{ ...base, shareTarget: { action: '/share', params: { files: [{ name: 'f', accept: ['*/*'] }] } } }, 'shareTarget.params.files'],
    [{ ...base, shareTarget: { action: '/share', method: 'GET', enctype: 'multipart/form-data', params: { text: 't' } } }, 'shareTarget.enctype'],
    [{ ...base, shareTarget: { action: '/share', params: {} } }, 'shareTarget.params'],
    [{ ...base, scope: '/app/', shareTarget: { action: '/share', params: { text: 't' } }, startUrl: '/app/' }, 'shareTarget.action'],
    [{ ...base, fileHandlers: [{ action: '/open', accept: {} }] }, 'fileHandlers[0].accept'],
    [{ ...base, fileHandlers: [{ action: '/open', accept: { studio: ['.s'] } }] }, 'fileHandlers[0].accept'],
    [{ ...base, fileHandlers: [{ action: '/open', accept: { 'a/b': ['s'] } }] }, 'fileHandlers[0].accept'],
    [{ ...base, scope: '/app/', startUrl: '/app/', fileHandlers: [{ action: '/open', accept: { 'a/b': ['.s'] } }] }, 'fileHandlers[0].action'],
    [{ ...base, protocolHandlers: [{ protocol: 'javascript', url: '/o?u=%s' }] }, 'protocolHandlers[0].protocol'],
    [{ ...base, protocolHandlers: [{ protocol: 'mailto', url: '/o' }] }, 'protocolHandlers[0].url'],
  ] as [WebAppManifestDeclaration, string][])('invalid declarations are SF-PWA-007 naming the field (%#)', (declaration, field) => {
    const result = defineWebAppManifest(declaration);
    expect(!result.ok && result.error.code).toBe('SF-PWA-007');
    expect(!result.ok && result.error.details['field']).toBe(field);
  });
});

describe('message protocol', () => {
  it('recognizes only known sf-pwa messages and narrows by type', () => {
    expect(isPwaMessage({ type: PWA_MESSAGE.getVersion, id: 'x' })).toBe(true);
    expect(isPwaMessage({ type: 'sf-pwa/unknown' })).toBe(false);
    expect(isPwaMessage(null)).toBe(false);
    expect(isMessageOf({ type: PWA_MESSAGE.warm }, PWA_MESSAGE.warm)).toBe(true);
    expect(isMessageOf({ type: PWA_MESSAGE.warm }, PWA_MESSAGE.replay)).toBe(false);
    expect(nextMessageId('a')).not.toBe(nextMessageId('a'));
  });
});

describe('pwa DI units', () => {
  const manifest: SfManifest = { format: 'sf-manifest/1', buildId: 'b', base: '/assets/', chunks: {} };

  it('wires updater (registers at init, first ports used), warm bridge, launch queue and mutation queue', async () => {
    const queue = new FakeLaunchQueue();
    const env = createFakePageEnv({ launchQueue: queue });
    const delivered: LaunchIntent[] = [];
    const injector = createInjector({
      units: [
        pwaPageEnvUnit(env),
        pwaOptionsUnit({ scriptUrl: '/sw.js', frameworkMajor: 1, scope: '/', type: 'module' }),
        reinitializePortUnit({ reinitialize: async () => ok() }),
        updatePromptUnit({ offer: async () => 'dismiss' }),
        pwaUpdaterUnit,
        manifestUnit(manifest),
        swWarmupUnit,
        launchIntentPortUnit({ deliver: (i) => delivered.push(i) }),
        launchQueueUnit,
        mutationQueueUnit,
      ],
    });
    const updater = unwrap(await injector.get(PwaUpdaterToken));
    expect(updater.registration).toBeDefined();
    expect(env.serviceWorker?.registerCalls).toHaveLength(1);
    const warmup = unwrap(await injector.get(SwWarmupToken));
    expect(warmup.available).toBe(false);
    env.serviceWorker!.controller = new FakeServiceWorker('activated');
    expect(warmup.available).toBe(true);
    expect(unwrap(await injector.get(LaunchQueueToken))).toEqual({ supported: true });
    queue.launch({ targetURL: 'https://app.test/doc/1' });
    expect(delivered).toEqual([{ kind: 'link', url: 'https://app.test/doc/1', source: 'launch-queue' }]);
    expect(unwrap(await injector.get(MutationQueueToken))).toBeDefined();
    await injector.dispose();
    expect(env.serviceWorker!.count()).toBe(0);
    expect(env.windowTarget.count()).toBe(0);
  });

  it('embedded / disabled: the updater resolves (unsupported) without registering; registration failure does not block', async () => {
    const env = createFakePageEnv({ embedded: true });
    const injector = createInjector({ units: [pwaPageEnvUnit(env), pwaOptionsUnit({ scriptUrl: '/sw.js', frameworkMajor: 1 }), pwaUpdaterUnit] });
    const updater = unwrap(await injector.get(PwaUpdaterToken));
    expect(updater.supported).toBe(false);
    expect(env.serviceWorker?.registerCalls).toEqual([]);

    const failing = createFakePageEnv();
    failing.serviceWorker!.failRegister = new Error('nope');
    const injector2 = createInjector({ units: [pwaPageEnvUnit(failing), pwaOptionsUnit({ scriptUrl: '/sw.js', frameworkMajor: 1 }), pwaUpdaterUnit] });
    expect((await injector2.get(PwaUpdaterToken)).ok).toBe(true);
  });
});
