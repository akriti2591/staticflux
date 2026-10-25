import { AbortedError, err, ok } from '@staticflux/core';
import { afterEach, describe, expect, it } from 'vitest';
import { browserObjectUrls, browserPickFiles, createLibraryPanelModel, IMPORT_ACCEPT } from './panel-model.js';
import { fakeImageBytes, fileOf, panelModelFixture, signal, unwrap } from './test-helpers.js';

describe('createLibraryPanelModel', () => {
  it('imports files with a summary (imported, already there, failed) and lists rows by query', async () => {
    const { model } = await panelModelFixture();
    const summary = unwrap(
      await model.importFiles([fileOf('a.png', 'image/png', fakeImageBytes(4, 4)), fileOf('b.png', 'image/png', fakeImageBytes(4, 4)), fileOf('c.txt', 'text/plain', new Uint8Array(1)), fileOf('d.mp3', 'audio/mpeg', Uint8Array.of(1))]),
    );
    expect([summary.imported.length, summary.deduplicated.length, summary.failed.map((f) => [f.name, f.error.code])]).toEqual([2, 1, [['c.txt', 'IF-LIB-001']]]);
    expect(model.rows().map((r) => r.title).sort()).toEqual(['a', 'd']);
    model.setQuery({ filter: 'audio' });
    expect(model.rows().map((r) => r.title)).toEqual(['d']);
    model.setQuery({ filter: 'all', text: 'A' });
    expect(model.query()).toEqual({ filter: 'all', text: 'A' });
    expect(model.rows().map((r) => r.title)).toEqual(['a']);
    expect(model.pending()).toEqual([]);
  });

  it('picks with the host, toggles favorite, trashes, restores and places', async () => {
    const { model, placed } = await panelModelFixture([fileOf('hero.png', 'image/png', fakeImageBytes(8, 8))]);
    const summary = unwrap(await model.pickAndImport());
    const asset = summary.imported[0]?.asset ?? 'as_none';
    expect(unwrap(model.toggleFavorite(asset))).toBe(true);
    expect(unwrap(model.toggleFavorite(asset))).toBe(false);
    expect(model.toggleFavorite('as_none').ok).toBe(false);
    unwrap(model.rename(asset, 'Lamps'));
    expect(model.entry(asset)?.title).toBe('Lamps');
    unwrap(await model.place(asset));
    expect(placed.map((e) => e.asset)).toEqual([asset]);
    expect((await model.place('as_none')).ok).toBe(false);
    unwrap(model.trash([asset]));
    expect(model.rows()).toEqual([]);
    model.setQuery({ filter: 'trash' });
    expect(model.rows().map((r) => r.asset)).toEqual([asset]);
    unwrap(model.restore([asset]));
    expect(model.rows()).toEqual([]);
  });

  it('passes the picker’s cancel through and stops importing once the panel is gone', async () => {
    const fixture = await panelModelFixture();
    const cancelled = createLibraryPanelModel({ library: fixture.library, ingest: fixture.ingest, blobs: fixture.blobs, host: { pickFiles: async () => err(AbortedError()), place: async () => ok() }, signal });
    const picked = await cancelled.pickAndImport();
    expect(!picked.ok && picked.error.code).toBe('SF-CORE-002');
    fixture.lifetime.abort();
    const late = await fixture.model.importFiles([fileOf('a.png', 'image/png', fakeImageBytes(1, 1))]);
    expect(!late.ok && late.error.code).toBe('SF-CORE-002');
  });

  it('loads thumbnail URLs lazily once the rendition exists and revokes them with the panel', async () => {
    const { model, renditions, urls, lifetime } = await panelModelFixture();
    const summary = unwrap(await model.importFiles([fileOf('a.png', 'image/png', fakeImageBytes(300, 200))]));
    const asset = summary.imported[0]?.asset ?? 'as_none';
    expect(model.thumbnail('as_none')).toBeUndefined();
    unwrap(await renditions.idle(signal));
    expect(model.thumbnail(asset)).toBeUndefined(); // starts loading
    await new Promise((r) => setTimeout(r, 0));
    expect(model.thumbnail(asset)).toBe('blob:1');
    expect(urls.created).toEqual(['image/png']);
    lifetime.abort();
    expect(urls.revoked).toEqual(['blob:1']);
  });
});

describe('browser helpers', () => {
  afterEach(() => (document.body.innerHTML = ''));

  it('IMPORT_ACCEPT lists every importable type', () => {
    expect(IMPORT_ACCEPT.split(',')).toContain('image/png');
    expect(IMPORT_ACCEPT.split(',')).toContain('font/woff2');
  });

  it('browserObjectUrls creates and revokes object URLs', () => {
    const url = browserObjectUrls.create(Uint8Array.of(1), 'image/png');
    expect(url.startsWith('blob:')).toBe(true);
    browserObjectUrls.revoke(url);
  });

  it('browserPickFiles resolves with the chosen files, or AbortedError on cancel / abort', async () => {
    const inputs: HTMLInputElement[] = [];
    const doc = { createElement: () => {
      const input = document.createElement('input');
      input.click = () => undefined;
      inputs.push(input);
      return input;
    } } as unknown as Document;
    const picking = browserPickFiles(signal, doc);
    const [input] = inputs;
    expect([input?.type, input?.multiple, input?.accept]).toEqual(['file', true, IMPORT_ACCEPT]);
    const file = new File([Uint8Array.of(1)], 'a.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { value: [file] });
    input?.dispatchEvent(new Event('change'));
    expect(unwrap(await picking).map((f) => f.name)).toEqual(['a.png']);

    const cancelling = browserPickFiles(signal, doc);
    inputs[1]?.dispatchEvent(new Event('cancel'));
    const cancelled = await cancelling;
    expect(!cancelled.ok && cancelled.error.code).toBe('SF-CORE-002');

    const controller = new AbortController();
    const aborting = browserPickFiles(controller.signal, doc);
    controller.abort();
    expect((await aborting).ok).toBe(false);
    expect((await browserPickFiles(controller.signal, doc)).ok).toBe(false);
  });
});
