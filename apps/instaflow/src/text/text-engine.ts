/**
 * Text layout service over the authoring Wasm (B2; IF-7.6, IF-21.7–21.12). Lives in the editor worker.
 *
 * - **Fonts** are registered once per content hash; the service remembers registration order so the lazy
 *   `authoring-complex` build replays the same fonts and fallbacks and gets the **same font ids**.
 * - **Blocks** (one per text element) are laid out from an encoded spec and retained, so caret, selection,
 *   character bounds and hit tests are answered without re-shaping.
 * - **complex-scripts** (S3): text containing Thai, Lao, Khmer or Myanmar is laid out by the complex build once it is
 *   loaded (`prepare(text)` loads it); until then the base build lays it out without dictionary line breaks.
 *   Choosing the build is data (`needsComplexScripts`), not a branch on browsers or modes.
 */
import { err, ok, type Result, toSfError } from '@staticflux/core';
import type { AuthoringWasm, TextEngineWasm } from './authoring-module.js';
import { FontInvalidError, TextLayoutError } from './errors.js';
import { decodeTextLayout, type TextLayout } from './layout-result.js';

/** Caret motions (wire values of `motion` in the crate). */
export const CaretMotion = Object.freeze({
  left: 0,
  right: 1,
  wordLeft: 2,
  wordRight: 3,
  lineStart: 4,
  lineEnd: 5,
  up: 6,
  down: 7,
  textStart: 8,
  textEnd: 9,
  prevGrapheme: 10,
  nextGrapheme: 11,
} as const);
export type CaretMotionName = keyof typeof CaretMotion;

export interface CaretPosition {
  readonly offset: number;
  /** Upstream affinity (the caret sticks to the preceding character, e.g. at a soft line end). */
  readonly upstream: boolean;
}

export interface Rect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** Scripts whose line breaking needs ICU4X dictionaries (Parley `complex-scripts`). */
const COMPLEX = /[฀-໿က-႟ក-៿᧠-᧿ꩠ-ꩿꧠ-꧿]/u;

/** True when `text` needs the complex-scripts build to wrap correctly (Thai, Lao, Khmer, Myanmar). */
export function needsComplexScripts(text: string): boolean {
  return COMPLEX.test(text);
}

export interface RegisteredFont {
  /** Content hash (`sha256:…`). */
  readonly hash: string;
  /** Authoring font ids (one per face). */
  readonly ids: readonly number[];
  readonly families: readonly string[];
}

export interface TextLayoutEngine {
  /** Register font bytes under their content hash (idempotent per hash). */
  registerFont(hash: string, bytes: Uint8Array): Result<RegisteredFont>;
  /** The font registered for an authoring font id. */
  fontOf(id: number): RegisteredFont | undefined;
  readonly fonts: readonly RegisteredFont[];
  /** Per-script fallback families (ISO 15924 tag, e.g. `Arab`). */
  setFallbacks(script: string, families: readonly string[]): Result<void>;
  setGeneric(generic: 'sans-serif' | 'serif' | 'monospace', families: readonly string[]): Result<void>;
  /** Load the complex-scripts build when `text` needs it (no-op otherwise or when already loaded). */
  prepare(text: string, signal?: AbortSignal): Promise<Result<void>>;
  readonly complexLoaded: boolean;
  /** Lay out block `id` (retained until `drop`). `text` is the block text (selects the build). */
  layout(id: number, spec: Uint8Array, text: string): Result<TextLayout>;
  drop(id: number): void;
  hitTest(id: number, x: number, y: number): Result<CaretPosition>;
  caret(id: number, at: CaretPosition, width?: number): Result<Rect>;
  selectionRects(id: number, from: number, to: number): Result<readonly Rect[]>;
  /** One rect per UTF-16 code unit of `[from, to)` (EditContext character bounds). */
  charBounds(id: number, from: number, to: number): Result<readonly Rect[]>;
  wordAt(id: number, offset: number): Result<readonly [number, number]>;
  move(id: number, from: CaretPosition, motion: CaretMotionName, xHint?: number): Result<CaretPosition>;
  dispose(): void;
}

export interface TextLayoutEngineOptions {
  readonly wasm: AuthoringWasm;
  /** Loads the complex-scripts build (lazy chunk); omitted = never (Thai etc. do not wrap). */
  readonly loadComplex?: (signal?: AbortSignal) => Promise<Result<AuthoringWasm>>;
}

const rects = (v: Float32Array): Rect[] => {
  const out: Rect[] = [];
  for (let i = 0; i + 3 < v.length; i += 4) out.push({ x0: v[i] as number, y0: v[i + 1] as number, x1: v[i + 2] as number, y1: v[i + 3] as number });
  return out;
};

function call<T>(f: () => T, what: string): Result<T> {
  try {
    return ok(f());
  } catch (cause) {
    return err(TextLayoutError({ cause, message: `${what}: ${String((cause as Error)?.message ?? cause)}` }));
  }
}

