// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { EXPORT_ABI_VERSION, loadExportModule } from './export-module.js';
import { exportBuilt, loadExportInNode } from './testing/fixtures.js';

const manifest = (artifacts: unknown[]) => async () => ({ ok: true, status: 200, json: async () => ({ format: 'sf-wasm-manifest/1', artifacts }) });

describe('export Wasm loader', () => {
  it('refuses a manifest without the export artifact, a failed fetch and a wrong ABI (IF-EXP-004)', async () => {
    const missing = await loadExportModule({ manifestUrl: 'https://x.test/m.json', fetch: manifest([{ crate: 'render', wasm: 'r.wasm', js: 'r.js' }]) });
    expect(!missing.ok && missing.error.code).toBe('IF-EXP-004');
    const http = await loadExportModule({ manifestUrl: 'https://x.test/m.json', fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
    expect(!http.ok && http.error.message).toContain('404');
    const abi = await loadExportModule({
      manifestUrl: 'https://x.test/m.json',
      fetch: manifest([{ crate: 'export', wasm: 'e.wasm', js: 'e.js' }]),
      importModule: async () => ({ default: async () => undefined, abi_version: () => 99 }),
    });
    expect(!abi.ok && abi.error.message).toContain('ABI 99');
    const thrown = await loadExportModule({ manifestUrl: 'https://x.test/m.json', fetch: manifest([{ crate: 'export', wasm: 'e.wasm', js: 'e.js' }]), importModule: async () => Promise.reject(new Error('boom')) });
    expect(!thrown.ok && thrown.error.message).toContain('boom');
  });

  it.skipIf(!exportBuilt)('loads the built module (ABI 1, scene IR 4) and writes an empty page', async () => {
    const wasm = await loadExportInNode();
    expect(wasm.abi_version()).toBe(EXPORT_ABI_VERSION);
    expect(wasm.ir_version()).toBe(4);
    const x = new wasm.Exporter();
    expect(x.bounds(new Uint32Array())).toHaveLength(0);
    expect(x.svg(0, 0, 10, 10, 10, 10, new Uint8Array(), 'Empty')).toContain('<title>Empty</title>');
    expect(() => x.svg(0, 0, 0, 10, 10, 10, new Uint8Array(), '')).toThrow(/region/);
    expect(() => x.plan(9, 0, 0, 1, 1, 2)).toThrow(/format/);
    expect(() => x.pdf_finish('')).toThrow(/no PDF page/);
    x.pdf_page(0, 0, 10, 10, 10, 10, Uint8Array.from([255, 255, 255, 255]));
    expect(new TextDecoder().decode(x.pdf_finish('t').subarray(0, 8))).toBe('%PDF-1.7');
    x.free();
  });
});
