import { describe, expect, it } from 'vitest';
import { type CommitRecord, commitRecordSize, decodeCommitRecord, encodeCommitRecord } from './commit-record.js';

const record: CommitRecord = {
  peer: '42',
  meta: { actor: { kind: 'agent', id: 'a1', displayName: 'Helper' }, label: 'Move to page 2', txn: 't1', via: 'chat' },
  updates: { 'page:p1': new Uint8Array([1, 2, 3]), 'page:p2': new Uint8Array([9]) },
  inverse: { 'page:p1': [{ op: 'delete', node: 'n1' }], 'page:p2': [] },
};

describe('commit records', () => {
  it('round-trips several parts in one record', () => {
    const bytes = encodeCommitRecord(record);
    const decoded = decodeCommitRecord(bytes, 7);
    expect(decoded.ok && decoded.value).toEqual({ ...record, seq: 7 });
    const noSeq = decodeCommitRecord(bytes);
    expect(noSeq.ok && 'seq' in noSeq.value).toBe(false);
    expect(commitRecordSize(record)).toBe(4);
  });

  it('round-trips per-part after-frontiers when present', () => {
    const withAfter: CommitRecord = { ...record, after: { 'page:p1': 'f1' as never, 'page:p2': 'f2' as never } };
    const decoded = decodeCommitRecord(encodeCommitRecord(withAfter), 3);
    expect(decoded.ok && decoded.value.after).toEqual({ 'page:p1': 'f1', 'page:p2': 'f2' });
    const without = decodeCommitRecord(encodeCommitRecord(record));
    expect(without.ok && 'after' in without.value).toBe(false);
  });

  it('rejects foreign, truncated and malformed bytes', () => {
    const bytes = encodeCommitRecord(record);
    for (const bad of [new Uint8Array([1, 2]), bytes.slice(0, 10), bytes.slice(0, bytes.length - 1)]) {
      const r = decodeCommitRecord(bad);
      expect(r.ok ? '' : r.error.code).toBe('SF-DOC-006');
    }
    const garbled = bytes.slice();
    garbled[9] = 0x7b; // corrupt the JSON header
    garbled[10] = 0x7b;
    expect(decodeCommitRecord(garbled).ok).toBe(false);
    const shape = encodeCommitRecord({ ...record, peer: 5 as never });
    expect(decodeCommitRecord(shape).ok).toBe(false);
  });
});
