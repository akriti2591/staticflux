// @vitest-environment node
/** B11c: the logo in the tab (dark-mode aware) and the web app manifest's icons, from `apps/instaflow/brand/`. */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APP = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string): string => readFileSync(`${APP}${path}`, 'utf8');

describe('brand in the browser (B11c)', () => {
  it.each(['dev/home/index.html', 'dev/studio/index.html'])('%s links the favicon (SVG, then PNG), the touch icon and the manifest', (page) => {
    const html = read(page);
    const hrefs = [...html.matchAll(/<link rel="([^"]+)" href="([^"]+)"/g)].map((m) => [m[1], m[2]]);
    expect(hrefs).toEqual([
      ['icon', '/brand/favicon.svg'],
      ['icon', '/brand/favicon-32.png'],
      ['apple-touch-icon', '/brand/apple-touch-icon.png'],
      ['manifest', '/brand/manifest.webmanifest'],
    ]);
    for (const [, href] of hrefs) expect(existsSync(`${APP}${(href as string).slice(1)}`)).toBe(true);
  });

  it('the favicon follows the colour scheme (white strokes in dark mode)', () => {
    const svg = read('brand/favicon.svg');
    expect(svg).toContain('@media (prefers-color-scheme:dark)');
    expect(svg).toContain('#FFFFFF');
  });

  it('the manifest names Instaflow and lists the app icons that exist', () => {
    const manifest = JSON.parse(read('brand/manifest.webmanifest')) as { name: string; start_url: string; display: string; icons: { src: string; sizes: string }[] };
    expect([manifest.name, manifest.start_url, manifest.display]).toEqual(['Instaflow', '/', 'standalone']);
    expect(manifest.icons.map((i) => i.sizes)).toEqual(['192x192', '512x512', 'any']);
    for (const icon of manifest.icons) expect(existsSync(`${APP}${icon.src.slice(1)}`)).toBe(true);
  });
});
