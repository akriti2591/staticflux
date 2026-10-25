/**
 * Zip bundles (the `.iflow` container, DOCUMENT-FORMAT §9): a streaming
 * writer and an in-place reader (end of central directory + central
 * directory, entries read lazily by `Blob.slice`).
 *
 * - Entries are STORED (method 0, media: range-readable in place) or DEFLATE
 *   (method 8). Blobs already stored deflate-raw are **copied without
 *   recompression** (S6): the zip payload of method 8 *is* deflate-raw.
 * - OCF style bundles: `mimetype` is the first entry, STORED, so the type is
 *   readable at a fixed offset.
 * - No zip64, encryption or multi-disk: limits are 65,535 entries and 4 GiB per
 *   entry and per archive (`SF-BLOB-012`).
 */
import { err, ok, type Result } from '@staticflux/core';
import { concatBytes, crc32, deflateRaw, fromUtf8, inflateRaw, sha256, utf8 } from './codec.js';
import { BlobInvalidInputError, BlobZipError, BlobZipUnsupportedError, toBlobError } from './errors.js';
import type { BlobRange, BlobRef, BlobStore } from './types.js';

export const ZIP_STORED = 0;
export const ZIP_DEFLATE = 8;
export type ZipMethod = typeof ZIP_STORED | typeof ZIP_DEFLATE;

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const UTF8_FLAG = 0x0800;
const MAX_U32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;

/** Where the writer sends bytes (a `WritableStreamDefaultWriter`, a file writable, an array). */
export interface ZipSink {
  write(chunk: Uint8Array): Promise<void> | void;
}

export interface ZipEntryInfo {
  readonly name: string;
  readonly method: ZipMethod;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localOffset: number;
}

export interface ZipWriter {
  /** Store bytes as they are (method 0). */
  addStored(name: string, bytes: Uint8Array): Promise<Result<void>>;
  /** Deflate and add (method 8). */
  addCompressed(name: string, bytes: Uint8Array): Promise<Result<void>>;
  /** Add an already deflate-raw payload (method 8) with the CRC and size of its decoded content. */
  addDeflated(name: string, deflated: Uint8Array, decoded: { readonly crc: number; readonly size: number }): Promise<Result<void>>;
  /** Add a STORED entry from parts (e.g. chunks), given the total size and CRC up front. */
  addStoredParts(name: string, info: { readonly crc: number; readonly size: number }, parts: AsyncIterable<Result<Uint8Array>>): Promise<Result<void>>;
  /** Write the central directory and the end record. */
  finish(): Promise<Result<{ readonly entries: number; readonly bytes: number }>>;
  readonly entries: readonly ZipEntryInfo[];
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getUTCFullYear(), 1980), 2107);
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

export interface ZipWriterOptions {
  /** Modification time stamped on every entry (default: now). Fix it for reproducible bundles. */
  readonly modified?: Date;
}

