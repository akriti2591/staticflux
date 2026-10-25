/**
 * `VideoFrame` and `AudioData` fakes with **close accounting** — groundwork for the media fakes
 * (M3 adds decoders, `AudioContext` and a media clock on top).
 *
 * WebCodecs frames hold scarce decoder/GPU memory until `close()`; a leaked frame stalls a decoder
 * after a handful of frames. Every handle the fakes create (constructor or `clone()`) is tracked;
 * `media.expectAllClosed()` throws SF-TEST-015 listing the leaks. Behaviour follows the WebCodecs spec
 * where tests can observe it: `clone()` shares the resource but is its own handle; after `close()`
 * `format` is `null`, sizes are 0, and `clone` / `copyTo` / `allocationSize` throw `InvalidStateError`;
 * closing twice is a no-op.
 *
 * Scope (M1): buffer-backed frames in RGBA/RGBX/BGRA/BGRX, I420, I420A, I422, I444 and NV12 with tight
 * plane layouts; `copyTo` without `rect`/`layout`/`format` conversion. AudioData in every sample format,
 * interleaved and planar, `copyTo` with `planeIndex`, `frameOffset`, `frameCount` (no format conversion).
 * Unsupported options reject/throw `NotSupportedError` so a test never silently gets wrong bytes.
 *
 * Nothing patches globals: pass `media.VideoFrame` to code under test, or `vi.stubGlobal('VideoFrame', media.VideoFrame)`.
 */
import { MediaLeakError } from './errors.js';

export interface MediaHandleInfo {
  readonly kind: 'VideoFrame' | 'AudioData';
  /** Creation order across both kinds, from 1. */
  readonly seq: number;
  readonly timestamp: number;
  /** `seq` of the handle this was cloned from, if any. */
  readonly clonedFrom: number | undefined;
  /** Optional test label (`media.label(frame, 'decoded #3')`). */
  readonly label: string | undefined;
}

export interface MediaStats {
  readonly created: number;
  readonly closed: number;
  readonly open: number;
  /** Most handles open at once. */
  readonly peakOpen: number;
}

export interface FakeVideoFrameConstructor {
  new (data: AllowSharedBufferSource, init: VideoFrameBufferInit): VideoFrame;
  new (source: VideoFrame, init?: VideoFrameInit): VideoFrame;
}

export interface FakeAudioDataConstructor {
  new (init: AudioDataInit): AudioData;
}

export interface MediaFakes {
  readonly VideoFrame: FakeVideoFrameConstructor;
  readonly AudioData: FakeAudioDataConstructor;
  /** Handles not yet closed, in creation order. */
  open(): readonly MediaHandleInfo[];
  stats(): MediaStats;
  /** Throws SF-TEST-015 when any handle is still open. */
  expectAllClosed(): void;
  /** Attach a label to a handle for leak reports. */
  label(handle: VideoFrame | AudioData, label: string): void;
  /** True when this fake created the handle and it is closed. */
  isClosed(handle: VideoFrame | AudioData): boolean;
}

interface Plane {
  readonly width: number;
  readonly height: number;
  readonly bytesPerSample: number;
}

/** Plane geometry of a pixel format (tight layout, chroma rounded up). */
export function videoPlanes(format: VideoPixelFormat, width: number, height: number): readonly Plane[] {
  const cw = Math.ceil(width / 2);
  const ch = Math.ceil(height / 2);
  switch (format) {
    case 'RGBA':
    case 'RGBX':
    case 'BGRA':
    case 'BGRX':
      return [{ width, height, bytesPerSample: 4 }];
    case 'I420':
      return [
        { width, height, bytesPerSample: 1 },
        { width: cw, height: ch, bytesPerSample: 1 },
        { width: cw, height: ch, bytesPerSample: 1 },
      ];
    case 'I420A':
      return [
        { width, height, bytesPerSample: 1 },
        { width: cw, height: ch, bytesPerSample: 1 },
        { width: cw, height: ch, bytesPerSample: 1 },
        { width, height, bytesPerSample: 1 },
      ];
    case 'I422':
      return [
        { width, height, bytesPerSample: 1 },
        { width: cw, height, bytesPerSample: 1 },
        { width: cw, height, bytesPerSample: 1 },
      ];
    case 'I444':
      return [
        { width, height, bytesPerSample: 1 },
        { width, height, bytesPerSample: 1 },
        { width, height, bytesPerSample: 1 },
      ];
    case 'NV12':
      return [
        { width, height, bytesPerSample: 1 },
        { width: cw, height: ch, bytesPerSample: 2 },
      ];
  }
  throw new DOMException(`Pixel format "${String(format)}" is not supported by the fake.`, 'NotSupportedError');
}

