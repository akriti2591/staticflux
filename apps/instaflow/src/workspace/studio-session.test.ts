// @vitest-environment node
// C0 end to end without a browser: Studio over a persistent workspace store (the IndexedDB adapter's key layout on the
// memory AsyncStore) with the editor in in-process "workers", and Home's model reading the same store. New design → draw
// → the Home index lists it → "reload" (a fresh adapter and session) → the shape is there; Save as template → Use
// template copies it. Heavy: Wasm, fonts, several sessions (4 shared cores).
import { createScope, ok, type Scope } from '@staticflux/core';
import { createMemoryStore } from '@staticflux/storage';
import { describe, expect, it } from 'vitest';
import { authoringBuilt, lendDom, manualTimers, person, scriptedTextInput, unwrap } from '../app/test-helpers.js';
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
});
