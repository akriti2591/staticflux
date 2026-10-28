/**
 * What the Studio page preloads (issue #62): files the workers fetch at boot, named in `<head>` so the browser starts
 * them with the page's JavaScript instead of after the workspace opened (the workers then read them from the HTTP
 * cache: their names carry a content hash and the server marks them immutable). Pure: the Vite plugin
 * (`dev/studio/preload-plugin.ts`) reads the inputs and writes the tags, in the dev server and the production build.
 *
 * - From the engine's Wasm manifest (`engine/dist/sf-wasm-manifest.json`): the manifest itself and the glue and Wasm
 *   of the crates the workers load before Studio shows the canvas (`STUDIO_BOOT_CRATES`, see
 *   `workers/studio.worker.ts`). The complex-script, web font and export builds load on demand and are left out.
 * - From a production bundle (`bundlePreloads`): the Studio worker's chunk (the dev server serves it from source).
 *   Not Loro's Wasm: loro-crdt fetches it with a synchronous request, which never uses a preload (Chrome downloads it
 *   twice).
 */

/** The Wasm crates Studio's workers load at boot: the editor's geometry and text builds and the render module. */
export const STUDIO_BOOT_CRATES = Object.freeze(['authoring', 'authoring-text', 'render'] as const);

/** One `<link rel="preload" as="fetch" crossorigin>`: a plain fetch into the HTTP cache (nothing is parsed on main). */
export interface PreloadLink {
  readonly href: string;
  /** `application/wasm` for Wasm. */
  readonly type?: string;
}

/** The manifest's preloads, and the boot crates it does not name (the build must fail: run the root `pnpm build`). */
export interface ManifestPreloads {
  readonly links: readonly PreloadLink[];
  readonly missing: readonly string[];
}

interface ManifestArtifact {
  readonly crate?: unknown;
  readonly wasm?: unknown;
  readonly js?: unknown;
}

const WASM = 'application/wasm';

/** The preloads for the Wasm manifest `manifest` served at `manifestHref` (artifact paths resolve next to it). */
export function manifestPreloads(manifest: unknown, manifestHref: string): ManifestPreloads {
  const dir = manifestHref.slice(0, manifestHref.lastIndexOf('/') + 1);
  const artifacts = (manifest as { readonly artifacts?: unknown } | null)?.artifacts;
  const list: readonly ManifestArtifact[] = Array.isArray(artifacts) ? (artifacts as ManifestArtifact[]) : [];
  const links: PreloadLink[] = [{ href: manifestHref }];
  const missing: string[] = [];
  for (const crate of STUDIO_BOOT_CRATES) {
    const entry = list.find((a) => a.crate === crate);
    if (entry === undefined || typeof entry.js !== 'string' || typeof entry.wasm !== 'string') {
      missing.push(crate);
      continue;
    }
    links.push({ href: `${dir}${entry.js}` }, { href: `${dir}${entry.wasm}`, type: WASM });
  }
  return { links, missing };
}

const STUDIO_WORKER = /(^|\/)studio\.worker-[\w-]+\.js$/;

/** The production bundle's preloads from its emitted file names (relative to `base`): the Studio worker's chunk. */
export function bundlePreloads(fileNames: readonly string[], base = '/'): readonly PreloadLink[] {
  return fileNames.filter((name) => STUDIO_WORKER.test(name)).map((name) => ({ href: `${base}${name}` }));
}