export function createZipWriter(sink: ZipSink, options: ZipWriterOptions = {}): ZipWriter {
  const stamp = dosDateTime(options.modified ?? new Date());
  const entries: (ZipEntryInfo & { readonly nameBytes: Uint8Array })[] = [];
  const names = new Set<string>();
  let offset = 0;
  let finished = false;

  const emit = async (bytes: Uint8Array): Promise<void> => {
    await sink.write(bytes);
    offset += bytes.length;
  };

  const begin = (name: string, sizes: readonly number[]): Result<Uint8Array> => {
    if (finished) return err(BlobInvalidInputError({ message: 'The zip writer is finished.' }));
    if (name.length === 0 || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) {
      return err(BlobInvalidInputError({ message: `Invalid zip entry name "${name}".` }));
    }
    if (names.has(name)) return err(BlobInvalidInputError({ message: `Duplicate zip entry "${name}".` }));
    if (entries.length >= MAX_ENTRIES) return err(BlobZipUnsupportedError({ message: `More than ${MAX_ENTRIES} entries needs zip64.` }));
    if (sizes.some((s) => s >= MAX_U32) || offset >= MAX_U32) return err(BlobZipUnsupportedError({ message: `Entry "${name}" or the archive exceeds 4 GiB (zip64).` }));
    return ok(utf8(name));
  };

  const localHeader = (nameBytes: Uint8Array, method: ZipMethod, crc: number, compressed: number, size: number): Uint8Array => {
    const header = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, LOCAL_SIG, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, UTF8_FLAG, true);
    view.setUint16(8, method, true);
    view.setUint16(10, stamp.time, true);
    view.setUint16(12, stamp.date, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, compressed, true);
    view.setUint32(22, size, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true);
    header.set(nameBytes, 30);
    return header;
  };

  const add = async (name: string, method: ZipMethod, data: Uint8Array, crc: number, size: number): Promise<Result<void>> => {
    const nameBytes = begin(name, [data.length, size]);
    if (!nameBytes.ok) return nameBytes;
    try {
      const localOffset = offset;
      await emit(localHeader(nameBytes.value, method, crc, data.length, size));
      await emit(data);
      names.add(name);
      entries.push({ name, nameBytes: nameBytes.value, method, crc, compressedSize: data.length, size, localOffset });
      return ok();
    } catch (cause) {
      return err(toBlobError(cause, 'zip-write', name));
    }
  };

  return {
    get entries() {
      return entries.map(({ nameBytes: _n, ...info }) => info);
    },
    addStored: (name, bytes) => add(name, ZIP_STORED, bytes, crc32(bytes), bytes.length),
    async addCompressed(name, bytes) {
      return add(name, ZIP_DEFLATE, await deflateRaw(bytes), crc32(bytes), bytes.length);
    },
    addDeflated: (name, deflated, decoded) => add(name, ZIP_DEFLATE, deflated, decoded.crc >>> 0, decoded.size),
    async addStoredParts(name, info, parts) {
      const nameBytes = begin(name, [info.size]);
      if (!nameBytes.ok) return nameBytes;
      try {
        const localOffset = offset;
        await emit(localHeader(nameBytes.value, ZIP_STORED, info.crc >>> 0, info.size, info.size));
        let written = 0;
        let crc = 0;
        for await (const part of parts) {
          if (!part.ok) return part;
          crc = crc32(part.value, crc);
          written += part.value.length;
          await emit(part.value);
        }
        if (written !== info.size || crc !== info.crc >>> 0) {
          return err(BlobZipError({ message: `Entry "${name}" parts do not match the declared size/CRC; the archive is invalid.`, details: { reason: 'parts' } }));
        }
        names.add(name);
        entries.push({ name, nameBytes: nameBytes.value, method: ZIP_STORED, crc: info.crc >>> 0, compressedSize: info.size, size: info.size, localOffset });
        return ok();
      } catch (cause) {
        return err(toBlobError(cause, 'zip-write', name));
      }
    },
    async finish() {
      if (finished) return err(BlobInvalidInputError({ message: 'The zip writer is already finished.' }));
      finished = true;
      try {
        const start = offset;
        for (const entry of entries) {
          const header = new Uint8Array(46 + entry.nameBytes.length);
          const view = new DataView(header.buffer);
          view.setUint32(0, CENTRAL_SIG, true);
          view.setUint16(4, 20, true);
          view.setUint16(6, 20, true);
          view.setUint16(8, UTF8_FLAG, true);
          view.setUint16(10, entry.method, true);
          view.setUint16(12, stamp.time, true);
          view.setUint16(14, stamp.date, true);
          view.setUint32(16, entry.crc, true);
          view.setUint32(20, entry.compressedSize, true);
          view.setUint32(24, entry.size, true);
          view.setUint16(28, entry.nameBytes.length, true);
          view.setUint32(42, entry.localOffset, true);
          header.set(entry.nameBytes, 46);
          await emit(header);
        }
        const size = offset - start;
        if (offset >= MAX_U32) return err(BlobZipUnsupportedError({ message: 'The archive exceeds 4 GiB (zip64).' }));
        const end = new Uint8Array(22);
        const view = new DataView(end.buffer);
        view.setUint32(0, EOCD_SIG, true);
        view.setUint16(8, entries.length, true);
        view.setUint16(10, entries.length, true);
        view.setUint32(12, size, true);
        view.setUint32(16, start, true);
        await emit(end);
        return ok({ entries: entries.length, bytes: offset });
      } catch (cause) {
        return err(toBlobError(cause, 'zip-finish'));
      }
    },
  };
}

