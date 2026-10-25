/**
 * Asset kinds and media types (DOCUMENT-FORMAT §4) as data: which media types import as which blob
 * asset kind, which lens colour and shape marks each kind, and which renditions each kind gets. Feature
 * code looks these tables up; it never branches on a kind.
 */
import type { LensId } from '../theme/lenses.js';

/** Blob assets: immutable content (IF-3.6). */
export const BLOB_ASSET_KINDS = ['image', 'video', 'audio', 'font', 'vector', 'lottie', 'matte', 'transcript'] as const;
/** Tree assets: Latest + Milestones (IF-3.7). */
export const TREE_ASSET_KINDS = ['composition', 'template', 'brand-kit', 'motion-preset', 'workflow', 'prompt'] as const;
export const LIBRARY_ASSET_KINDS = [...BLOB_ASSET_KINDS, ...TREE_ASSET_KINDS] as const;

export type BlobAssetKind = (typeof BLOB_ASSET_KINDS)[number];
export type TreeAssetKind = (typeof TREE_ASSET_KINDS)[number];
export type LibraryAssetKind = (typeof LIBRARY_ASSET_KINDS)[number];

/** Importable media types and the blob asset kind each becomes. */
export const MEDIA_TYPES: Readonly<Record<string, BlobAssetKind>> = Object.freeze({
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
  'image/avif': 'image',
  'image/svg+xml': 'vector',
  'video/mp4': 'video',
  'video/webm': 'video',
  'video/quicktime': 'video',
  'audio/mpeg': 'audio',
  'audio/wav': 'audio',
  'audio/ogg': 'audio',
  'audio/mp4': 'audio',
  'audio/flac': 'audio',
  'font/ttf': 'font',
  'font/otf': 'font',
  'font/woff': 'font',
  'font/woff2': 'font',
});

/** Media type by file extension, for files the browser gives no type (fonts, some drag sources). */
export const EXTENSION_TYPES: Readonly<Record<string, string>> = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
});

/** Browser aliases of the canonical types above. */
const TYPE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'image/jpg': 'image/jpeg',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/mp3': 'audio/mpeg',
  'audio/x-m4a': 'audio/mp4',
  'audio/x-flac': 'audio/flac',
  'application/x-font-ttf': 'font/ttf',
  'application/font-woff': 'font/woff',
});

/** The canonical media type of a file: its own type when known, else by extension. Undefined when unsupported. */
export function mediaTypeOf(name: string, type: string): string | undefined {
  const declared = type.trim().toLowerCase().split(';')[0] ?? '';
  const canonical = TYPE_ALIASES[declared] ?? declared;
  if (MEDIA_TYPES[canonical] !== undefined) return canonical;
  const dot = name.lastIndexOf('.');
  const byExtension = dot < 0 ? undefined : EXTENSION_TYPES[name.slice(dot + 1).toLowerCase()];
  return byExtension;
}

/** The blob asset kind of a canonical media type. */
export function assetKindOf(mediaType: string): BlobAssetKind | undefined {
  return MEDIA_TYPES[mediaType];
}

/** The lens palette entry that marks each kind (Library rows, type tags): the kind of editing it opens in. */
export const ASSET_KIND_LENS: Readonly<Record<LibraryAssetKind, LensId>> = Object.freeze({
  image: 'pixel',
  matte: 'pixel',
  video: 'video',
  audio: 'video',
  lottie: 'video',
  transcript: 'video',
  'motion-preset': 'video',
  font: 'layout',
  vector: 'layout',
  composition: 'layout',
  template: 'layout',
  'brand-kit': 'layout',
  workflow: 'flow',
  prompt: 'flow',
});

/** A default title from a file name ("night-market_hero.png" → "night-market hero"). */
export function titleFromFileName(name: string): string {
  const base = name.replace(/\.[^./\\]+$/, '').replace(/[_]+/g, ' ').trim();
  return (base.length === 0 ? name : base).slice(0, 200);
}
