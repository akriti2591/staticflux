import { box, createMemorySink, createScope, createTelemetry } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { createUrlDeclarationRegistry, defineUrlBinding, reserveParams } from './binding.js';
import { codec } from './codec.js';
import { createMemoryHistory } from './history.js';
import { createManualScheduler } from './scheduler.js';
import { boxAdapter, createUrlSync, URLSTATE_SOURCE } from './sync.js';

const Tab = defineUrlBinding({ key: 'tab', kind: 'view', codec: codec.enum(['comments', 'history']), owner: 'studio/doc-store' });
const Page = defineUrlBinding({ key: 'page', kind: 'view', codec: codec.int({ min: 1 }), owner: 'studio/list', default: 1, history: 'replace' });
const Workspace = defineUrlBinding({ key: 'workspace', kind: 'sticky', codec: codec.string(), owner: 'shell/workspace' });
const Debug = defineUrlBinding({ key: 'sf-debug', kind: 'sticky', codec: codec.flag(), owner: 'devtools' });
const Selection = defineUrlBinding({ key: 'selection', kind: 'hidden', codec: codec.string(), owner: 'studio/selection' });
const Tags = defineUrlBinding({ key: 'tags', kind: 'view', codec: codec.list(codec.string()), owner: 'studio/filter', history: 'replace' });

function setup(initial = '/studio/doc/42') {
  const history = createMemoryHistory(initial);
  const scheduler = createManualScheduler();
  const sync = createUrlSync({ history, scheduler });
  return { history, scheduler, sync };
}

describe('URL sync: store → URL', () => {
  it('reads the initial URL into the store', () => {
    const { sync } = setup('/studio/doc/42?tab=history&page=3');
    const tab = box<'comments' | 'history' | undefined>(undefined);
    const page = box<number | undefined>(undefined);
    expect(sync.bind(Tab, boxAdapter(tab)).ok).toBe(true);
    sync.bind(Page, boxAdapter(page));
    expect(tab.get()).toBe('history');
    expect(page.get()).toBe(3);
    expect(sync.inspect()).toEqual([
      { key: 'tab', kind: 'view', owner: 'studio/doc-store', value: 'history' },
      { key: 'page', kind: 'view', owner: 'studio/list', value: 3 },
    ]);
  });

  it('batches changes into one write per frame, push if any changed push binding', () => {
    const { history, scheduler, sync } = setup('/studio/doc/42?x=keep#h');
    const tab = box<'comments' | 'history' | undefined>(undefined);
    const page = box<number | undefined>(1);
    sync.bind(Tab, boxAdapter(tab));
    sync.bind(Page, boxAdapter(page));
    tab.set('comments');
    page.set(2);
    page.set(4);
    expect(sync.pending).toBe(true);
    expect(history.entries).toHaveLength(1);
    scheduler.flush();
    expect(history.entries).toEqual(['/studio/doc/42?x=keep#h', '/studio/doc/42?x=keep&tab=comments&page=4#h']);
    page.set(5); // replace-only change
    scheduler.flush();
    expect(history.entries).toHaveLength(2);
    expect(history.url).toBe('/studio/doc/42?x=keep&tab=comments&page=5#h');
  });

  it('never writes defaults and removes params reset to default', () => {
    const { history, scheduler, sync } = setup('/list?page=2');
    const page = box<number | undefined>(undefined);
    sync.bind(Page, boxAdapter(page));
    page.set(1);
    scheduler.flush();
    expect(history.url).toBe('/list');
    page.set(undefined);
    scheduler.flush();
    expect(history.url).toBe('/list');
  });

  it('flush() writes immediately and cancels the frame', () => {
    const { history, scheduler, sync } = setup('/');
    const tab = box<'comments' | 'history' | undefined>(undefined);
    sync.bind(Tab, boxAdapter(tab));
    tab.set('history');
    sync.flush();
    expect(history.url).toBe('/?tab=history');
    expect(scheduler.pending).toBe(0);
  });

  it('serializes flags and lists', () => {
    const { history, scheduler, sync } = setup('/');
    const debug = box<true | undefined>(undefined);
    const tags = box<readonly string[] | undefined>(undefined);
    sync.bind(Debug, boxAdapter(debug));
    sync.bind(Tags, boxAdapter(tags));
    debug.set(true);
    tags.set(['a b', 'c']);
    scheduler.flush();
    expect(history.url).toBe('/?sf-debug&tags=a+b%2Cc');
  });
});

