import { describe, expect, it } from 'vitest';
import { ASSET_RECORD_MIME, BLOB_ASSET_SCHEMA, type BlobAssetRecord, decodeBlobAssetRecord, encodeBlobAssetRecord } from './records.js';

const actor = { kind: 'human', id: 'guest-priya' };
const record: BlobAssetRecord = {
  schema: BLOB_ASSET_SCHEMA,
  id: 'as_01',
  kind: 'image',
  createdAt: '2026-10-25T09:00:00.000Z',
  createdBy: actor,
  content: { digest: `sha256:${'a'.repeat(64)}`, size: 10, mime: 'image/png' },
  media: { width: 4, height: 2 },
  provenance: { action: 'imported', actor, ingredients: [] },
};
const digest = `sha256:${'b'.repeat(64)}` as const;

describe('blob asset records', () => {
  it('encode canonically (sorted keys, RFC 8785) and round-trip', () => {
    const bytes = encodeBlobAssetRecord(record);
    expect(bytes.ok).toBe(true);
    const text = new TextDecoder().decode(bytes.ok ? bytes.value : new Uint8Array());
    expect(text.indexOf('"content"')).toBeLessThan(text.indexOf('"createdAt"'));
    const decoded = decodeBlobAssetRecord(bytes.ok ? bytes.value : new Uint8Array(), digest);
    expect(decoded.ok && decoded.value).toEqual(record);
    expect(ASSET_RECORD_MIME).toBe('application/vnd.instaflow.asset+json');
  });

  it('reject malformed bytes with IF-LIB-004 naming the digest', () => {
    const broken = decodeBlobAssetRecord(new TextEncoder().encode('{'), digest);
    expect(!broken.ok && [broken.error.code, broken.error.details?.['digest']]).toEqual(['IF-LIB-004', digest]);
    const wrong = decodeBlobAssetRecord(new TextEncoder().encode(JSON.stringify({ ...record, kind: 'composition' })), digest);
    expect(!wrong.ok && wrong.error.code).toBe('IF-LIB-004');
    const noContent = decodeBlobAssetRecord(new TextEncoder().encode(JSON.stringify({ ...record, content: { digest: 'x' } })), digest);
    expect(noContent.ok).toBe(false);
    expect(decodeBlobAssetRecord(new TextEncoder().encode('null'), digest).ok).toBe(false);
  });
});
