/**
 * Fonts (B2; IF-7.6, IF-21.16–21.18, IF-21.20): every font is an **asset keyed by content hash** (sha-256 = the blob store
 * digest), whatever its source:
 *
 * - **Local Font Access** (`queryLocalFonts`): a permission flow (`LocalFontsMachine`, LIFECYCLES §22). Listing needs
 *   a user gesture; S3: without it Chrome throws `SecurityError: User activation is required`. Picked faces are
 *   stored in the workspace blob store, so documents keep working on machines without that font.
 * - **Uploads** (.ttf/.otf/.ttc, and since B12 T-7 .woff2/.woff): validated, stored as blobs (A3 `BlobStore`). Web
 *   fonts are decoded to OpenType first (`decodeWebfont`, the lazy `authoring-webfont` Wasm), so the stored blob, its
 *   hash and everything downstream are plain OpenType.
 * - **Brand-kit font tokens** resolve to one of the above (`text-style.ts`, `BrandTokenSource`).
 *
 * Registered fonts feed the layout engine (`registerFont(hash, bytes)`) and the scene font table (`bytesOf(hash)`).
 * Client gating is UX, not security (rule 9): the permission state only decides what the UI offers.
 */
import type { BlobStore } from '@staticflux/blob';
import { createMachine, defineMachine, err, type Machine, ok, type Result, type SfError, toSfError } from '@staticflux/core';
import { FontInvalidError, FontStoreError, LocalFontsPermissionError, LocalFontsUnavailableError, WebFontDecodeError } from './errors.js';
import type { WebfontWasm } from './authoring-module.js';
import type { RegisteredFont } from './text-engine.js';

export const LocalFontsMachine = /* @__PURE__ */ defineMachine({
  id: 'instaflow/local-fonts',
  initial: 'unknown',
  states: ['unknown', 'unavailable', 'prompt', 'requesting', 'granted', 'denied'],
  transitions: {
    unknown: { unavailable: 'unavailable', prompt: 'prompt', granted: 'granted', denied: 'denied' },
    prompt: { request: 'requesting', granted: 'granted', denied: 'denied' },
    requesting: { granted: 'granted', denied: 'denied', cancel: 'prompt' },
    granted: { request: 'requesting', revoked: 'prompt', denied: 'denied' },
    denied: { prompt: 'prompt', granted: 'granted' },
  },
  terminal: ['unavailable'],
});
export type LocalFontsState = (typeof LocalFontsMachine.states)[number];
export type LocalFontsEvent = 'unavailable' | 'prompt' | 'request' | 'granted' | 'denied' | 'cancel' | 'revoked';

/** Stored font blobs' MIME type. */
export const FONT_MIME = 'font/otf';

export const FONT_SOURCES = ['local', 'upload', 'curated'] as const;
export type FontSource = (typeof FONT_SOURCES)[number];

export interface FontAsset {
  readonly hash: `sha256:${string}`;
  readonly families: readonly string[];
  readonly source: FontSource;
  /** Display name (full name for local fonts, file name for uploads). */
  readonly name: string;
  readonly bytes: number;
}

/** A face from `queryLocalFonts()` (the parts used here). */
export interface LocalFontData {
  readonly family: string;
  readonly fullName: string;
  readonly postscriptName: string;
  readonly style: string;
  blob(): Promise<Blob>;
}

/** Browser access, injected (tests pass fakes). */
export interface FontPlatform {
  /** `globalThis.queryLocalFonts` (absent where unsupported). */
  readonly queryLocalFonts?: (options?: { postscriptNames?: string[] }) => Promise<readonly LocalFontData[]>;
  /** `navigator.permissions.query({ name: 'local-fonts' })` state, when the Permissions API knows it. */
  readonly permissionState?: () => Promise<'granted' | 'prompt' | 'denied' | undefined>;
}

export interface FontLibraryOptions {
  readonly blobs: BlobStore;
  /** Registers bytes with the layout engine (`TextLayoutEngine.registerFont`). */
  readonly register: (hash: string, bytes: Uint8Array) => Result<RegisteredFont>;
  readonly platform?: FontPlatform;
  /** WOFF2 / WOFF → OpenType (B12 T-7; `webfontDecoder(load)`). Omitted: web fonts are refused (IF-TXT-006). */
  readonly decodeWebfont?: WebfontDecoder;
}

