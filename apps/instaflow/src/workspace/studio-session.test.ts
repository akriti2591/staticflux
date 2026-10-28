// @vitest-environment node
// C0 end to end without a browser: Studio over a persistent workspace store (the IndexedDB adapter's key layout on the
// memory AsyncStore) with the editor in in-process "workers", and Home's model reading the same store. New design → draw
// → the Home index lists it → "reload" (a fresh adapter and session) → the shape is there; Save as template → Use
// template copies it. Heavy: Wasm, fonts, several sessions (4 shared cores).
import { createMemoryBlobStore, type Digest } from '@staticflux/blob';
import { createScope, ok, type Result, type Scope } from '@staticflux/core';
import { createMemoryStore } from '@staticflux/storage';
import type { RasterImage } from '@staticflux/surface/image';
import { inMemorySpawner } from '@staticflux/worker';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { authoringBuilt, lendDom, manualTimers, person, scriptedTextInput, unwrap } from '../app/test-helpers.js';
import { COVER_EDGE } from '../export/cover.js';
import { hostExportWorker } from '../export/host.js';
import type { ExportRaster } from '../export/job.js';
import { createExportFixture, exportBuilt } from '../export/testing/test-helpers.js';
import { createHomeModel, storeIndexSource } from '../home/model.js';
import { readStudioIntent } from '../home/routes.js';
import { DEFAULT_SEQUENCING_SETTINGS } from '../sequencing/topology.js';
import { StudioIds } from '../spec/studio-ids.js';
import { dragEvents, inProcessWorkers, inputWriter, until } from '../workers/test-helpers.js';
import { documentStoreFromAsyncStore } from './document-store.js';
import { openStudioSession, type StudioSession } from './studio-session.js';

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe.skipIf(!authoringBuilt)('Studio session over the persistent workspace (C0)', () => {
  it('new design → draw → listed for Home → reopened after a reload → template → new design from it', { timeout: 120_000 }, async () => {
    const backing = createMemoryStore(); // what IndexedDB holds across reloads
    const dom = lendDom();
    let ids = 0;
    const urls: string[] = [];
    const left: string[] = [];
    const open = async (href: string, scope: Scope): Promise<StudioSession> => {
      const workers = inProcessWorkers();
      return unwrap(
        await openStudioSession({
          intent: readStudioIntent(href),
          documents: documentStoreFromAsyncStore(backing, { locks: null }),
          person,
          workers: { settings: DEFAULT_SEQUENCING_SETTINGS, spawn: () => workers.spawn() },
          textInput: { kind: 'hidden-textarea', create: () => ok(scriptedTextInput()) },
          handoff: () => ok({ canvas: { width: 0, height: 0 }, transfer: [] }),
          timers: manualTimers(),
          newAssetId: () => `as_test${(ids += 1)}` as never,
          replaceUrl: (h) => urls.push(h),
          navigate: (h) => left.push(h),
          index: { debounceMs: 0 },
          scope,
        }),
      );
    };
    const homeIndex = async () => {
      const read = await storeIndexSource(documentStoreFromAsyncStore(backing, { locks: null })).read(new AbortController().signal);
      return unwrap(read);
    };

    // ---------------------------------------------------------------- New design (story) and draw one shape
    const first = createScope('session-1');
    const session = await open('/new?format=story', first);
    const asset = session.plan.ref.asset;
    expect(asset).toBe('as_test1');
    expect(session.plan.ref.create).toEqual({ pages: 1, size: { width: 1080, height: 1920 } });
    expect(urls).toEqual(['/s/as_test1']);
    expect(session.app.library.entry(asset as never)?.kind).toBe('composition');
    const surface = dom.document.createElement('div');
    dom.document.body.append(surface);
    unwrap(await session.app.canvas.start(surface as never, first.signal));
    await until(() => session.app.tab?.page === 'p1', 'page open');
    unwrap(session.app.studio.selectTool(StudioIds.tool.shape));
    await until(() => session.app.view?.tool === StudioIds.tool.shape, 'shape tool');
    inputWriter(session.app.workers.input)(dragEvents([100, 100], [220, 200]));
    await until(() => session.app.tab?.view.selection.length === 1, 'shape drawn');
    const shape = session.app.tab?.view.selection[0] as string;

    // ---------------------------------------------------------------- the Home link: flush, index, leave
    await session.app.leave('/');
    expect(left).toEqual(['/']);
    const index = await homeIndex();
    const listed = index.entries.find((e) => e.asset === asset);
    expect(listed).toMatchObject({ kind: 'composition', title: 'Untitled design', format: { width: 1080, height: 1920 } });
    expect(Date.parse(listed?.editedAt ?? '') >= Date.parse(listed?.createdAt ?? '')).toBe(true);

    // Home's model (no engine) shows it and resolves its Studio href.
    const went: string[] = [];
    const home = createHomeModel({ source: storeIndexSource(documentStoreFromAsyncStore(backing, { locks: null })), host: { navigate: (h) => went.push(h) }, signal: first.signal });
    await settle();
    expect(home.recents().map((e) => e.asset)).toEqual([asset]);
    expect(await home.open(asset)).toEqual(ok({ href: `/s/${asset}` }));

    // ---------------------------------------------------------------- Save as template
    const saved = await session.app.saveAsTemplate('Story promo');
    expect(saved.ok).toBe(true);
    const template = (saved.ok ? (saved.value as { template: string }).template : '') as string;
    expect(session.app.library.entry(template as never)?.kind).toBe('template');
    await until(async () => (await homeIndex()).entries.some((e) => e.asset === template && e.kind === 'template'), 'template indexed');
    first.dispose();

    // ---------------------------------------------------------------- reload: reopen the design from its URL
    const second = createScope('session-2');
    const reopened = await open(`/s/${asset}`, second);
    expect(reopened.plan.created).toBe(false);
    expect(reopened.plan.ref).toEqual({ asset, title: 'Untitled design' });
    expect(reopened.plan.format).toEqual({ width: 1080, height: 1920 });
    const again = await reopened.app.inspect();
    expect(again.ok && again.value.elements.map((e) => [e.id, e.kind])).toEqual([[shape, 'shape']]);
    second.dispose();

    // ---------------------------------------------------------------- Use template: a new design with the shape
    const third = createScope('session-3');
    const fromTemplate = await open(`/new?template=${template}`, third);
    expect(fromTemplate.plan.created).toBe(true);
    expect(fromTemplate.plan.ref.title).toBe('Story promo');
    expect(fromTemplate.plan.ref.asset).not.toBe(asset);
    const copied = await fromTemplate.app.inspect();
    expect(copied.ok && copied.value.elements.map((e) => e.kind)).toEqual(['shape']);
    expect(fromTemplate.app.library.entry(fromTemplate.plan.ref.asset as never)?.kind).toBe('composition');
    third.dispose();

    // ---------------------------------------------------------------- refusals
    const fourth = createScope('session-4');
    const workers = inProcessWorkers();
    const base = {
      documents: documentStoreFromAsyncStore(backing, { locks: null }),
      person,
      workers: { settings: DEFAULT_SEQUENCING_SETTINGS, spawn: () => workers.spawn() },
      handoff: () => ok({ canvas: { width: 0, height: 0 }, transfer: [] }),
      scope: fourth,
    };
    const unknown = await openStudioSession({ ...base, intent: readStudioIntent('/s/as_missing') });
    expect(!unknown.ok && unknown.error.code).toBe('IF-HOME-002');
    const notTemplate = await openStudioSession({ ...base, intent: readStudioIntent(`/new?template=${asset}`) });
    expect(!notTemplate.ok && notTemplate.error.code).toBe('IF-HOME-003');
    fourth.dispose();
  });

  /** Straight RGBA of an 8-bit RGBA PNG without filters (what `encodePng` writes). */
  const decodePng = (png: Uint8Array): RasterImage => {
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    const idat: Uint8Array[] = [];
    for (let at = 8; at < png.length; ) {
      const length = view.getUint32(at);
      const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
      if (type === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length));
      at += 12 + length;
    }
    const raw = inflateSync(Buffer.concat(idat));
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      expect(raw[y * (width * 4 + 1)]).toBe(0);
      data.set(raw.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)), y * width * 4);
    }
    return { width, height, data };
  };
  /** Node has no WebGPU: a raster that paints the page white and a block that grows with the scene it was given. */
  const sceneRaster = (): ExportRaster => {
    let bytes = 0;
    return {
      id: 'scene-sized',
      maxRegionSize: 4096,
      apply: (batch) => ((bytes += batch.length), ok([])),
      renderRegion: async (region): Promise<Result<RasterImage>> => {
        const data = new Uint8Array(region.width * region.height * 4).fill(255);
        const ink = Math.min(region.width * region.height, Math.round(bytes / 8));
        for (let i = 0; i < ink; i++) data.set([40, 90, 230, 255], i * 4);
        return ok({ width: region.width, height: region.height, data });
      },
      dispose: () => undefined,
    };
  };

  it.skipIf(!exportBuilt)('#64: an edit, then leaving Studio, leaves a cover in the Home index (a small PNG of the first page, from the export worker); a later edit refreshes it', { timeout: 120_000 }, async () => {
    const backing = createMemoryStore();
    const blobs = createMemoryBlobStore();
    const dom = lendDom();
    const fixture = await createExportFixture();
    const env = { ...fixture.env, raster: async () => ok(sceneRaster()) };
    let spawned = 0;
    const scope = createScope('session-cover');
    const workers = inProcessWorkers();
    const session = unwrap(
      await openStudioSession({
        intent: readStudioIntent('/new?format=story'),
        documents: documentStoreFromAsyncStore(backing, { locks: null }),
        blobs,
        person,
        workers: { settings: DEFAULT_SEQUENCING_SETTINGS, spawn: () => workers.spawn(), assets: { manifest: 'memory://manifest', fonts: [] } },
        exporter: {
          spawn: () => {
            spawned += 1;
            return inMemorySpawner((port) => hostExportWorker({ port, env: { load: async () => ok(env) } }), { clone: false });
          },
        },
        textInput: { kind: 'hidden-textarea', create: () => ok(scriptedTextInput()) },
        handoff: () => ok({ canvas: { width: 0, height: 0 }, transfer: [] }),
        timers: manualTimers(),
        newAssetId: () => 'as_cover1' as never,
        replaceUrl: () => undefined,
        navigate: () => undefined,
        index: { debounceMs: 0 },
        cover: { timers: manualTimers(), leaveWaitMs: 60_000 },
        scope,
      }),
    );
    const asset = session.plan.ref.asset;
    const homeEntry = async () => {
      const read = unwrap(await storeIndexSource(documentStoreFromAsyncStore(backing, { locks: null })).read(new AbortController().signal));
      return read.entries.find((e) => e.asset === asset);
    };
    const coverOf = async (digest: string | undefined): Promise<RasterImage> => {
      expect(digest).toMatch(/^sha256:/);
      return decodePng(unwrap(await blobs.get(digest as Digest, { signal: scope.signal })));
    };
    const ink = (image: RasterImage): number => {
      let n = 0;
      for (let i = 0; i < image.data.length; i += 4) if (image.data[i] !== 255 || image.data[i + 1] !== 255 || image.data[i + 2] !== 255) n += 1;
      return n;
    };
    const surface = dom.document.createElement('div');
    dom.document.body.append(surface);
    unwrap(await session.app.canvas.start(surface as never, scope.signal));
    await until(() => session.app.tab?.page === 'p1', 'page open');
    const draw = async (from: [number, number], to: [number, number]): Promise<void> => {
      const before = session.app.tab?.view.selection[0];
      unwrap(session.app.studio.selectTool(StudioIds.tool.shape));
      await until(() => session.app.view?.tool === StudioIds.tool.shape, 'shape tool');
      inputWriter(session.app.workers.input)(dragEvents(from, to));
      await until(() => session.app.tab?.view.selection.length === 1 && session.app.tab.view.selection[0] !== before, 'shape drawn');
    };

    await draw([100, 100], [220, 200]);
    await session.app.leave('/');
    const first = await homeEntry();
    expect(first?.cover).toBeDefined();
    const image = await coverOf(first?.cover);
    expect([image.width, image.height]).toEqual([180, COVER_EDGE]); // 1080 × 1920 fitted in 320
    expect(ink(image)).toBeGreaterThan(0);
    expect(session.app.library.entry(asset as never)?.renditions.cover?.blob.mime).toBe('image/png');
    expect(spawned).toBeGreaterThan(0); // rendered in an export worker, never on main

    // Home's model (no engine) carries the cover to the card.
    const home = createHomeModel({ source: storeIndexSource(documentStoreFromAsyncStore(backing, { locks: null })), host: { navigate: () => undefined }, signal: scope.signal });
    await settle();
    await settle();
    expect(home.entry(asset)?.cover).toBe(first?.cover);

    // A later edit: leaving again refreshes the cover.
    await draw([400, 600], [700, 1000]);
    await session.app.leave('/');
    const second = await homeEntry();
    expect(second?.cover).toBeDefined();
    expect(second?.cover).not.toBe(first?.cover);
    expect(ink(await coverOf(second?.cover))).toBeGreaterThan(ink(image));
    await scope.dispose();
  });
});