export function createTextLayoutEngine(options: TextLayoutEngineOptions): TextLayoutEngine {
  const base = new options.wasm.TextEngine();
  let complex: TextEngineWasm | undefined;
  let loading: Promise<Result<void>> | undefined;
  const fonts: RegisteredFont[] = [];
  const fontBytes: Uint8Array[] = [];
  const byHash = new Map<string, RegisteredFont>();
  const byId = new Map<number, RegisteredFont>();
  const settings: (readonly ['fallbacks' | 'generic', string, string])[] = [];
  /** Which engine holds each block. */
  const owner = new Map<number, TextEngineWasm>();

  const engines = (): TextEngineWasm[] => (complex === undefined ? [base] : [base, complex]);
  const holder = (id: number): Result<TextEngineWasm> => {
    const e = owner.get(id);
    return e === undefined ? err(TextLayoutError({ message: `Text block ${id} is not laid out.`, details: { id } })) : ok(e);
  };
  const applySetting = (e: TextEngineWasm, [kind, a, b]: readonly ['fallbacks' | 'generic', string, string]): void => {
    if (kind === 'fallbacks') e.set_fallbacks(a, b);
    else e.set_generic(a, b);
  };

  return {
    get fonts() {
      return fonts;
    },
    get complexLoaded() {
      return complex !== undefined;
    },
    registerFont(hash, bytes) {
      const known = byHash.get(hash);
      if (known !== undefined) return ok(known);
      let ids: number[];
      try {
        ids = [...base.add_font(bytes)];
        complex?.add_font(bytes);
      } catch (cause) {
        return err(FontInvalidError({ cause, details: { hash } }));
      }
      const all = base.family_names().split('\n').filter((n) => n.length > 0);
      const before = new Set(fonts.flatMap((f) => f.families));
      const families = all.filter((n) => !before.has(n));
      const font: RegisteredFont = { hash, ids, families: families.length > 0 ? families : all.slice(-1) };
      fonts.push(font);
      fontBytes.push(bytes);
      byHash.set(hash, font);
      for (const id of ids) byId.set(id, font);
      return ok(font);
    },
    fontOf: (id) => byId.get(id),
    setFallbacks(script, families) {
      const s = ['fallbacks', script, families.join('\n')] as const;
      const r = call(() => engines().forEach((e) => applySetting(e, s)), 'set fallbacks');
      if (r.ok) settings.push(s);
      return r;
    },
    setGeneric(generic, families) {
      const s = ['generic', generic, families.join('\n')] as const;
      const r = call(() => engines().forEach((e) => applySetting(e, s)), 'set generic family');
      if (r.ok) settings.push(s);
      return r;
    },
    prepare(text, signal) {
      if (complex !== undefined || !needsComplexScripts(text) || options.loadComplex === undefined) return Promise.resolve(ok(undefined));
      loading ??= (async (): Promise<Result<void>> => {
        const loaded = await (options.loadComplex as NonNullable<typeof options.loadComplex>)(signal);
        if (!loaded.ok) {
          loading = undefined;
          return loaded;
        }
        try {
          const e = new loaded.value.TextEngine();
          for (const bytes of fontBytes) e.add_font(bytes);
          for (const s of settings) applySetting(e, s);
          complex = e;
          return ok(undefined);
        } catch (cause) {
          loading = undefined;
          return err(toSfError(cause));
        }
      })();
      return loading;
    },
    layout(id, spec, text) {
      const engine = complex !== undefined && needsComplexScripts(text) ? complex : base;
      const previous = owner.get(id);
      if (previous !== undefined && previous !== engine) previous.drop_block(id);
      const encoded = call(() => engine.layout(id, spec), 'layout');
      if (!encoded.ok) return encoded;
      owner.set(id, engine);
      return call(() => decodeTextLayout(encoded.value), 'decode layout');
    },
    drop(id) {
      owner.get(id)?.drop_block(id);
      owner.delete(id);
    },
    hitTest(id, x, y) {
      const e = holder(id);
      if (!e.ok) return e;
      return call(() => {
        const v = e.value.hit_test(id, x, y);
        return { offset: v[0] as number, upstream: v[1] === 1 };
      }, 'hit test');
    },
    caret(id, at, width = 1) {
      const e = holder(id);
      if (!e.ok) return e;
      return call(() => rects(e.value.caret(id, at.offset, at.upstream, width))[0] as Rect, 'caret');
    },
    selectionRects(id, from, to) {
      const e = holder(id);
      if (!e.ok) return e;
      return call(() => rects(e.value.selection_rects(id, from, to)), 'selection');
    },
    charBounds(id, from, to) {
      const e = holder(id);
      if (!e.ok) return e;
      return call(() => rects(e.value.char_bounds(id, from, to)), 'character bounds');
    },
    wordAt(id, offset) {
      const e = holder(id);
      if (!e.ok) return e;
      return call(() => {
        const v = e.value.word_at(id, offset);
        return [v[0] as number, v[1] as number] as const;
      }, 'word');
    },
    move(id, from, motion, xHint) {
      const e = holder(id);
      if (!e.ok) return e;
      return call(() => {
        const v = e.value.move_caret(id, from.offset, from.upstream, CaretMotion[motion], xHint ?? Number.NaN);
        return { offset: v[0] as number, upstream: v[1] === 1 };
      }, 'caret motion');
    },
    dispose() {
      for (const e of engines()) e.free();
      owner.clear();
    },
  };
}