/** Decodes a web font to OpenType bytes. */
export type WebfontDecoder = (bytes: Uint8Array, signal?: AbortSignal) => Promise<Result<Uint8Array>>;

/**
 * A decoder over the lazy web font Wasm: `load` runs once, on the first web font (e.g. `() => loadWebfontModule({
 * manifestUrl })`); a failed load is retried on the next call.
 */
export function webfontDecoder(load: (signal?: AbortSignal) => Promise<Result<Pick<WebfontWasm, 'decode_webfont'>>>): WebfontDecoder {
  let module: Promise<Result<Pick<WebfontWasm, 'decode_webfont'>>> | undefined;
  return async (bytes, signal) => {
    module ??= load(signal);
    const wasm = await module;
    if (!wasm.ok) {
      module = undefined;
      return err(WebFontDecodeError({ cause: wasm.error, message: 'The web font decoder could not be loaded.' }));
    }
    try {
      const out = wasm.value.decode_webfont(bytes);
      return isFontFile(out) ? ok(out) : err(WebFontDecodeError({ details: { reason: 'not OpenType after decoding' } }));
    } catch (cause) {
      return err(WebFontDecodeError({ cause, details: { reason: String((cause as Error)?.message ?? cause) } }));
    }
  };
}

export interface FontLibrary {
  /** Local Font Access permission flow. */
  readonly localFonts: Machine<LocalFontsState, LocalFontsEvent>;
  /** Read the permission state without prompting (call at panel open). */
  checkLocalFonts(): Promise<LocalFontsState>;
  /** List local faces. Call from a user gesture (click); prompts for permission. */
  requestLocalFonts(signal?: AbortSignal): Promise<Result<readonly LocalFontData[]>>;
  /** Copy a local face into the workspace and register it. */
  importLocalFont(font: LocalFontData, signal?: AbortSignal): Promise<Result<FontAsset>>;
  /** Store and register an uploaded font file. */
  importUpload(file: Blob, name: string, signal?: AbortSignal): Promise<Result<FontAsset>>;
  /** Load a stored font (a document references it by hash) and register it. */
  load(hash: `sha256:${string}`, signal?: AbortSignal): Promise<Result<FontAsset>>;
  readonly assets: readonly FontAsset[];
  asset(hash: string): FontAsset | undefined;
  /** Font bytes for the scene font table (registered fonts only). */
  bytesOf(hash: string): Uint8Array | undefined;
  /** Families of a registered font (the `FontFamilies` of text-style). */
  families(hash: `sha256:${string}`): readonly string[] | undefined;
}

const MAGICS = [[0x00, 0x01, 0x00, 0x00], [0x4f, 0x54, 0x54, 0x4f], [0x74, 0x72, 0x75, 0x65], [0x74, 0x74, 0x63, 0x66]];

/** True for OpenType/TrueType/collection bytes (not WOFF/WOFF2, which need decompression first). */
export function isFontFile(bytes: Uint8Array): boolean {
  return bytes.length > 12 && MAGICS.some((m) => m.every((b, i) => bytes[i] === b));
}

const WEB_MAGICS = { woff2: [0x77, 0x4f, 0x46, 0x32], woff: [0x77, 0x4f, 0x46, 0x46] } as const;

/** The web font container of `bytes` (`wOF2` / `wOFF`), or undefined (B12 T-7). */
export function webFontKind(bytes: Uint8Array): 'woff2' | 'woff' | undefined {
  if (bytes.length <= 12) return undefined;
  return (Object.keys(WEB_MAGICS) as ('woff2' | 'woff')[]).find((k) => WEB_MAGICS[k].every((b, i) => bytes[i] === b));
}

const isSecurityError = (cause: unknown): boolean => (cause as { name?: string } | null)?.name === 'SecurityError' || (cause as { name?: string } | null)?.name === 'NotAllowedError';

