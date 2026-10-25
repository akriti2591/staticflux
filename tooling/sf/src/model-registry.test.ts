// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyModel, findModelReferences, type ModelEntry, parseModelRegistry, referenceNeedles } from './model-registry.js';

const entry = (over: Partial<ModelEntry> = {}): ModelEntry => ({
  id: 'm',
  name: 'Model',
  sourceUrl: 'https://example.test/m',
  license: 'MIT',
  licenseText: 'MIT License …',
  commercialUse: true,
  ...over,
});

describe('parseModelRegistry', () => {
  it('accepts a valid registry', () => {
    const r = parseModelRegistry({ format: 'sf-model-registry/1', models: [entry({ files: [{ url: 'https://x/a.onnx', sha256: 'a'.repeat(64) }] })] });
    expect(r.ok && r.value.models[0]?.id).toBe('m');
  });

  it('rejects the wrong shape and reports every problem at once', () => {
    expect(parseModelRegistry(null).ok).toBe(false);
    expect(parseModelRegistry({ format: 'x', models: [] }).ok).toBe(false);
    expect(parseModelRegistry({ format: 'sf-model-registry/1' }).ok).toBe(false);
    const bad = parseModelRegistry({
      format: 'sf-model-registry/1',
      models: [
        { ...entry(), licenseText: '' },
        { ...entry({ id: 'n' }), commercialUse: 'yes' },
        entry({ id: 'o', references: [1 as unknown as string] }),
        entry({ id: 'p', files: [{ url: 'u', sha256: 'XYZ' }] }),
        entry({ id: 'q', files: 'nope' as unknown as [] }),
        entry({ id: 'r', files: [{} as { url: string }] }),
        entry({ id: 'r' }),
        7,
      ],
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.code).toBe('SF-TOOL-004');
      for (const part of ['licenseText', 'commercialUse', 'references', 'sha256', 'files must be an array', 'files[0].url', 'duplicate model id "r"', 'models[7] must be an object']) {
        expect(bad.error.message).toContain(part);
      }
    }
  });
});

describe('classifyModel', () => {
  it('allows a permissive license with commercial use', () => {
    expect(classifyModel(entry()).verdict).toBe('allowed');
  });

  it('denies when commercial use is not permitted, even with a permissive license', () => {
    expect(classifyModel(entry({ commercialUse: false }))).toEqual({ verdict: 'denied', reason: 'commercial use not permitted' });
    expect(classifyModel(entry({ commercialUse: false, license: 'CC-BY-NC-4.0' })).reason).toContain('Creative Commons NC');
  });

  it('follows the license when commercial use is claimed', () => {
    expect(classifyModel(entry({ license: 'AGPL-3.0' })).verdict).toBe('denied');
    expect(classifyModel(entry({ license: 'LicenseRef-Custom' })).verdict).toBe('unknown');
  });
});

describe('references', () => {
  it('derives needles from id, references, file URLs and file names (lowercased, unique)', () => {
    const needles = referenceNeedles(entry({ id: 'RM', references: ['rm', 'Extra'], files: [{ url: 'https://h/x/Model.ONNX?dl=1' }, { url: 'https://h/dir/' }] }));
    expect(needles).toEqual(['rm', 'extra', 'https://h/x/model.onnx?dl=1', 'model.onnx', 'https://h/dir/']);
  });

  it('finds which files reference which model', () => {
    const models = [entry({ id: 'bria-rmbg-1.4', references: ['RMBG-1.4'] }), entry({ id: 'birefnet-lite', files: [{ url: 'https://g/r/BiRefNet-lite.onnx' }] })];
    const refs = findModelReferences(models, [
      { path: 'b.ts', text: "load('briaai/rmbg-1.4')" },
      { path: 'a.ts', text: "fetch('/models/BiRefNet-lite.onnx'); // and RMBG-1.4" },
      { path: 'c.ts', text: 'sts-rmbg-modnet' },
    ]);
    expect(refs.get('bria-rmbg-1.4')).toEqual(['a.ts', 'b.ts']);
    expect(refs.get('birefnet-lite')).toEqual(['a.ts']);
  });
});

describe('the Instaflow registry (seeded from S9)', () => {
  const json = JSON.parse(readFileSync(new URL('../../../apps/instaflow/models/registry.json', import.meta.url), 'utf8')) as unknown;
  const registry = parseModelRegistry(json);

  it('is valid', () => {
    expect(registry.ok).toBe(true);
  });

  it('allows MediaPipe selfie (Apache-2.0) and BiRefNet (MIT); denies RMBG as non-commercial', () => {
    if (!registry.ok) throw new Error('invalid registry');
    const byId = new Map(registry.value.models.map((m) => [m.id, classifyModel(m)]));
    expect(byId.get('mediapipe-selfie-segmenter')?.verdict).toBe('allowed');
    expect(byId.get('birefnet-lite')?.verdict).toBe('allowed');
    expect(byId.get('birefnet-portrait')?.verdict).toBe('allowed');
    expect(byId.get('bria-rmbg-1.4')?.verdict).toBe('denied');
    expect(byId.get('bria-rmbg-2.0')?.verdict).toBe('denied');
    expect(byId.get('bria-rmbg-1.4')?.reason).toContain('non-commercial');
  });
});
