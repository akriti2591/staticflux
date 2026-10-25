/**
 * Node test helpers for the text module: load the built authoring Wasm (`pnpm build` → engine/dist) and the OFL
 * test fonts (`apps/instaflow/test/fonts`). Not part of the build.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { type AuthoringBuild, type AuthoringWasm, loadAuthoringModule } from './authoring-module.js';
import { createTextLayoutEngine, type TextLayoutEngine } from './text-engine.js';

export const ENGINE_DIST = new URL('../../engine/dist/', import.meta.url);
export const TEST_FONTS = new URL('../../test/fonts/', import.meta.url);

/** True when `pnpm build` produced the authoring Wasm. */
export const authoringBuilt = existsSync(new URL('sf-wasm-manifest.json', ENGINE_DIST)) && readFileSync(new URL('sf-wasm-manifest.json', ENGINE_DIST), 'utf8').includes('"authoring"');

export async function loadAuthoringInNode(build: AuthoringBuild = 'base'): Promise<AuthoringWasm> {
  const loaded = await loadAuthoringModule({
    manifestUrl: new URL('sf-wasm-manifest.json', ENGINE_DIST).href,
    build,
    fetch: async (url) => ({ ok: true, status: 200, json: async () => JSON.parse(readFileSync(new URL(url), 'utf8')) as unknown }),
    importModule: (url) => import(/* @vite-ignore */ url),
    wasmSource: async (url) => readFileSync(new URL(url)),
  });
  if (!loaded.ok) throw loaded.error;
  return loaded.value;
}

export const FONT_FILES = ['NotoSans-Latin.wght.ttf', 'NotoSansArabic.wght.ttf', 'NotoSansDevanagari.wght.ttf', 'NotoSansThai.wght.ttf'] as const;

export interface TestFont {
  readonly file: string;
  readonly bytes: Uint8Array;
  readonly hash: `sha256:${string}`;
}

export function testFont(file: string): TestFont {
  const bytes = new Uint8Array(readFileSync(new URL(file, TEST_FONTS)));
  return { file, bytes, hash: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
}

/** A layout engine with the four test fonts and per-script fallbacks (the order of the Rust tests' `engine()`). */
export async function testTextEngine(options: { readonly complex?: boolean } = {}): Promise<TextLayoutEngine> {
  const wasm = await loadAuthoringInNode('base');
  const engine = createTextLayoutEngine({
    wasm,
    ...(options.complex === true ? { loadComplex: async () => ({ ok: true as const, value: await loadAuthoringInNode('complex') }) } : {}),
  });
  for (const file of FONT_FILES) {
    const f = testFont(file);
    const r = engine.registerFont(f.hash, f.bytes);
    if (!r.ok) throw r.error;
  }
  for (const [script, family] of [
    ['Arab', 'Noto Sans Arabic'],
    ['Deva', 'Noto Sans Devanagari'],
    ['Thai', 'Noto Sans Thai'],
  ] as const) {
    const r = engine.setFallbacks(script, [family]);
    if (!r.ok) throw r.error;
  }
  const g = engine.setGeneric('sans-serif', ['Noto Sans']);
  if (!g.ok) throw g.error;
  return engine;
}

export const STACK = '"Noto Sans", "Noto Sans Arabic", "Noto Sans Devanagari"';
