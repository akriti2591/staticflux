import { describe, expect, it } from 'vitest';
import { fromUtf8, utf8 } from './codec.js';
import {
  comparePositions,
  createJournal,
  frameRecord,
  type JournalMode,
  LOG_PATH,
  MAX_RECORD_BYTES,
  parseFrames,
  segmentName,
  segmentNumber,
} from './journal.js';
import { createMemoryDirectory } from './memory-fs.js';
import type { StoreChange } from './types.js';

const texts = (records: readonly { payload: Uint8Array }[]): string[] => records.map((r) => fromUtf8(r.payload));

describe('framing', () => {
  it('frameRecord / parseFrames round-trip several records', () => {
    const bytes = new Uint8Array([...frameRecord(utf8('a')), ...frameRecord(utf8('bc'))]);
    const parsed = parseFrames(bytes);
    expect(parsed.torn).toBe(false);
    expect(parsed.validBytes).toBe(bytes.length);
    expect(parsed.records.map(fromUtf8)).toEqual(['a', 'bc']);
  });

  it('stops at a torn tail: a short header, a short payload or a CRC mismatch', () => {
    const good = frameRecord(utf8('good'));
    const next = frameRecord(utf8('next'));
    for (const tail of [next.subarray(0, 5), next.subarray(0, next.length - 1), Uint8Array.from(next, (b, i) => (i === 9 ? b ^ 1 : b)), new Uint8Array(8)]) {
      const parsed = parseFrames(new Uint8Array([...good, ...tail]));
      expect(parsed.torn).toBe(true);
      expect(parsed.records.map(fromUtf8)).toEqual(['good']);
      expect(parsed.validBytes).toBe(good.length);
    }
  });
});

describe('segment names and positions', () => {
  it('names segments with an 8-digit number and the peer', () => {
    expect(segmentName(12, 'p1')).toBe('00000012-p1.bin');
    expect(segmentNumber('00000012-p1.bin')).toBe(12);
    expect(segmentNumber('00000012-p1.bin.tmp-x')).toBeUndefined();
    expect(segmentNumber('notes.txt')).toBeUndefined();
  });

  it('comparePositions orders by segment, then index', () => {
    expect(comparePositions({ segment: 1, index: 9 }, { segment: 2, index: 0 })).toBeLessThan(0);
    expect(comparePositions({ segment: 2, index: 3 }, { segment: 2, index: 1 })).toBeGreaterThan(0);
    expect(comparePositions({ segment: 2, index: 1 }, { segment: 2, index: 1 })).toBe(0);
  });
});

