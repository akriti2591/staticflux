/** What the Studio page preloads (#62): the manifest's boot crates by their hashed names, and the built worker chunk. */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bundlePreloads, manifestPreloads, STUDIO_BOOT_CRATES } from './studio-preload.js';

const manifest = {
  format: 'sf-wasm-manifest/1',
  artifacts: [
    { crate: 'render', wasm: 'render.e31e.wasm', js: 'render.acaf.js' },
    { crate: 'authoring', wasm: 'authoring.9bfa.wasm', js: 'authoring.e5de.js' },
    { crate: 'authoring-text', wasm: 'authoring_text.d7d9.wasm', js: 'authoring_text.5f03.js' },
    { crate: 'authoring-text-complex', wasm: 'authoring_text_complex.c55b.wasm', js: 'authoring_text_complex.e02e.js' },
    { crate: 'export', wasm: 'export.608a.wasm', js: 'export.6c6f.js' },
  ],
};

describe('manifestPreloads', () => {
  it('names the manifest and the boot crates’ glue and Wasm next to it, nothing loaded on demand', () => {
    const { links, missing } = manifestPreloads(manifest, '/engine/dist/sf-wasm-manifest.json');
    expect(missing).toEqual([]);
    expect(links).toEqual([
      { href: '/engine/dist/sf-wasm-manifest.json' },
      { href: '/engine/dist/authoring.e5de.js' },
      { href: '/engine/dist/authoring.9bfa.wasm', type: 'application/wasm' },
      { href: '/engine/dist/authoring_text.5f03.js' },
      { href: '/engine/dist/authoring_text.d7d9.wasm', type: 'application/wasm' },
      { href: '/engine/dist/render.acaf.js' },
      { href: '/engine/dist/render.e31e.wasm', type: 'application/wasm' },
    ]);
    expect(links.some((l) => /complex|export/.test(l.href))).toBe(false);
  });

  it('reports the boot crates a manifest lacks (the build fails on it), and survives a malformed one', () => {
    expect(manifestPreloads({ artifacts: [manifest.artifacts[0]] }, '/m.json').missing).toEqual(['authoring', 'authoring-text']);
    expect(manifestPreloads(null, '/m.json')).toEqual({ links: [{ href: '/m.json' }], missing: [...STUDIO_BOOT_CRATES] });
    expect(manifestPreloads({ artifacts: [{ crate: 'render', wasm: 3 }] }, '/m.json').missing).toContain('render');
  });

  it('matches what the workers load at boot (the real manifest, when the Wasm is built)', () => {
    const file = new URL('../../engine/dist/sf-wasm-manifest.json', import.meta.url);
    if (!existsSync(file)) return;
    const { links, missing } = manifestPreloads(JSON.parse(readFileSync(file, 'utf8')), '/engine/dist/sf-wasm-manifest.json');
    expect(missing).toEqual([]);
    for (const link of links.slice(1)) expect(existsSync(new URL(`../..${link.href}`, import.meta.url))).toBe(true);
  });
});

describe('bundlePreloads', () => {
  it('names the built Studio worker chunk only', () => {
    expect(bundlePreloads(['assets/studio-71MP.js', 'assets/studio.worker-C9ej.js', 'assets/export.worker-BXQb.js', 'assets/loro_wasm_bg-XW64.wasm', 'dev/studio/index.html'])).toEqual([
      { href: '/assets/studio.worker-C9ej.js' },
    ]);
    expect(bundlePreloads(['assets/studio.worker-C9ej.js'], '/app/')).toEqual([{ href: '/app/assets/studio.worker-C9ej.js' }]);
    expect(bundlePreloads([])).toEqual([]);
  });
});