export function createFontLibrary(options: FontLibraryOptions): FontLibrary {
  const machine = createMachine(LocalFontsMachine);
  const assets = new Map<string, FontAsset>();
  const bytesByHash = new Map<string, Uint8Array>();
  const platform = options.platform ?? {};
  const send = (event: Parameters<typeof machine.send>[0]): void => {
    if (machine.can(event)) machine.send(event);
  };

  const add = async (input: Uint8Array, source: FontSource, name: string, signal?: AbortSignal): Promise<Result<FontAsset>> => {
    let bytes = input;
    const web = webFontKind(input);
    if (web !== undefined && options.decodeWebfont !== undefined) {
      const decoded = await options.decodeWebfont(input, signal);
      if (!decoded.ok) return decoded;
      bytes = decoded.value;
    }
    if (!isFontFile(bytes)) return err(FontInvalidError({ details: { name, ...(web === undefined ? {} : { format: web }) } }));
    const stored = await options.blobs.put(bytes, { mime: FONT_MIME, ...(signal === undefined ? {} : { signal }) });
    if (!stored.ok) return err(FontStoreError({ cause: stored.error, details: { name } }));
    return registerBytes(stored.value.digest, bytes, source, name);
  };

  const registerBytes = (hash: `sha256:${string}`, bytes: Uint8Array, source: FontSource, name: string): Result<FontAsset> => {
    const known = assets.get(hash);
    if (known !== undefined) return ok(known);
    const registered = options.register(hash, bytes);
    if (!registered.ok) return registered;
    const asset: FontAsset = { hash, families: registered.value.families, source, name, bytes: bytes.length };
    assets.set(hash, asset);
    bytesByHash.set(hash, bytes);
    return ok(asset);
  };

  return {
    localFonts: machine,
    async checkLocalFonts() {
      if (platform.queryLocalFonts === undefined) {
        send('unavailable');
        return machine.state;
      }
      const state = await platform.permissionState?.().catch(() => undefined);
      if (state !== undefined) send(state);
      else send('prompt');
      return machine.state;
    },
    async requestLocalFonts(signal) {
      if (platform.queryLocalFonts === undefined) {
        send('unavailable');
        return err(LocalFontsUnavailableError());
      }
      if (machine.is('unknown')) send('prompt');
      if (machine.is('denied')) return err(LocalFontsPermissionError({ message: 'Local font access is blocked for this site.', details: { state: 'denied' } }));
      send('request');
      try {
        signal?.throwIfAborted();
        const fonts = await platform.queryLocalFonts();
        // An empty list after a prompt usually means the user dismissed or denied it.
        send(fonts.length === 0 ? 'denied' : 'granted');
        return fonts.length === 0 ? err(LocalFontsPermissionError({ message: 'No local fonts were shared.', details: { state: 'denied' } })) : ok(fonts);
      } catch (cause) {
        if (isSecurityError(cause)) {
          // No user activation: stay promptable; a denied permission also lands here.
          const state = await platform.permissionState?.().catch(() => undefined);
          send(state === 'denied' ? 'denied' : 'cancel');
          return err(LocalFontsPermissionError({ cause, details: { state: machine.state } }));
        }
        send('cancel');
        return err(toSfError(cause));
      }
    },
    async importLocalFont(font, signal) {
      try {
        const blob = await font.blob();
        signal?.throwIfAborted();
        return add(new Uint8Array(await blob.arrayBuffer()), 'local', font.fullName, signal);
      } catch (cause) {
        return err(toSfError(cause));
      }
    },
    async importUpload(file, name, signal) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        signal?.throwIfAborted();
        return add(bytes, 'upload', name, signal);
      } catch (cause) {
        return err(toSfError(cause));
      }
    },
    async load(hash, signal) {
      const known = assets.get(hash);
      if (known !== undefined) return ok(known);
      const opts = signal === undefined ? {} : { signal };
      let got = await options.blobs.get({ digest: hash, size: 0, mime: FONT_MIME }, opts);
      // Fonts over 8 MiB (CJK) are chunked: the hash names their chunk manifest.
      if (got.ok && !isFontFile(got.value)) {
        const chunked = await options.blobs.get({ digest: hash, size: 0, mime: FONT_MIME, chunked: true }, opts);
        if (chunked.ok) got = chunked;
      }
      if (!got.ok) return err(FontStoreError({ cause: got.error, details: { hash } }) as SfError);
      if (!isFontFile(got.value)) return err(FontInvalidError({ details: { hash } }));
      return registerBytes(hash, got.value, 'curated', hash.slice(7, 19));
    },
    get assets() {
      return [...assets.values()];
    },
    asset: (hash) => assets.get(hash),
    bytesOf: (hash) => bytesByHash.get(hash),
    families: (hash) => assets.get(hash)?.families,
  };
}