describe('URL sync: URL → store', () => {
  it('applies back/forward and external navigations without writing back', () => {
    const { history, scheduler, sync } = setup('/doc');
    const tab = box<'comments' | 'history' | undefined>(undefined);
    sync.bind(Tab, boxAdapter(tab));
    tab.set('comments');
    scheduler.flush();
    tab.set('history');
    scheduler.flush();
    expect(history.entries).toEqual(['/doc', '/doc?tab=comments', '/doc?tab=history']);
    history.back();
    expect(tab.get()).toBe('comments');
    scheduler.flush();
    expect(history.entries).toHaveLength(3); // no write-back
    expect(history.index).toBe(1);
    history.push('/doc');
    expect(tab.get()).toBeUndefined();
  });

  it('a navigation cancels pending store writes (URL wins)', () => {
    const { history, scheduler, sync } = setup('/doc?tab=comments');
    const tab = box<'comments' | 'history' | undefined>(undefined);
    sync.bind(Tab, boxAdapter(tab));
    tab.set('history');
    history.push('/other?tab=comments');
    scheduler.flush();
    expect(tab.get()).toBe('comments');
    expect(history.url).toBe('/other?tab=comments');
  });

  it('invalid values fall back to the default and are removed from the URL', () => {
    const sink = createMemorySink();
    const telemetry = createTelemetry();
    telemetry.addSink(sink);
    const history = createMemoryHistory('/doc?tab=bogus&page=abc&keep=1');
    const scheduler = createManualScheduler();
    const sync = createUrlSync({ history, scheduler, telemetry });
    const tab = box<'comments' | 'history' | undefined>('comments');
    const page = box<number | undefined>(undefined);
    sync.bind(Tab, boxAdapter(tab));
    sync.bind(Page, boxAdapter(page));
    expect(tab.get()).toBeUndefined();
    expect(page.get()).toBe(1);
    scheduler.flush();
    expect(history.url).toBe('/doc?keep=1');
    expect(history.entries).toHaveLength(1); // replace
    expect(sink.records.filter((r) => r.type === 'event' && r.name === 'urlstate.invalid-param')).toHaveLength(2);
  });

  it('ignores its own writes (source=urlstate)', () => {
    const { history, sync } = setup('/');
    const tab = box<'comments' | 'history' | undefined>(undefined);
    sync.bind(Tab, boxAdapter(tab));
    history.replace('/?tab=history', { source: URLSTATE_SOURCE });
    expect(tab.get()).toBeUndefined();
  });
});