describe.each(['append', 'segments'] as JournalMode[])('createJournal (%s mode)', (mode) => {
  const make = (fs = createMemoryDirectory(), peer = 'A', observer?: (c: StoreChange) => void) =>
    createJournal(fs.root, { stream: 'as_1', peer, mode, ...(observer === undefined ? {} : { observer }) });

  it('appends durably, replays in order after a reopen, and starts a fresh segment', async () => {
    const fs = createMemoryDirectory();
    const changes: StoreChange[] = [];
    const a = make(fs, 'A', (c) => changes.push(c));
    expect((await a.open(0)).ok && a.currentSegment).toBe(0);
    const first = await a.append([utf8('one'), utf8('two')]);
    expect(first.ok && first.value).toEqual([
      { segment: 0, index: 0 },
      { segment: 0, index: 1 },
    ]);
    await a.append([utf8('three')]);
    expect(await a.append([])).toEqual({ ok: true, value: [] });
    await a.close();
    expect(changes.every((c) => c.kind === 'log')).toBe(true);
    const b = make(fs, 'B');
    const replay = await b.open(0);
    if (!replay.ok) throw new Error(replay.error.code);
    expect(texts(replay.value.records)).toEqual(['one', 'two', 'three']);
    expect(replay.value.tornTails).toBe(0);
    expect(replay.value.nextSegment).toBeGreaterThan(replay.value.records.at(-1)?.position.segment ?? -1);
    const fresh = await b.append([utf8('four')]);
    expect(fresh.ok && fresh.value[0]?.segment).toBe(replay.value.nextSegment);
  });

  it('recovery keeps whole records and drops a torn tail', async () => {
    const fs = createMemoryDirectory();
    const a = make(fs);
    await a.open(0);
    await a.append([utf8('kept-1')]);
    await a.append([utf8('kept-2')]);
    await a.close();
    const torn = frameRecord(utf8('torn'));
    fs.write(`${[...LOG_PATH, 'as_1'].join('/')}/${segmentName(50, 'A')}`, torn.subarray(0, torn.length - 2));
    const replay = await make(fs, 'C').open(0);
    if (!replay.ok) throw new Error(replay.error.code);
    expect(texts(replay.value.records)).toEqual(['kept-1', 'kept-2']);
    expect(replay.value.tornTails).toBe(1);
    expect(replay.value.nextSegment).toBe(51);
  });

  it('roll moves later records to a new segment; open(from) skips and counts older ones; dropBefore deletes them', async () => {
    const fs = createMemoryDirectory();
    const j = make(fs);
    await j.open(0);
    await j.append([utf8('old')]);
    const rolled = await j.roll();
    if (!rolled.ok) throw new Error(rolled.error.code);
    await j.append([utf8('new')]);
    await j.close();
    const replay = await make(fs, 'B').open(rolled.value);
    if (!replay.ok) throw new Error(replay.error.code);
    expect(texts(replay.value.records)).toEqual(['new']);
    expect(replay.value.stale).toBe(1);
    const dropper = make(fs, 'B');
    await dropper.open(rolled.value);
    expect(await dropper.dropBefore(rolled.value)).toEqual({ ok: true, value: 1 });
    expect(fs.paths().some((p) => p.endsWith(segmentName(0, 'A')))).toBe(false);
  });

  it('validates usage: open first, record sizes, closed journals', async () => {
    const j = make();
    const early = await j.append([utf8('x')]);
    expect(early.ok ? '' : early.error.code).toBe('SF-BLOB-008');
    const earlyRoll = await j.roll();
    expect(earlyRoll.ok ? '' : earlyRoll.error.code).toBe('SF-BLOB-008');
    await j.open(0);
    const empty = await j.append([new Uint8Array(0)]);
    expect(empty.ok ? '' : empty.error.code).toBe('SF-BLOB-008');
    expect(MAX_RECORD_BYTES).toBe(64 * 1024 * 1024);
    await j.close();
    const closed = await j.append([utf8('x')]);
    expect(closed.ok ? '' : closed.error.code).toBe('SF-BLOB-013');
    const bad = createJournal(createMemoryDirectory().root, { stream: 'a/b', peer: 'A', mode });
    const opened = await bad.open(0);
    expect(opened.ok ? '' : opened.error.code).toBe('SF-BLOB-008');
  });

  it('honours abort on open and append', async () => {
    const fs = createMemoryDirectory();
    const j = make(fs);
    await j.open(0);
    await j.append([utf8('x')]);
    const controller = new AbortController();
    controller.abort();
    const appended = await j.append([utf8('y')], controller.signal);
    expect(appended.ok ? '' : appended.error.code).toBe('SF-BLOB-006');
    await j.close();
    const reopened = await make(fs, 'B').open(0, controller.signal);
    expect(reopened.ok ? '' : reopened.error.code).toBe('SF-BLOB-006');
  });
});

describe('createJournal append mode specifics', () => {
  it('needs sync access handles', async () => {
    const j = createJournal(createMemoryDirectory({ syncHandles: false }).root, { stream: 's', peer: 'A', mode: 'append' });
    await j.open(0);
    const appended = await j.append([utf8('x')]);
    expect(appended.ok ? '' : appended.error.code).toBe('SF-BLOB-009');
  });

  it('a failed write abandons the segment so a partial frame is never followed by good records', async () => {
    const fs = createMemoryDirectory();
    const j = createJournal(fs.root, { stream: 's', peer: 'A', mode: 'append' });
    await j.open(0);
    await j.append([utf8('first')]);
    fs.inject({ op: 'write', name: /\.bin$/, error: 'QuotaExceededError' });
    const failed = await j.append([utf8('second')]);
    expect(failed.ok ? '' : failed.error.code).toBe('SF-BLOB-001');
    const next = await j.append([utf8('third')]);
    expect(next.ok && next.value[0]?.segment).toBe(1);
    await j.close();
    const replay = await createJournal(fs.root, { stream: 's', peer: 'B', mode: 'append' }).open(0);
    expect(replay.ok && texts(replay.value.records)).toEqual(['first', 'third']);
  });

  it('dropBefore never deletes the open segment', async () => {
    const fs = createMemoryDirectory();
    const j = createJournal(fs.root, { stream: 's', peer: 'A', mode: 'append' });
    await j.open(0);
    await j.append([utf8('x')]);
    expect(await j.dropBefore(5)).toEqual({ ok: true, value: 0 });
    await j.close();
  });
});
