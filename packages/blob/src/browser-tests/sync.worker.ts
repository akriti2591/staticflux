/**
 * Dedicated worker half of `sync-worker.browser.ts`: the OPFS paths that need
 * sync access handles (append journal, large blobs), run with the harness's
 * `describe`/`it` inside the worker, results posted to the page.
 */
import { describe, expect, it, runRegistered } from '@staticflux/browser-test';
import { CHUNK_SIZE, createWorkspaceStore, detectOpfs, sha256 } from '../index.js';
import { freshOpfsDir, runFaultInjection, runTornLogTail } from './fixtures.js';

describe('OPFS in a dedicated worker', () => {
  it('sync access handles are available here', () => {
    expect(detectOpfs().syncAccessHandles).toBe(true);
  });

  it('a 9 MiB blob is chunked, written through sync handles, and reads back by range', async () => {
    const dir = await freshOpfsDir('worker-large');
    const ws = createWorkspaceStore(dir, { lockPrefix: `w-${crypto.randomUUID()}`, peer: 'W' });
    if (!ws.ok) throw ws.error;
    expect(ws.value.journalMode).toBe('append');
    const content = new Uint8Array(9 * 1024 * 1024);
    for (let i = 0; i < content.length; i += 4096) content[i] = (i / 4096) & 0xff;
    const ref = await ws.value.blobs.put(content, { mime: 'video/mp4' });
    if (!ref.ok) throw ref.error;
    expect(ref.value.chunked).toBe(true);
    const range = await ws.value.blobs.get(ref.value, { range: { start: CHUNK_SIZE - 4096, end: CHUNK_SIZE + 8192 } });
    expect(range.ok && (await sha256(range.value))).toBe(await sha256(content.slice(CHUNK_SIZE - 4096, CHUNK_SIZE + 8192)));
    const verified = await ws.value.blobs.verify(ref.value);
    expect(verified.ok && verified.value.objects).toBe(4);
  });
});

describe('Latest store fault injection with sync handles (append journal)', () => {
  for (const failAt of ['afterBlobs', 'beforeMove', 'afterHead'] as const) {
    it(`crash ${failAt}: no acknowledged commit lost, no temp head left`, async () => {
      const result = await runFaultInjection('append', failAt);
      expect(result.recovered).toBe(100);
      expect(result.tempsLeft).toBe(0);
    });
  }

  it('torn log tail: whole records kept, the torn one dropped', async () => {
    expect(await runTornLogTail('append')).toEqual({ tornTails: 1, goodKept: true, tornDropped: true });
  });
});

void runRegistered().then((result) => self.postMessage(result));