describe('URL sync: sticky and hidden', () => {
  it('carries sticky params across navigations that drop them', () => {
    const { history, scheduler, sync } = setup('/studio?workspace=expert');
    const ws = box<string | undefined>(undefined);
    sync.bind(Workspace, boxAdapter(ws));
    expect(ws.get()).toBe('expert');
    history.push('/settings'); // router navigation without the sticky param
    expect(ws.get()).toBe('expert'); // kept
    scheduler.flush();
    expect(history.url).toBe('/settings?workspace=expert');
    expect(history.entries).toEqual(['/studio?workspace=expert', '/settings?workspace=expert']); // replace, no extra entry
    history.push('/x?workspace=basic');
    expect(ws.get()).toBe('basic');
    ws.set(undefined); // explicit removal
    scheduler.flush();
    expect(history.url).toBe('/x');
  });

  it('decorate() adds sticky params to link targets', () => {
    const { sync } = setup('/?workspace=expert&sf-debug');
    const ws = box<string | undefined>(undefined);
    const debug = box<true | undefined>(undefined);
    const tab = box<'comments' | 'history' | undefined>(undefined);
    sync.bind(Workspace, boxAdapter(ws));
    sync.bind(Debug, boxAdapter(debug));
    sync.bind(Tab, boxAdapter(tab));
    tab.set('comments');
    expect(sync.decorate('/studio/doc/1#top')).toBe('/studio/doc/1?workspace=expert&sf-debug#top');
    expect(sync.decorate('/a?workspace=other')).toBe('/a?workspace=other&sf-debug');
    debug.set(undefined);
    expect(sync.decorate('/a')).toBe('/a?workspace=expert');
  });

  it('strips declared hidden and reserved keys found in the URL', () => {
    const history = createMemoryHistory('/doc?selection=abc&secret=1&tab=history');
    const scheduler = createManualScheduler();
    const registry = createUrlDeclarationRegistry([Selection, reserveParams('test', ['secret'])]);
    const sync = createUrlSync({ history, scheduler, registry });
    const tab = box<'comments' | 'history' | undefined>(undefined);
    sync.bind(Tab, boxAdapter(tab));
    scheduler.flush();
    expect(history.url).toBe('/doc?tab=history');
    history.push('/doc?selection=x');
    scheduler.flush();
    expect(history.url).toBe('/doc');
  });
});

describe('URL sync: binding rules and lifecycle', () => {
  it('rejects hidden bindings, double binds and collisions', () => {
    const { sync } = setup('/');
    const s = sync.bind(Selection, boxAdapter(box<string | undefined>(undefined)));
    expect(!s.ok && s.error.code).toBe('SF-URL-005');
    sync.bind(Tab, boxAdapter(box<'comments' | 'history' | undefined>(undefined)));
    const again = sync.bind(Tab, boxAdapter(box<'comments' | 'history' | undefined>(undefined)));
    expect(!again.ok && again.error.code).toBe('SF-URL-005');
    const other = defineUrlBinding({ key: 'tab', kind: 'view', codec: codec.enum(['history']), owner: 'billing/store' });
    const clash = sync.bind(other, boxAdapter(box<'history' | undefined>(undefined)));
    expect(!clash.ok && clash.error.code).toBe('SF-URL-005');
    const registryClash = createUrlSync({ history: createMemoryHistory('/'), scheduler: createManualScheduler(), registry: createUrlDeclarationRegistry([Tab]) });
    const r = registryClash.bind(other, boxAdapter(box<'history' | undefined>(undefined)));
    expect(!r.ok && r.error.code).toBe('SF-URL-002');
  });

  it('unbinds with its scope and stops syncing after dispose', async () => {
    const { history, scheduler, sync } = setup('/');
    const tab = box<'comments' | 'history' | undefined>(undefined);
    const scope = createScope('feature');
    const bound = sync.bind(Tab, boxAdapter(tab), scope);
    await scope.dispose();
    tab.set('history');
    scheduler.flush();
    expect(history.url).toBe('/');
    if (bound.ok) bound.value(); // idempotent
    expect(sync.bind(Tab, boxAdapter(tab)).ok).toBe(true);
    sync.dispose();
    tab.set('comments');
    scheduler.flush();
    expect(history.url).toBe('/');
    history.push('/?tab=history');
    expect(tab.get()).toBe('comments');
    expect(sync.bind(Page, boxAdapter(box<number | undefined>(undefined))).ok).toBe(false);
    sync.dispose();
  });

  it('emits a write event with keys and mode', () => {
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'verbose' });
    telemetry.addSink(sink);
    const history = createMemoryHistory('/');
    const scheduler = createManualScheduler();
    const sync = createUrlSync({ history, scheduler, telemetry });
    const tab = box<'comments' | 'history' | undefined>(undefined);
    sync.bind(Tab, boxAdapter(tab));
    tab.set('history');
    scheduler.flush();
    const event = sink.records.find((r) => r.type === 'event' && r.name === 'urlstate.write');
    expect(event?.type === 'event' && event.attrs).toEqual({ keys: ['tab'], mode: 'push' });
  });
});
