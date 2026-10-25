import type { CanonicalPart } from '@staticflux/document/v2';
import { describe, expect, it } from 'vitest';
import { MilestoneDataError } from './errors.js';
import {
  ASSET_SCHEMA,
  collectReferences,
  decodeAssetRecord,
  decodeMilestoneRecord,
  decodeSnapshotManifest,
  digestOfId,
  encodeRecord,
  isAssetId,
  isMilestoneId,
  MILESTONE_SCHEMA,
  type MilestoneRecord,
  milestoneIdOf,
  SNAPSHOT_SCHEMA,
  snapshotIdOf,
} from './records.js';
import { unwrap } from './test-helpers.js';

const hex = 'ab'.repeat(32);
const record: MilestoneRecord = {
  schema: MILESTONE_SCHEMA,
  asset: 'as_1',
  kind: 'named',
  name: 'Client v2',
  createdAt: '2026-10-25T00:00:00.000Z',
  createdBy: { kind: 'human', id: 'g1' },
  treeSchema: 1,
  parts: { root: { digest: `sha256:${hex}`, size: 10 } },
  references: [],
};
const bytesOf = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

describe('ids', () => {
  it('derive from digests and back', () => {
    expect(milestoneIdOf(`sha256:${hex}`)).toBe(`ms_${hex}`);
    expect(snapshotIdOf(`sha256:${hex}`)).toBe(`sn_${hex}`);
    expect(digestOfId(`ms_${hex}`)).toBe(`sha256:${hex}`);
    expect(isMilestoneId(`ms_${hex}`)).toBe(true);
    expect(isMilestoneId('ms_xyz')).toBe(false);
    expect(isMilestoneId(3)).toBe(false);
    expect(isAssetId('as_01JC')).toBe(true);
    expect(isAssetId('as_')).toBe(false);
    expect(isAssetId('ms_1')).toBe(false);
  });
});

describe('encode / decode', () => {
  it('round-trips records canonically (sorted keys)', () => {
    const bytes = unwrap(encodeRecord(record));
    expect(new TextDecoder().decode(bytes).startsWith('{"asset":"as_1","createdAt"')).toBe(true);
    expect(unwrap(decodeMilestoneRecord(bytes, `sha256:${hex}`))).toEqual(record);
    const manifest = { schema: SNAPSHOT_SCHEMA, asset: 'as_1', treeSchema: 1, parts: record.parts } as const;
    expect(unwrap(decodeSnapshotManifest(unwrap(encodeRecord(manifest)), `sha256:${hex}`))).toEqual(manifest);
    const asset = { schema: ASSET_SCHEMA, id: 'as_2', kind: 'composition', createdAt: 'x', createdBy: { kind: 'human', id: 'g' }, provenance: { action: 'derived', actor: { kind: 'human', id: 'g' }, ingredients: [] } } as const;
    expect(unwrap(decodeAssetRecord(unwrap(encodeRecord(asset)), `sha256:${hex}`))).toEqual(asset);
  });

  it('rejects malformed bytes with IF-VER-003', () => {
    const d = `sha256:${hex}` as const;
    for (const bad of [new TextEncoder().encode('{'), bytesOf([1]), bytesOf({ ...record, schema: 'x' }), bytesOf({ ...record, parts: { root: { digest: 1 } } })]) {
      expect(decodeMilestoneRecord(bad, d)).toMatchObject({ ok: false, error: { code: MilestoneDataError.code } });
    }
    expect(decodeSnapshotManifest(bytesOf({ schema: SNAPSHOT_SCHEMA }), d).ok).toBe(false);
    expect(decodeAssetRecord(bytesOf({ schema: ASSET_SCHEMA, id: 'nope', kind: 'composition' }), d).ok).toBe(false);
  });
});

describe('collectReferences', () => {
  it('counts every asset reference in the parts, keyed by asset and pin, sorted', () => {
    const part: CanonicalPart = {
      schema: 'instaflow.part/1',
      part: 'page:p',
      treeSchema: 1,
      nodes: [
        { id: 'a', kind: 'image', parent: null, order: 'a0', props: { source: { asset: { asset: 'as_b' } }, style: { fill: { image: { asset: 'as_a' }, fit: 'cover' } } } },
        { id: 'b', kind: 'image', parent: null, order: 'a1', props: { source: { asset: { asset: 'as_b' } }, list: { items: [{ asset: 'as_kit', at: 'latest' }] } } },
        { id: 'c', kind: 'shape', parent: null, order: 'a2', props: { misc: { asset: 'not-an-asset', n: 1 } } },
      ],
    };
    expect(collectReferences([part])).toEqual([
      { ref: { asset: 'as_a' }, where: 1 },
      { ref: { asset: 'as_b' }, where: 2 },
      { ref: { asset: 'as_kit', at: 'latest' }, where: 1 },
    ]);
    expect(collectReferences([])).toEqual([]);
  });
});