/** What the reader needs from a `File`/`Blob`. */
export interface BlobLike {
  readonly size: number;
  slice(start?: number, end?: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

export interface ZipReader {
  readonly entries: readonly ZipEntryInfo[];
  entry(name: string): ZipEntryInfo | undefined;
  /** The entry's payload exactly as stored (deflate-raw for method 8). */
  readStored(entry: ZipEntryInfo): Promise<Result<Uint8Array>>;
  /** Decoded content, CRC-checked (`SF-BLOB-011` on mismatch). */
  read(entry: ZipEntryInfo): Promise<Result<Uint8Array>>;
  /** A byte range of a STORED entry, read in place. */
  readRange(entry: ZipEntryInfo, range: BlobRange): Promise<Result<Uint8Array>>;
}

const zipError = (reason: string, message: string): Result<never> => err(BlobZipError({ message, details: { reason } }));

async function bytesOf(file: BlobLike, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

/** Open a zip in place: reads the end record and the central directory only. */
export async function openZip(file: BlobLike): Promise<Result<ZipReader>> {
  try {
    if (file.size < 22) return zipError('eocd', 'Too small to be a zip archive.');
    const tailStart = Math.max(0, file.size - 22 - 0xffff);
    const tail = await bytesOf(file, tailStart, file.size);
    const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let at = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tailView.getUint32(i, true) === EOCD_SIG) {
        at = i;
        break;
      }
    }
    if (at < 0) return zipError('eocd', 'No end of central directory record: not a zip archive (or truncated).');
    const disk = tailView.getUint16(at + 4, true);
    const cdDisk = tailView.getUint16(at + 6, true);
    const count = tailView.getUint16(at + 10, true);
    const cdSize = tailView.getUint32(at + 12, true);
    const cdOffset = tailView.getUint32(at + 16, true);
    if (disk !== 0 || cdDisk !== 0) return err(BlobZipUnsupportedError({ message: 'Multi-disk zip archives are not supported.' }));
    if (count === MAX_ENTRIES || cdSize === MAX_U32 || cdOffset === MAX_U32) return err(BlobZipUnsupportedError({ message: 'zip64 archives are not supported.' }));
    if (cdOffset + cdSize > file.size) return zipError('central-directory', 'The central directory lies outside the file (truncated?).');
    const cd = await bytesOf(file, cdOffset, cdOffset + cdSize);
    const view = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
    const entries: ZipEntryInfo[] = [];
    let offset = 0;
    for (let i = 0; i < count; i++) {
      if (offset + 46 > cd.length || view.getUint32(offset, true) !== CENTRAL_SIG) return zipError('central-directory', `Bad central directory entry ${i}.`);
      const flags = view.getUint16(offset + 8, true);
      const method = view.getUint16(offset + 10, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const name = fromUtf8(cd.subarray(offset + 46, offset + 46 + nameLength));
      if ((flags & 1) !== 0) return err(BlobZipUnsupportedError({ message: `Entry "${name}" is encrypted.` }));
      if (method !== ZIP_STORED && method !== ZIP_DEFLATE) return err(BlobZipUnsupportedError({ message: `Entry "${name}" uses compression method ${method}.` }));
      entries.push({
        name,
        method,
        crc: view.getUint32(offset + 16, true),
        compressedSize: view.getUint32(offset + 20, true),
        size: view.getUint32(offset + 24, true),
        localOffset: view.getUint32(offset + 42, true),
      });
      offset += 46 + nameLength + extraLength + commentLength;
    }
    const byName = new Map(entries.map((e) => [e.name, e]));

    const dataStart = async (entry: ZipEntryInfo): Promise<Result<number>> => {
      const header = await bytesOf(file, entry.localOffset, entry.localOffset + 30);
      const hv = new DataView(header.buffer, header.byteOffset, header.byteLength);
      if (header.length < 30 || hv.getUint32(0, true) !== LOCAL_SIG) return zipError('local-header', `Bad local header for "${entry.name}".`);
      const start = entry.localOffset + 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
      if (start + entry.compressedSize > file.size) return zipError('local-header', `Entry "${entry.name}" runs past the end of the file.`);
      return ok(start);
    };

    const reader: ZipReader = {
      entries,
      entry: (name) => byName.get(name),
      async readStored(entry) {
        const start = await dataStart(entry);
        if (!start.ok) return start;
        return ok(await bytesOf(file, start.value, start.value + entry.compressedSize));
      },
      async read(entry) {
        const stored = await reader.readStored(entry);
        if (!stored.ok) return stored;
        let decoded: Uint8Array;
        try {
          decoded = entry.method === ZIP_DEFLATE ? await inflateRaw(stored.value) : stored.value;
        } catch (cause) {
          return err(BlobZipError({ cause, message: `Entry "${entry.name}" does not inflate.`, details: { reason: 'inflate' } }));
        }
        if (decoded.length !== entry.size || crc32(decoded) !== entry.crc) return zipError('crc', `Entry "${entry.name}" fails its CRC/size check.`);
        return ok(decoded);
      },
      async readRange(entry, range) {
        if (entry.method !== ZIP_STORED) return err(BlobInvalidInputError({ message: `Range reads need a STORED entry; "${entry.name}" is deflated.` }));
        if (range.start < 0 || range.end < range.start || range.end > entry.size) {
          return err(BlobInvalidInputError({ message: `Range [${range.start}, ${range.end}) is outside [0, ${entry.size}).` }));
        }
        const start = await dataStart(entry);
        if (!start.ok) return start;
        return ok(await bytesOf(file, start.value + range.start, start.value + range.end));
      },
    };
    return ok(reader);
  } catch (cause) {
    return err(toBlobError(cause, 'zip-read'));
  }
}

/** Start an OCF-style bundle: `mimetype` first, STORED. */
export function writeBundleMimetype(zip: ZipWriter, mimetype: string): Promise<Result<void>> {
  if (zip.entries.length > 0) return Promise.resolve(err(BlobInvalidInputError({ message: '`mimetype` must be the first bundle entry.' })));
  return zip.addStored('mimetype', utf8(mimetype));
}

/** Check that a zip is a bundle of `mimetype` (`SF-BLOB-011` with reason `mimetype` otherwise). */
export async function checkBundleMimetype(zip: ZipReader, mimetype: string): Promise<Result<void>> {
  const first = zip.entries[0];
  if (first === undefined || first.name !== 'mimetype' || first.method !== ZIP_STORED) return zipError('mimetype', 'The first entry is not a STORED `mimetype`.');
  const content = await zip.read(first);
  if (!content.ok) return content;
  return fromUtf8(content.value) === mimetype ? ok() : zipError('mimetype', `The bundle type is "${fromUtf8(content.value).slice(0, 80)}", not "${mimetype}".`);
}

/**
 * Copy a blob into the zip without recompressing: a deflate-raw blob becomes
 * a method 8 entry with its stored bytes; others are STORED (chunked blobs
 * stream chunk by chunk). The content is verified against the digest first.
 */
export async function addBlobToZip(zip: ZipWriter, blobs: BlobStore, ref: BlobRef, name: string, signal?: AbortSignal): Promise<Result<void>> {
  const signalOption = signal === undefined ? {} : { signal };
  if (ref.chunked === true) {
    const stream = blobs.stream(ref, signalOption);
    if (!stream.ok) return stream;
    let crc = 0;
    let size = 0;
    const reader = stream.value.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        crc = crc32(value, crc);
        size += value.length;
      }
    } catch (cause) {
      return err(toBlobError(cause, 'zip-read-chunks', ref.digest));
    }
    const again = blobs.stream(ref, signalOption);
    if (!again.ok) return again;
    const parts = (async function* (): AsyncIterable<Result<Uint8Array>> {
      const r = again.value.getReader();
      for (;;) {
        try {
          const { done, value } = await r.read();
          if (done) return;
          yield ok(value);
        } catch (cause) {
          yield err(toBlobError(cause, 'zip-read-chunks', ref.digest));
          return;
        }
      }
    })();
    return zip.addStoredParts(name, { crc, size }, parts);
  }
  const stored = await blobs.get(ref.digest, signalOption);
  if (!stored.ok) return stored;
  if (ref.encoding === 'deflate-raw') {
    let decoded: Uint8Array;
    try {
      decoded = await inflateRaw(stored.value);
    } catch (cause) {
      return err(BlobZipError({ cause, message: `Blob ${ref.digest} does not inflate.`, details: { reason: 'inflate' } }));
    }
    if ((await sha256(decoded)) !== ref.digest) return err(BlobZipError({ message: `Blob ${ref.digest} does not match its digest.`, details: { reason: 'digest' } }));
    return zip.addDeflated(name, stored.value, { crc: crc32(decoded), size: decoded.length });
  }
  return zip.addStored(name, stored.value);
}

