import { err, ok } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { utf8 } from './codec.js';
import { BlobInvalidInputError } from './errors.js';
import { tempNameFor } from './fs.js';
import { createHeadStore, decodeHead, encodeHead, type Head, HEADS_PATH } from './heads.js';
import { createMemoryLocks } from './locks.js';
import { createMemoryDirectory } from './memory-fs.js';
import type { StoreChange } from './types.js';

interface TestHead extends Head {
  readonly value: string;
}

function setup() {
  const fs = createMemoryDirectory();
  const locks = createMemoryLocks();
  const changes: StoreChange[] = [];
  const heads = createHeadStore(fs.root, { locks: locks.forTab('A'), lockPrefix: 'ws_1', observer: (c) => changes.push(c) });
  return { fs, locks, heads, changes };
}

describe('head codec', () => {
  it('encodes canonical JSON with a CRC and decodes it back', () => {
    const bytes = encodeHead({ generation: 3, b: [1], a: 'x' });
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith('{"a":"x","b":[1],"crc":')).toBe(true);
    expect(decodeHead(bytes)).toEqual({ status: 'ok', head: { generation: 3, b: [1], a: 'x' } });
    expect(decodeHead(encodeHead({ generation: 3, crc: 1 } as Head))).toEqual({ status: 'ok', head: { generation: 3 } });
  });

  it('detects torn heads: truncated, edited, or shaped wrong', () => {
    const bytes = encodeHead({ generation: 5, parts: { root: 'x' } });
    expect(decodeHead(bytes.subarray(0, bytes.length >> 1))).toEqual({ status: 'torn', reason: 'parse' });
    const edited = new TextDecoder().decode(bytes).replace('"generation":5', '"generation":6');
    expect(decodeHead(utf8(edited))).toEqual({ status: 'torn', reason: 'crc' });
    expect(decodeHead(utf8('[1]'))).toEqual({ status: 'torn', reason: 'shape' });
    expect(decodeHead(encodeHead({ generation: 0 }))).toEqual({ status: 'torn', reason: 'shape' });
  });
});

