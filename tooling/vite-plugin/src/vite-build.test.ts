// @vitest-environment node
// Integration: a real `vite build` (Vite 8 / Rolldown) of a tiny fixture in a temp dir.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chunk, defineBootPlan, parseManifest, type SfManifest } from '@staticflux/loader';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { staticflux } from './plugin.js';

let root = '';

const files: Record<string, string> = {
  'index.html': '<!doctype html><html><head><title>t</title></head><body><script type="module" src="/src/main.js"></script></body></html>',
  'src/main.js': "import { boot } from './shell.js';\nboot();\nexport const lazy = () => import('virtual:sf-chunks').then((m) => m.importChunk('feature:studio'));\n",
  'src/shell.js': "import { util } from './util.js';\nexport function boot() { return util('shell'); }\n",
  'src/util.js': 'export function util(x) { return `[${x}]`; }\n',
  'src/shell.css': 'body { margin: 0 }\n',
  'src/features/studio.js': "import { util } from '../util.js';\nimport './studio.css';\nexport function mount() { return util('studio'); }\n",
  'src/features/studio.css': '.studio { color: red }\n',
  'src/features/compact.js': "export function mount() { return 'compact'; }\n",
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'sf-vite-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
});

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

describe('vite build (integration)', () => {
  it('emits named logical chunks, sf-manifest.json, preloads, precache and preload tags', async () => {
    const { build } = await import('vite');
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      build: { outDir: join(root, 'dist'), emptyOutDir: true, minify: false },
      plugins: [
        staticflux({
          chunks: [
            chunk('lib:shell', { entry: 'src/shell.js', tier: 'critical', load: 'eager', reason: 'shell frame' }),
            chunk('feature:studio', { entry: 'src/features/studio.js', profiles: ['web:expanded'], budget: { category: 'feature' } }),
            chunk('feature:studio-compact', { entry: 'src/features/compact.js', profiles: ['web:compact'] }),
          ],
          profiles: [
            { key: 'web:expanded', hostMode: 'web', formFactor: 'expanded' },
            { key: 'web:compact', hostMode: 'web', formFactor: 'compact' },
          ],
          bootPlans: [
            defineBootPlan({ id: 'desktop', match: { formFactors: ['expanded'] }, critical: ['lib:shell'], preload: ['feature:studio'] }),
            defineBootPlan({ id: 'fallback', critical: ['lib:shell'], preload: ['feature:studio-compact'] }),
          ],
          isolation: 'required',
          sri: true,
        }),
      ],
    });
    const dist = join(root, 'dist');
    const manifest = JSON.parse(readFileSync(join(dist, 'sf-manifest.json'), 'utf8')) as SfManifest;
    expect(parseManifest(manifest).ok).toBe(true);
    const studio = manifest.chunks['feature:studio'];
    expect(studio?.files[0]).toMatch(/^assets\/feature\.studio-[\w-]+\.js$/);
    expect(studio?.css.some((c) => c.endsWith('.css'))).toBe(true);
    expect(manifest.chunks['lib:shell']?.files[0]).toMatch(/^assets\/lib\.shell-[\w-]+\.js$/);
    expect(manifest.chunks['feature:studio-compact']?.files[0]).toMatch(/^assets\/feature\.studio-compact-/);
    for (const c of Object.values(manifest.chunks)) {
      for (const f of c.files) expect(existsSync(join(dist, f))).toBe(true);
      expect(c.sizeKb).toBeGreaterThan(0);
      expect(Object.keys(c.integrity ?? {})).toEqual(c.files);
    }
    const preloads = JSON.parse(readFileSync(join(dist, 'sf-preloads.json'), 'utf8')) as Record<string, { plan: string; modulepreload: string[] }>;
    expect(preloads['web:expanded']?.plan).toBe('desktop');
    expect(preloads['web:compact']?.plan).toBe('fallback');
    expect(preloads['web:compact']?.modulepreload).not.toContain(`/${studio?.files[0] ?? ''}`);
    expect(preloads['web:compact']?.modulepreload.some((u) => u.includes('feature.studio-compact-'))).toBe(true);
    expect(existsSync(join(dist, 'sf-precache.json'))).toBe(true);
    expect(existsSync(join(dist, 'sf-build-report.json'))).toBe(true);

    const html = readFileSync(join(dist, 'index.html'), 'utf8');
    const studioUrl = `/${studio?.files[0] ?? ''}`;
    expect(html).toContain(`<link rel="modulepreload" href="${studioUrl}" crossorigin="anonymous" integrity="sha384-`);
  }, 60_000);
});