/**
 * Import a zip entry as the blob `ref` (deduped by digest). A deflated entry
 * for a deflate-raw blob is adopted as stored (no recompression); anything else
 * is decoded and put. The result must match `ref.digest` (`SF-BLOB-002`).
 */
export async function importZipBlob(zip: ZipReader, entry: ZipEntryInfo, blobs: BlobStore, ref: BlobRef, signal?: AbortSignal): Promise<Result<BlobRef>> {
  const signalOption = signal === undefined ? {} : { signal };
  const present = await blobs.has(ref.digest, signalOption);
  if (!present.ok) return present;
  if (present.value) return ok(ref);
  if (entry.method === ZIP_DEFLATE && ref.encoding === 'deflate-raw' && ref.chunked !== true) {
    const stored = await zip.readStored(entry);
    if (!stored.ok) return stored;
    return blobs.putEncoded(stored.value, ref, signalOption);
  }
  const decoded = await zip.read(entry);
  if (!decoded.ok) return decoded;
  const put = await blobs.put(decoded.value, {
    mime: ref.mime,
    ...(ref.encoding === undefined ? {} : { encoding: ref.encoding }),
    ...signalOption,
  });
  if (!put.ok) return put;
  if (put.value.digest !== ref.digest) {
    return err(BlobZipError({ message: `Entry "${entry.name}" holds ${put.value.digest}, not ${ref.digest}.`, details: { reason: 'digest' } }));
  }
  return ok(put.value);
}

/** Collect a zip into one buffer (tests, small bundles). */
export function createArraySink(): ZipSink & { bytes(): Uint8Array<ArrayBuffer> } {
  const parts: Uint8Array[] = [];
  return {
    write(chunk) {
      parts.push(chunk.slice());
    },
    bytes: () => concatBytes(parts),
  };
}
