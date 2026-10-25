import { err, ok, type Result } from '@staticflux/core';
import { createMemoryDocumentStore, HeadConflictError } from '@staticflux/document/v2';
import { describe, expect, it } from 'vitest';
import { HOME_QUICK_ACTIONS, NewDesignCapability, OpenDesignCapability, UseTemplateCapability } from './capabilities.js';
import { HOME_INDEX_SCHEMA, type HomeEntry, type HomeIndex, withHomeIndex } from './index-record.js';
import { createHomeModel, ENTRY_HREFS, type HomeIndexSource, storeIndexSource } from './model.js';

const entry = (asset: string, kind: HomeEntry['kind'], editedAt = '2026-10-02T00:00:00.000Z'): HomeEntry => ({ asset, kind, title: `T ${asset}`, createdAt: '2026-10-01T00:00:00.000Z', editedAt, lens: 'layout' });
const INDEX: HomeIndex = { schema: HOME_INDEX_SCHEMA, entries: [entry('as_d', 'composition'), entry('as_t', 'template'), entry('as_i', 'image')] };
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function harness(source: HomeIndexSource = { read: async () => ok(INDEX) }) {
  const went: string[] = [];
  const controller = new AbortController();
  const model = createHomeModel({ source, host: { navigate: (href) => went.push(href) }, signal: controller.signal });
  return { model, went, controller };
}

describe('Home model', () => {
  it('reads the index once at start: loading → ready, with recents, files and templates', async () => {
    const { model } = harness();
    expect(model.state).toBe('loading');
    await settle();
    expect(model.state).toBe('ready');
    expect(model.recents().map((e) => e.asset)).toEqual(['as_d']);
    expect(model.templates().map((e) => e.asset)).toEqual(['as_t']);
    expect(model.files()).toHaveLength(3);
    expect(model.quickActions).toBe(HOME_QUICK_ACTIONS);
  });

  it('runs every action as a capability and navigates to the Studio href it resolves', async () => {
    const { model, went } = harness();
    await settle();
    expect(await model.newDesign()).toEqual(ok({ href: '/new' }));
    expect(await model.newDesign('slides')).toEqual(ok({ href: '/new?format=slides' }));
    expect(await model.open('as_d')).toEqual(ok({ href: '/s/as_d' }));
    expect(await model.useTemplate('as_t')).toEqual(ok({ href: '/new?template=as_t' }));
    const story = HOME_QUICK_ACTIONS.find((a) => a.id === 'new-story');
    expect(story).toBeDefined();
    expect(await model.runQuickAction(story as (typeof HOME_QUICK_ACTIONS)[number])).toEqual(ok({ href: '/new?format=story' }));
    expect(went).toEqual(['/new', '/new?format=slides', '/s/as_d', '/new?template=as_t', '/new?format=story']);
  });

  it('refuses designs and templates the workspace does not have (and navigates nowhere)', async () => {
    const { model, went } = harness();
    await settle();
    const open = await model.open('as_nope');
    expect(!open.ok && open.error.code).toBe('IF-HOME-002');
    const media = await model.open('as_i');
    expect(!media.ok && media.error.code).toBe('IF-HOME-002');
    const template = await model.useTemplate('as_d');
    expect(!template.ok && template.error.code).toBe('IF-HOME-003');
    const invalid = await model.newDesign('banner' as never);
    expect(!invalid.ok && invalid.error.code).toBe('SF-CAP-002');
    expect(went).toEqual([]);
  });

  it('is the same pipeline for agents: described with typed input and callable by an agent subject', async () => {
    const { model, went } = harness();
    await settle();
    const described = model.capabilities.describe().map((d) => [d.id, d.exposeToAgents]);
    expect(described).toEqual([
      [NewDesignCapability.id, true],
      [OpenDesignCapability.id, true],
      [UseTemplateCapability.id, true],
    ]);
    const run = await model.capabilities.invoke(OpenDesignCapability, { asset: 'as_d' }, { subject: 'agent' });
    expect(run).toEqual(ok({ href: '/s/as_d' }));
    expect(went).toEqual(['/s/as_d']);
  });

  it('maps entry kinds to hrefs as data (designs open, templates start, media have none)', async () => {
    const { model } = harness();
    await settle();
    expect(model.hrefOf(entry('as_d', 'composition'))).toBe('/s/as_d');
    expect(model.hrefOf(entry('as_t', 'template'))).toBe('/new?template=as_t');
    expect(model.hrefOf(entry('as_i', 'image'))).toBeUndefined();
    expect(Object.keys(ENTRY_HREFS).sort()).toEqual(['composition', 'template']);
  });

  it('fails visibly and recovers on refresh: loading → failed → loading → ready', async () => {
    let calls = 0;
    const source: HomeIndexSource = { read: async (): Promise<Result<HomeIndex>> => ((calls += 1) === 1 ? err(HeadConflictError({ message: 'disk' })) : ok(INDEX)) };
    const { model } = harness(source);
    await settle();
    expect(model.state).toBe('failed');
    expect(model.error?.message).toBe('disk');
    const again = await model.refresh();
    expect(again.ok).toBe(true);
    expect(model.state).toBe('ready');
    expect(model.error).toBeUndefined();
    expect(model.recents()).toHaveLength(1);
  });

  it('keeps the newest read when reads overlap, and stops with its signal', async () => {
    const pending: ((r: Result<HomeIndex>) => void)[] = [];
    const source: HomeIndexSource = { read: () => new Promise((resolve) => pending.push(resolve)) };
    const { model, controller } = harness(source);
    const second = model.refresh(); // still loading: no transition, a newer read
    pending[1]?.(ok(INDEX));
    await second;
    pending[0]?.(ok({ schema: HOME_INDEX_SCHEMA, entries: [] }));
    await settle();
    expect(model.recents()).toHaveLength(1);
    controller.abort();
    expect(model.state).toBe('disposed');
    expect((await model.open('as_d')).ok).toBe(false); // its registry is gone
    expect((await model.refresh()).ok).toBe(true); // a no-op after dispose
  });

  it('reads the index from the library head of the workspace store (no head: an empty workspace)', async () => {
    const store = createMemoryDocumentStore();
    const source = storeIndexSource(store);
    const signal = new AbortController().signal;
    expect(await source.read(signal)).toEqual(ok({ schema: HOME_INDEX_SCHEMA, entries: [] }));
    const head = withHomeIndex({ asset: 'library', generation: 1, engine: 'loro/1', treeSchema: 1, parts: {}, logFrom: 1, undoHorizon: 200 }, INDEX);
    expect((await store.writeHead('library', head, null, signal)).ok).toBe(true);
    const read = await source.read(signal);
    expect(read.ok && read.value.entries.map((e) => e.asset)).toEqual(['as_d', 'as_i', 'as_t']); // same edit time: by id
    store.failNext('readHead', HeadConflictError());
    const failed = await source.read(signal);
    expect(!failed.ok && failed.error.code).toBe('IF-HOME-001');
  });
});