const SAMPLE_BYTES: Readonly<Record<AudioSampleFormat, number>> = {
  u8: 1,
  'u8-planar': 1,
  s16: 2,
  's16-planar': 2,
  s32: 4,
  's32-planar': 4,
  f32: 4,
  'f32-planar': 4,
};

function bytesOf(source: AllowSharedBufferSource): Uint8Array {
  return ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new Uint8Array(source);
}

function invalidState(what: string): DOMException {
  return new DOMException(`${what} is closed.`, 'InvalidStateError');
}

function rect(x: number, y: number, width: number, height: number): DOMRectReadOnly {
  return {
    x,
    y,
    width,
    height,
    top: y,
    left: x,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({ x, y, width, height }),
  };
}

function colorSpace(init: VideoColorSpaceInit | undefined): VideoColorSpace {
  const value: VideoColorSpaceInit = {
    primaries: init?.primaries ?? null,
    transfer: init?.transfer ?? null,
    matrix: init?.matrix ?? null,
    fullRange: init?.fullRange ?? null,
  };
  return {
    primaries: value.primaries ?? null,
    transfer: value.transfer ?? null,
    matrix: value.matrix ?? null,
    fullRange: value.fullRange ?? null,
    toJSON: () => ({ ...value }),
  };
}

export function createMediaFakes(): MediaFakes {
  let seq = 0;
  let created = 0;
  let closed = 0;
  let peakOpen = 0;
  const openHandles = new Map<object, { info: MediaHandleInfo; label: string | undefined }>();
  const closedHandles = new WeakSet<object>();

  const register = (handle: object, kind: MediaHandleInfo['kind'], timestamp: number, clonedFrom: object | undefined): number => {
    const id = ++seq;
    created++;
    const parent = clonedFrom === undefined ? undefined : openHandles.get(clonedFrom)?.info.seq;
    openHandles.set(handle, { info: { kind, seq: id, timestamp, clonedFrom: parent, label: undefined }, label: undefined });
    peakOpen = Math.max(peakOpen, openHandles.size);
    return id;
  };
  const release = (handle: object): void => {
    if (!openHandles.delete(handle)) return;
    closed++;
    closedHandles.add(handle);
  };

  interface VideoResource {
    readonly bytes: Uint8Array;
    readonly format: VideoPixelFormat;
    readonly codedWidth: number;
    readonly codedHeight: number;
    readonly colorSpace: VideoColorSpaceInit | undefined;
  }

  class FakeVideoFrame implements VideoFrame {
    #resource: VideoResource | null;
    #displayWidth: number;
    #displayHeight: number;
    #visible: { x: number; y: number; width: number; height: number };
    readonly timestamp: number;
    readonly duration: number | null;

    constructor(source: AllowSharedBufferSource | VideoFrame, init?: VideoFrameBufferInit | VideoFrameInit) {
      if (source instanceof FakeVideoFrame) {
        const parent = source.#resource;
        if (parent === null) throw invalidState('Source VideoFrame');
        const frameInit = (init ?? {}) as VideoFrameInit;
        this.#resource = parent;
        const visible = frameInit.visibleRect;
        this.#visible = visible === undefined ? { ...source.#visible } : { x: visible.x ?? 0, y: visible.y ?? 0, width: visible.width ?? 0, height: visible.height ?? 0 };
        this.#displayWidth = frameInit.displayWidth ?? (visible === undefined ? source.#displayWidth : this.#visible.width);
        this.#displayHeight = frameInit.displayHeight ?? (visible === undefined ? source.#displayHeight : this.#visible.height);
        this.timestamp = frameInit.timestamp ?? source.timestamp;
        this.duration = frameInit.duration ?? source.duration;
        register(this, 'VideoFrame', this.timestamp, source);
        return;
      }
      if (typeof source !== 'object' || source === null || !(ArrayBuffer.isView(source) || source instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && source instanceof SharedArrayBuffer))) {
        throw new TypeError('The VideoFrame fake supports buffer sources and other fake VideoFrames only (not canvas/image sources).');
      }
      const bufferInit = init as VideoFrameBufferInit | undefined;
      if (bufferInit === undefined || typeof bufferInit.format !== 'string') throw new TypeError('VideoFrame(buffer, init) needs init.format, codedWidth, codedHeight and timestamp.');
      const { format, codedWidth, codedHeight, timestamp } = bufferInit;
      if (!Number.isInteger(codedWidth) || !Number.isInteger(codedHeight) || codedWidth <= 0 || codedHeight <= 0) throw new TypeError(`Invalid coded size ${codedWidth}×${codedHeight}.`);
      if (bufferInit.layout !== undefined) throw new DOMException('VideoFrame fake: custom plane layouts are not supported yet (M3).', 'NotSupportedError');
      const needed = videoPlanes(format, codedWidth, codedHeight).reduce((n, p) => n + p.width * p.height * p.bytesPerSample, 0);
      const bytes = bytesOf(source);
      if (bytes.byteLength < needed) throw new TypeError(`VideoFrame data is ${bytes.byteLength} bytes; ${format} ${codedWidth}×${codedHeight} needs ${needed}.`);
      this.#resource = { bytes: bytes.slice(0, needed), format, codedWidth, codedHeight, colorSpace: bufferInit.colorSpace };
      const visible = bufferInit.visibleRect;
      this.#visible = visible === undefined ? { x: 0, y: 0, width: codedWidth, height: codedHeight } : { x: visible.x ?? 0, y: visible.y ?? 0, width: visible.width ?? 0, height: visible.height ?? 0 };
      this.#displayWidth = bufferInit.displayWidth ?? this.#visible.width;
      this.#displayHeight = bufferInit.displayHeight ?? this.#visible.height;
      this.timestamp = timestamp;
      this.duration = bufferInit.duration ?? null;
      register(this, 'VideoFrame', timestamp, undefined);
    }

    get format(): VideoPixelFormat | null {
      return this.#resource?.format ?? null;
    }
    get codedWidth(): number {
      return this.#resource?.codedWidth ?? 0;
    }
    get codedHeight(): number {
      return this.#resource?.codedHeight ?? 0;
    }
    get codedRect(): DOMRectReadOnly | null {
      return this.#resource === null ? null : rect(0, 0, this.#resource.codedWidth, this.#resource.codedHeight);
    }
    get visibleRect(): DOMRectReadOnly | null {
      return this.#resource === null ? null : rect(this.#visible.x, this.#visible.y, this.#visible.width, this.#visible.height);
    }
    get displayWidth(): number {
      return this.#resource === null ? 0 : this.#displayWidth;
    }
    get displayHeight(): number {
      return this.#resource === null ? 0 : this.#displayHeight;
    }
    get colorSpace(): VideoColorSpace {
      return colorSpace(this.#resource?.colorSpace);
    }

    allocationSize(options?: VideoFrameCopyToOptions): number {
      const resource = this.#live('allocationSize');
      unsupportedCopyOptions(options);
      return resource.bytes.byteLength;
    }

    async copyTo(destination: AllowSharedBufferSource, options?: VideoFrameCopyToOptions): Promise<PlaneLayout[]> {
      const resource = this.#resource;
      if (resource === null) throw invalidState('VideoFrame');
      unsupportedCopyOptions(options);
      const target = bytesOf(destination);
      if (target.byteLength < resource.bytes.byteLength) throw new TypeError(`copyTo destination is ${target.byteLength} bytes; ${resource.bytes.byteLength} needed.`);
      target.set(resource.bytes);
      const layouts: PlaneLayout[] = [];
      let offset = 0;
      for (const plane of videoPlanes(resource.format, resource.codedWidth, resource.codedHeight)) {
        const stride = plane.width * plane.bytesPerSample;
        layouts.push({ offset, stride });
        offset += stride * plane.height;
      }
      return layouts;
    }

    clone(): VideoFrame {
      this.#live('clone');
      return new FakeVideoFrame(this);
    }

    close(): void {
      this.#resource = null;
      release(this);
    }

    #live(method: string): VideoResource {
      if (this.#resource === null) throw invalidState(`VideoFrame (${method})`);
      return this.#resource;
    }
  }

  interface AudioResource {
    readonly bytes: Uint8Array;
    readonly format: AudioSampleFormat;
    readonly sampleRate: number;
    readonly numberOfFrames: number;
    readonly numberOfChannels: number;
  }

  class FakeAudioData implements AudioData {
    #resource: AudioResource | null;
    readonly timestamp: number;

    constructor(init: AudioDataInit | { readonly clone: FakeAudioData }) {
      if ('clone' in init) {
        const parent = init.clone.#resource;
        if (parent === null) throw invalidState('Source AudioData');
        this.#resource = parent;
        this.timestamp = init.clone.timestamp;
        register(this, 'AudioData', this.timestamp, init.clone);
        return;
      }
      const { format, sampleRate, numberOfFrames, numberOfChannels, timestamp } = init;
      if (!(format in SAMPLE_BYTES)) throw new TypeError(`Unknown sample format "${String(format)}".`);
      if (!(sampleRate > 0) || !Number.isInteger(numberOfFrames) || numberOfFrames <= 0 || !Number.isInteger(numberOfChannels) || numberOfChannels <= 0) {
        throw new TypeError('AudioData needs sampleRate > 0 and positive integer numberOfFrames and numberOfChannels.');
      }
      const needed = numberOfFrames * numberOfChannels * SAMPLE_BYTES[format];
      const bytes = bytesOf(init.data);
      if (bytes.byteLength < needed) throw new TypeError(`AudioData data is ${bytes.byteLength} bytes; ${numberOfChannels} ch × ${numberOfFrames} frames of ${format} needs ${needed}.`);
      this.#resource = { bytes: bytes.slice(0, needed), format, sampleRate, numberOfFrames, numberOfChannels };
      this.timestamp = timestamp;
      register(this, 'AudioData', timestamp, undefined);
    }

    get format(): AudioSampleFormat | null {
      return this.#resource?.format ?? null;
    }
    get sampleRate(): number {
      return this.#resource?.sampleRate ?? 0;
    }
    get numberOfFrames(): number {
      return this.#resource?.numberOfFrames ?? 0;
    }
    get numberOfChannels(): number {
      return this.#resource?.numberOfChannels ?? 0;
    }
    /** Microseconds, floored: `numberOfFrames / sampleRate × 10⁶`. */
    get duration(): number {
      const r = this.#resource;
      return r === null ? 0 : Math.floor((r.numberOfFrames * 1_000_000) / r.sampleRate);
    }

    allocationSize(options: AudioDataCopyToOptions): number {
      return this.#plan(options, 'allocationSize').length;
    }

    copyTo(destination: AllowSharedBufferSource, options: AudioDataCopyToOptions): void {
      const plan = this.#plan(options, 'copyTo');
      const target = bytesOf(destination);
      if (target.byteLength < plan.length) throw new RangeError(`copyTo destination is ${target.byteLength} bytes; ${plan.length} needed.`);
      target.set(this.#resource!.bytes.subarray(plan.start, plan.start + plan.length));
    }

    clone(): AudioData {
      if (this.#resource === null) throw invalidState('AudioData (clone)');
      return new FakeAudioData({ clone: this });
    }

    close(): void {
      this.#resource = null;
      release(this);
    }

    #plan(options: AudioDataCopyToOptions, method: string): { start: number; length: number } {
      const r = this.#resource;
      if (r === null) throw invalidState(`AudioData (${method})`);
      if (options.format !== undefined && options.format !== r.format) {
        throw new DOMException(`AudioData fake: conversion from ${r.format} to ${options.format} is not supported yet (M3).`, 'NotSupportedError');
      }
      const planar = r.format.endsWith('-planar');
      const planes = planar ? r.numberOfChannels : 1;
      if (!Number.isInteger(options.planeIndex) || options.planeIndex < 0 || options.planeIndex >= planes) {
        throw new RangeError(`planeIndex ${options.planeIndex} is out of range (${planes} plane${planes === 1 ? '' : 's'}).`);
      }
      const frameOffset = options.frameOffset ?? 0;
      if (frameOffset >= r.numberOfFrames) throw new RangeError(`frameOffset ${frameOffset} ≥ numberOfFrames ${r.numberOfFrames}.`);
      const frameCount = options.frameCount ?? r.numberOfFrames - frameOffset;
      if (frameOffset + frameCount > r.numberOfFrames) throw new RangeError(`frameOffset + frameCount exceeds numberOfFrames ${r.numberOfFrames}.`);
      const sample = SAMPLE_BYTES[r.format];
      const frameBytes = planar ? sample : sample * r.numberOfChannels;
      const planeStart = planar ? options.planeIndex * r.numberOfFrames * sample : 0;
      return { start: planeStart + frameOffset * frameBytes, length: frameCount * frameBytes };
    }
  }

  return {
    VideoFrame: FakeVideoFrame as unknown as FakeVideoFrameConstructor,
    AudioData: FakeAudioData as unknown as FakeAudioDataConstructor,
    open() {
      return [...openHandles.values()].map(({ info, label }) => ({ ...info, label }));
    },
    stats() {
      return { created, closed, open: openHandles.size, peakOpen };
    },
    expectAllClosed() {
      if (openHandles.size === 0) return;
      const open = [...openHandles.values()].map(({ info, label }) => ({ ...info, label }));
      const list = open.map((h) => `${h.kind} #${h.seq} (t=${h.timestamp}${h.clonedFrom === undefined ? '' : `, clone of #${h.clonedFrom}`}${h.label === undefined ? '' : `, ${h.label}`})`).join(', ');
      throw MediaLeakError({ message: `${open.length} media handle(s) left open: ${list}.`, details: { open } });
    },
    label(handle, label) {
      const entry = openHandles.get(handle);
      if (entry !== undefined) entry.label = label;
    },
    isClosed(handle) {
      return closedHandles.has(handle);
    },
  };
}

function unsupportedCopyOptions(options: VideoFrameCopyToOptions | undefined): void {
  if (options === undefined) return;
  if (options.rect !== undefined || options.layout !== undefined || options.format !== undefined || options.colorSpace !== undefined) {
    throw new DOMException('VideoFrame fake: copyTo/allocationSize options (rect, layout, format, colorSpace) are not supported yet (M3).', 'NotSupportedError');
  }
}
