// @vitest-environment node
import { createScope, err, ok, type Result } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { RenditionError } from '../library/errors.js';
import { libraryFixture, nextAssetId, unwrap } from '../library/test-helpers.js';
import { COVER_EDGE, type CoverImage } from '../export/cover.js';
import { createDesignCover } from './design-cover.js';

/** Manual timers: `run()` fires what is due. */
function timers() {
  const due = new Map<number, () => void>();
  let id = 0;
  return {
    set: (fn: () => void) => (due.set((id += 1), fn), id),
    clear: (h: unknown) => void due.delete(h as number),
    run: () => {
      const fns = [...due.values()];
      due.clear();
      for (const fn of fns) fn();
    },
    get pending() {
      return due.size;
    },
  };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function setup(options: { cover?: boolean } = {}) {
  const f = await libraryFixture();
  const asset = nextAssetId();
  unwrap(f.library.add({ asset, kind: 'composition', title: 'Flyer', createdAt: '2026-10-25T09:00:00.000Z' }));
  let version = 0;
  const calls: AbortSignal[] = [];
  let gate: Promise<void> | undefined;
  const render = async (signal: AbortSignal): Promise<Result<CoverImage>> => {
    calls.push(signal);
    if (gate !== undefined) await gate;
    version += 1;
    return ok({ bytes: new Uint8Array([137, 80, 78, 71, version]), mime: 'image/png', edge: COVER_EDGE, source: `snapshot-${version}`, renderer: 'test' });
  };
  if (options.cover === true) {
    const blob = unwrap(await f.blobs.put(new Uint8Array([1]), { mime: 'image/png' }));
    unwrap(f.library.setRendition(asset, 'cover', { blob, params: { renderer: 'test', edge: COVER_EDGE, source: 'old' } }));
  }
  const t = timers();
  const scope = createScope('cover-test');
  const problems: string[] = [];
  const cover = createDesignCover({ asset, render, blobs: f.blobs, library: f.library, scope, timers: t, onProblem: (e) => problems.push(e.code) });
  return { f, asset, cover, t, calls, scope, problems, hold: () => {
    let release = (): void => undefined;
    gate = new Promise((r) => (release = r));
    return () => {
      gate = undefined;
      release();
    };
  } };
}

describe('createDesignCover (#64: the design card preview)', () => {
  it('a design without a cover gets one soon after Studio opens it; nothing renders on the main thread here, only the port', async () => {
    const { f, asset, t, calls } = await setup();
    expect(t.pending).toBe(1);
    t.run();
    await settle();
    await settle();
    expect(calls).toHaveLength(1);
    const cover = f.library.entry(asset)?.renditions.cover;
    expect(cover?.blob.mime).toBe('image/png');
    expect(cover?.params).toEqual({ renderer: 'test', edge: COVER_EDGE, source: 'snapshot-1' });
    const bytes = unwrap(await f.blobs.get(cover!.blob.digest, { signal: new AbortController().signal }));
    expect([...bytes]).toEqual([137, 80, 78, 71, 1]);
  });

  it('a design that already has a cover is left alone until it is edited; an edit renders after the idle delay; edits coalesce', async () => {
    const { f, asset, cover, t, calls } = await setup({ cover: true });
    expect(t.pending).toBe(0);
    const before = f.library.entry(asset)?.renditions.cover?.blob.digest;
    cover.touch();
    cover.touch();
    cover.touch();
    expect(calls).toHaveLength(0);
    t.run();
    await settle();
    await settle();
    expect(calls).toHaveLength(1);
    const after = f.library.entry(asset)?.renditions.cover?.blob.digest;
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    expect(cover.renders).toBe(1);
  });

  it('flush renders a pending cover now (leaving Studio) and resolves once it is in the library', async () => {
    const { f, asset, cover, t, calls } = await setup({ cover: true });
    cover.touch();
    unwrap(await cover.flush());
    expect(calls).toHaveLength(1);
    expect(t.pending).toBe(0);
    expect(f.library.entry(asset)?.renditions.cover?.params.source).toBe('snapshot-1');
    unwrap(await cover.flush()); // nothing pending: no render
    expect(calls).toHaveLength(1);
  });

  it('an edit during a render renders again after it; flush waits for both', async () => {
    const { f, asset, cover, calls, hold } = await setup({ cover: true });
    const release = hold();
    cover.touch();
    const flushing = cover.flush();
    await settle();
    cover.touch(); // while the first render runs
    release();
    unwrap(await flushing);
    unwrap(await cover.flush());
    expect(calls).toHaveLength(2);
    expect(f.library.entry(asset)?.renditions.cover?.params.source).toBe('snapshot-2');
  });

  it('flush never holds leaving Studio past its wait: a slow render is left running', async () => {
    const { cover, hold } = await setup({ cover: true });
    const release = hold();
    cover.touch();
    const started = Date.now();
    unwrap(await cover.flush(undefined, 20));
    expect(Date.now() - started).toBeLessThan(1000);
    release();
  });

  it('a failed render is reported, never thrown, and the next edit tries again', async () => {
    const f = await libraryFixture();
    const asset = nextAssetId();
    unwrap(f.library.add({ asset, kind: 'composition', title: 'Flyer', createdAt: '2026-10-25T09:00:00.000Z' }));
    const problems: string[] = [];
    let fail = true;
    const cover = createDesignCover({
      asset,
      render: async () => (fail ? err(RenditionError({ details: { asset } })) : ok({ bytes: new Uint8Array([1, 2]), mime: 'image/png', edge: COVER_EDGE, source: 's', renderer: 'test' })),
      blobs: f.blobs,
      library: f.library,
      scope: createScope('cover-fail'),
      timers: timers(),
      onProblem: (e) => problems.push(e.code),
    });
    const first = await cover.flush();
    expect(first.ok).toBe(false);
    expect(problems).toHaveLength(1);
    expect(f.library.entry(asset)?.renditions.cover).toBeUndefined();
    fail = false;
    cover.touch();
    unwrap(await cover.flush());
    expect(f.library.entry(asset)?.renditions.cover).toBeDefined();
  });

  it('disposing the scope cancels the pending render and aborts a running one', async () => {
    const { cover, t, calls, scope, hold } = await setup({ cover: true });
    const release = hold();
    cover.touch();
    void cover.flush();
    await settle();
    expect(calls).toHaveLength(1);
    await scope.dispose();
    expect(calls[0]?.aborted).toBe(true);
    release();
    cover.touch();
    expect(t.pending).toBe(0);
  });
});
