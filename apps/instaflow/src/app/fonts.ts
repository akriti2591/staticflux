/**
 * Studio's fonts (B8 glue over B2): the layout engine with the bundled OFL fonts registered by content hash, the
 * per-script fallbacks (S3 lesson: per script, not one long list) and the text defaults new text uses. Font
 * uploads and local fonts (B2 `createFontLibrary`) register into the same engine later.
 */
import { err, ok, type Result } from '@staticflux/core';
import type { AuthoringWasm } from '../text/authoring-module.js';
import { FontInvalidError } from '../text/errors.js';
import { createTextLayoutEngine, type TextLayoutEngine } from '../text/text-engine.js';
import type { FontFamilies, TextDefaults } from '../text/text-style.js';
import type { StudioFonts } from './text-layer.js';

export interface FontFile {
  readonly hash: `sha256:${string}`;
  readonly bytes: Uint8Array;
}

/** Script fallbacks for the bundled fonts (data; a missing family is simply not registered). */
export const STUDIO_SCRIPT_FALLBACKS: Readonly<Record<string, string>> = Object.freeze({ Arab: 'Noto Sans Arabic', Deva: 'Noto Sans Devanagari', Thai: 'Noto Sans Thai' });

/** Defaults for new text (the first font is the default face). */
export const STUDIO_TEXT_DEFAULTS = Object.freeze({ size: 48, color: '#16151a', weight: 400 });

export interface StudioFontsOptions {
  readonly wasm: AuthoringWasm;
  /** The default face first (Noto Sans Latin in the dev entry). */
  readonly fonts: readonly FontFile[];
  readonly loadComplex?: (signal?: AbortSignal) => Promise<Result<AuthoringWasm>>;
}

/** Register the fonts and fallbacks (IF-27.6). */
export function createStudioFonts(options: StudioFontsOptions): Result<StudioFonts> {
  const engine: TextLayoutEngine = createTextLayoutEngine({ wasm: options.wasm, ...(options.loadComplex === undefined ? {} : { loadComplex: options.loadComplex }) });
  const bytes = new Map<string, Uint8Array>();
  const names = new Map<string, readonly string[]>();
  for (const font of options.fonts) {
    const registered = engine.registerFont(font.hash, font.bytes);
    if (!registered.ok) return registered;
    bytes.set(font.hash, font.bytes);
    names.set(font.hash, registered.value.families);
  }
  const first = options.fonts[0];
  const family = first === undefined ? undefined : names.get(first.hash)?.[0];
  if (first === undefined || family === undefined) return err(FontInvalidError({ message: 'Studio needs at least one font with a family name (the default face first).' }));
  for (const [script, fallback] of Object.entries(STUDIO_SCRIPT_FALLBACKS)) {
    if (![...names.values()].some((n) => n.includes(fallback))) continue;
    const set = engine.setFallbacks(script, [fallback]);
    if (!set.ok) return set;
  }
  const generic = engine.setGeneric('sans-serif', [family]);
  if (!generic.ok) return generic;
  const defaults: TextDefaults = { font: { font: first.hash, family }, size: STUDIO_TEXT_DEFAULTS.size, color: STUDIO_TEXT_DEFAULTS.color, weight: STUDIO_TEXT_DEFAULTS.weight, fallback: ['sans-serif'] };
  const families: FontFamilies = (hash) => names.get(hash);
  return ok({ engine, defaults, families, bytesOf: (hash) => bytes.get(hash) });
}
