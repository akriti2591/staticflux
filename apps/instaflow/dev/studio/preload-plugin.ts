/**
 * Vite plugin (issue #62): the Studio page's `<head>` preloads what the workers fetch at boot, so those downloads
 * start with the page's JavaScript. Used by the dev server (dev/studio/vite.config.ts) and the production build
 * (prod/vite.config.ts); the list comes from `src/app/studio-preload.ts`:
 * - both: the Wasm manifest and the boot crates' glue and Wasm, by their hashed names from
 *   `engine/dist/sf-wasm-manifest.json` (copied as they are into dist-prod by scripts/build-prod.mjs);
 * - the build only: the Studio worker chunk, by the name this bundle emitted.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { HtmlTagDescriptor, Plugin } from 'vite';
import { bundlePreloads, manifestPreloads, type PreloadLink } from '../../src/app/studio-preload.js';

const MANIFEST_FILE = fileURLToPath(new URL('../../engine/dist/sf-wasm-manifest.json', import.meta.url));
const MANIFEST_HREF = '/engine/dist/sf-wasm-manifest.json';

const tag = (link: PreloadLink): HtmlTagDescriptor => ({
  tag: 'link',
  attrs: { rel: 'preload', as: 'fetch', crossorigin: '', href: link.href, ...(link.type === undefined ? {} : { type: link.type }) },
  injectTo: 'head',
});

export function studioPreloadPlugin(): Plugin {
  return {
    name: 'instaflow-studio-preload',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        if (!/dev\/studio\/index\.html$/.test(ctx.filename)) return undefined;
        let manifest: unknown;
        try {
          manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'));
        } catch (cause) {
          throw new Error(`Studio preloads: cannot read ${MANIFEST_FILE} (run the root \`pnpm build\`, it builds the Wasm): ${String(cause)}`);
        }
        const fromManifest = manifestPreloads(manifest, MANIFEST_HREF);
        if (fromManifest.missing.length > 0) throw new Error(`Studio preloads: the Wasm manifest has no ${fromManifest.missing.join(', ')} artifact (run the root \`pnpm build\`).`);
        const fromBundle = ctx.bundle === undefined ? [] : bundlePreloads(Object.keys(ctx.bundle));
        return [...fromManifest.links, ...fromBundle].map(tag);
      },
    },
  };
}