describe('createHeadStore', () => {
  it('cas creates (expected 0), then advances one generation at a time and rejects stale writers', async () => {
    const { heads, changes, fs } = setup();
    expect(await heads.read('as_1')).toEqual({ ok: true, value: undefined });
    const first = await heads.cas<TestHead>('as_1', 0, { value: 'a' });
    expect(first).toEqual({ ok: true, value: { value: 'a', generation: 1 } });
    expect((await heads.cas<TestHead>('as_1', 1, { value: 'b' })).ok).toBe(true);
    const stale = await heads.cas<TestHead>('as_1', 1, { value: 'c' });
    expect(stale.ok ? '' : stale.error.code).toBe('SF-BLOB-003');
    expect(stale.ok ? undefined : stale.error.details).toEqual({ name: 'as_1', expected: 1, current: 2 });
    expect(await heads.read<TestHead>('as_1')).toEqual({ ok: true, value: { value: 'b', generation: 2 } });
    expect(changes).toEqual([
      { kind: 'head', name: 'as_1' },
      { kind: 'head', name: 'as_1' },
    ]);
    expect(fs.paths()).toEqual(['heads/as_1.json']);
  });

  it('with the Web Lock, exactly 1 of 16 racing writers wins (S6: 16 of 16 without it)', async () => {
    const fs = createMemoryDirectory();
    const locks = createMemoryLocks();
    const tabs = Array.from({ length: 16 }, (_, i) => createHeadStore(fs.root, { locks: locks.forTab(`t${i}`), lockPrefix: 'ws' }));
    await tabs[0]?.cas('h', 0, { v: 0 });
    const results = await Promise.all(tabs.map((heads, i) => heads.cas('h', 1, { v: i })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.error.code === 'SF-BLOB-003')).toHaveLength(15);
    const final = await tabs[0]?.read('h');
    expect(final?.ok && final.value?.generation).toBe(2);
  });

  it('a crash before the move keeps the previous head intact', async () => {
    const { heads, fs } = setup();
    await heads.cas<TestHead>('as_1', 0, { value: 'kept' });
    const crashed = await heads.cas<TestHead>('as_1', 1, { value: 'lost' }, {
      beforeMove: () => {
        throw new Error('simulated crash');
      },
    });
    expect(crashed.ok).toBe(false);
    expect(await heads.read<TestHead>('as_1')).toEqual({ ok: true, value: { value: 'kept', generation: 1 } });
    expect(fs.paths()).toEqual(['heads/as_1.json']);
  });

  it('reads of a torn head are SF-BLOB-010 and CAS refuses to overwrite it', async () => {
    const { heads, fs } = setup();
    await heads.cas('as_1', 0, { value: 'x' });
    const bytes = fs.read('heads/as_1.json') ?? new Uint8Array();
    fs.write('heads/as_1.json', bytes.subarray(0, 10));
    const read = await heads.read('as_1');
    expect(read.ok ? '' : read.error.code).toBe('SF-BLOB-010');
    const cas = await heads.cas('as_1', 1, { value: 'y' });
    expect(cas.ok ? '' : cas.error.code).toBe('SF-BLOB-010');
  });

  it('update retries conflicts, stops on fn errors, and gives up after `attempts`', async () => {
    const { heads, locks, fs } = setup();
    const other = createHeadStore(fs.root, { locks: locks.forTab('B'), lockPrefix: 'ws_1' });
    await heads.cas<TestHead>('h', 0, { value: '0' });
    let calls = 0;
    const updated = await heads.update<TestHead>('h', (current) => {
      calls += 1;
      if (calls === 1) void other.cas<TestHead>('h', 1, { value: 'other' });
      return ok({ value: `${current?.value ?? ''}+mine` });
    });
    expect(updated.ok && updated.value.generation).toBeGreaterThanOrEqual(2);
    const stop = await heads.update<TestHead>('h', () => err(BlobInvalidInputError()));
    expect(stop.ok ? '' : stop.error.code).toBe('SF-BLOB-008');
    let n = 0;
    const always = await heads.update<TestHead>(
      'h',
      (current) => {
        n += 1;
        fs.write('heads/h.json', encodeHead({ value: 'race', generation: (current?.generation ?? 0) + 10 + n }));
        return ok({ value: 'never' });
      },
      { attempts: 2 },
    );
    expect(always.ok ? '' : always.error.code).toBe('SF-BLOB-003');
    expect(n).toBe(2);
  });

  it('replicate writes a head as is only when newer (or replacing a torn head)', async () => {
    const { heads, fs } = setup();
    expect(await heads.replicate('h', { generation: 5, v: 'a' })).toEqual({ ok: true, value: true });
    expect(await heads.replicate('h', { generation: 5, v: 'b' })).toEqual({ ok: true, value: false });
    expect(await heads.replicate('h', { generation: 4, v: 'c' })).toEqual({ ok: true, value: false });
    fs.write('heads/h.json', utf8('{"broken'));
    expect(await heads.replicate('h', { generation: 6, v: 'd' })).toEqual({ ok: true, value: true });
    expect(await heads.read('h')).toEqual({ ok: true, value: { generation: 6, v: 'd' } });
  });

  it('list skips temps; recover removes temps under each head lock', async () => {
    const { heads, fs, locks } = setup();
    expect(await heads.list()).toEqual({ ok: true, value: [] });
    expect(await heads.recover()).toEqual({ ok: true, value: { tempsRemoved: 0 } });
    await heads.cas('b', 0, {});
    await heads.cas('a', 0, {});
    let dir = fs.root;
    for (const part of HEADS_PATH) dir = await dir.getDirectoryHandle(part);
    await dir.getFileHandle(tempNameFor('a.json'), { create: true });
    await dir.getFileHandle(tempNameFor('a.json'), { create: true });
    await dir.getFileHandle(tempNameFor('b.json'), { create: true });
    expect(await heads.list()).toEqual({ ok: true, value: ['a', 'b'] });
    const seen: string[] = [];
    const watching = createHeadStore(fs.root, {
      locks: {
        request: (name, options, cb) => {
          seen.push(name);
          return locks.forTab('C').request(name, options, cb);
        },
      },
      lockPrefix: 'ws_1',
    });
    expect(await watching.recover()).toEqual({ ok: true, value: { tempsRemoved: 3 } });
    expect(seen.sort()).toEqual(['ws_1:head:a', 'ws_1:head:b']);
    expect(fs.paths()).toEqual(['heads/a.json', 'heads/b.json']);
  });

  it('rejects invalid head names', async () => {
    const { heads } = setup();
    const read = await heads.read('a/b');
    expect(read.ok ? '' : read.error.code).toBe('SF-BLOB-008');
  });
});
