import { describe, expect, it } from 'vitest';
import { createMediaFakes, videoPlanes } from './media-fake.js';

const rgbaInit = (w: number, h: number, timestamp = 0): VideoFrameBufferInit => ({ format: 'RGBA', codedWidth: w, codedHeight: h, timestamp });

describe('videoPlanes', () => {
  it('returns tight plane geometry with chroma rounded up', () => {
    expect(videoPlanes('RGBA', 3, 2)).toEqual([{ width: 3, height: 2, bytesPerSample: 4 }]);
    expect(videoPlanes('I420', 5, 3).map((p) => [p.width, p.height])).toEqual([
      [5, 3],
      [3, 2],
      [3, 2],
    ]);
    expect(videoPlanes('I420A', 2, 2)).toHaveLength(4);
    expect(videoPlanes('I422', 4, 2).map((p) => [p.width, p.height])).toEqual([
      [4, 2],
      [2, 2],
      [2, 2],
    ]);
    expect(videoPlanes('I444', 2, 2).every((p) => p.width === 2)).toBe(true);
    expect(videoPlanes('NV12', 4, 4)).toEqual([
      { width: 4, height: 4, bytesPerSample: 1 },
      { width: 2, height: 2, bytesPerSample: 2 },
    ]);
    expect(() => videoPlanes('P010' as VideoPixelFormat, 2, 2)).toThrow(expect.objectContaining({ name: 'NotSupportedError' }));
  });
});

describe('VideoFrame fake', () => {
  it('constructs from a buffer with WebCodecs-shaped properties', () => {
    const media = createMediaFakes();
    const frame = new media.VideoFrame(new Uint8Array(4 * 4 * 2), { ...rgbaInit(4, 2, 33_000), duration: 16_666, colorSpace: { primaries: 'bt709', fullRange: true } });
    expect([frame.format, frame.codedWidth, frame.codedHeight, frame.displayWidth, frame.displayHeight, frame.timestamp, frame.duration]).toEqual(['RGBA', 4, 2, 4, 2, 33_000, 16_666]);
    expect(frame.codedRect?.toJSON()).toEqual({ x: 0, y: 0, width: 4, height: 2 });
    expect(frame.visibleRect?.right).toBe(4);
    expect(frame.colorSpace.toJSON()).toEqual({ primaries: 'bt709', transfer: null, matrix: null, fullRange: true });
    expect(frame.allocationSize()).toBe(32);
    frame.close();
  });

  it('copies bytes out with plane layouts (I420)', async () => {
    const media = createMediaFakes();
    const data = Uint8Array.from({ length: 4 * 2 + 2 * 1 * 2 }, (_v, i) => i);
    const frame = new media.VideoFrame(data, { format: 'I420', codedWidth: 4, codedHeight: 2, timestamp: 0 });
    const out = new Uint8Array(frame.allocationSize());
    expect(await frame.copyTo(out)).toEqual([
      { offset: 0, stride: 4 },
      { offset: 8, stride: 2 },
      { offset: 10, stride: 2 },
    ]);
    expect([...out]).toEqual([...data]);
    await expect(frame.copyTo(new Uint8Array(3))).rejects.toBeInstanceOf(TypeError);
    await expect(frame.copyTo(out, { rect: { x: 0, y: 0, width: 2, height: 2 } })).rejects.toMatchObject({ name: 'NotSupportedError' });
    frame.close();
  });

  it('behaves like a closed frame after close(); close twice is a no-op', async () => {
    const media = createMediaFakes();
    const frame = new media.VideoFrame(new Uint8Array(16), rgbaInit(2, 2, 5));
    frame.close();
    frame.close();
    expect([frame.format, frame.codedWidth, frame.codedHeight, frame.displayWidth, frame.codedRect, frame.visibleRect, frame.timestamp]).toEqual([null, 0, 0, 0, null, null, 5]);
    expect(() => frame.clone()).toThrow(expect.objectContaining({ name: 'InvalidStateError' }));
    expect(() => frame.allocationSize()).toThrow(expect.objectContaining({ name: 'InvalidStateError' }));
    await expect(frame.copyTo(new Uint8Array(16))).rejects.toMatchObject({ name: 'InvalidStateError' });
    expect(() => new media.VideoFrame(frame)).toThrow(expect.objectContaining({ name: 'InvalidStateError' }));
    expect(media.stats()).toEqual({ created: 1, closed: 1, open: 0, peakOpen: 1 });
    expect(media.isClosed(frame)).toBe(true);
  });

  it('clones share the resource but are separate handles that must each be closed', async () => {
    const media = createMediaFakes();
    const frame = new media.VideoFrame(Uint8Array.of(1, 2, 3, 4), rgbaInit(1, 1, 7));
    const clone = frame.clone();
    frame.close();
    const out = new Uint8Array(4);
    await clone.copyTo(out);
    expect([...out]).toEqual([1, 2, 3, 4]);
    expect(media.open()).toEqual([{ kind: 'VideoFrame', seq: 2, timestamp: 7, clonedFrom: 1, label: undefined }]);
    clone.close();
    media.expectAllClosed();
  });

  it('constructs from another frame with overrides', () => {
    const media = createMediaFakes();
    const source = new media.VideoFrame(new Uint8Array(4 * 4 * 4), rgbaInit(4, 4, 10));
    const cropped = new media.VideoFrame(source, { timestamp: 20, visibleRect: { x: 1, y: 1, width: 2, height: 2 } });
    expect([cropped.timestamp, cropped.displayWidth, cropped.visibleRect?.x, cropped.codedWidth]).toEqual([20, 2, 1, 4]);
    const sized = new media.VideoFrame(source, { displayWidth: 8, displayHeight: 8, duration: 5 });
    expect([sized.displayWidth, sized.duration, sized.timestamp]).toEqual([8, 5, 10]);
    for (const f of [source, cropped, sized]) f.close();
    media.expectAllClosed();
  });

  it('rejects unsupported sources and malformed inits', () => {
    const media = createMediaFakes();
    expect(() => new media.VideoFrame({} as unknown as ArrayBuffer, rgbaInit(1, 1))).toThrow(TypeError);
    expect(() => new media.VideoFrame(new Uint8Array(4), { codedWidth: 1, codedHeight: 1, timestamp: 0 } as VideoFrameBufferInit)).toThrow(TypeError);
    expect(() => new media.VideoFrame(new Uint8Array(4), rgbaInit(0, 1))).toThrow(TypeError);
    expect(() => new media.VideoFrame(new Uint8Array(3), rgbaInit(1, 1))).toThrow('needs 4');
    expect(() => new media.VideoFrame(new Uint8Array(4), { ...rgbaInit(1, 1), layout: [{ offset: 0, stride: 4 }] })).toThrow(expect.objectContaining({ name: 'NotSupportedError' }));
    expect(media.stats().created).toBe(0);
  });
});

describe('AudioData fake', () => {
  const interleaved = (): AudioDataInit => ({ format: 's16', sampleRate: 48_000, numberOfFrames: 4, numberOfChannels: 2, timestamp: 1_000, data: Int16Array.of(1, -1, 2, -2, 3, -3, 4, -4) });

  it('exposes WebCodecs properties and a floored microsecond duration', () => {
    const media = createMediaFakes();
    const audio = new media.AudioData({ ...interleaved(), numberOfFrames: 3, data: new Int16Array(6), sampleRate: 44_100 });
    expect([audio.format, audio.sampleRate, audio.numberOfFrames, audio.numberOfChannels, audio.timestamp, audio.duration]).toEqual(['s16', 44_100, 3, 2, 1_000, 68]);
    audio.close();
    expect([audio.format, audio.sampleRate, audio.numberOfFrames, audio.duration]).toEqual([null, 0, 0, 0]);
  });

  it('copies interleaved data with frameOffset/frameCount; plane 0 only', () => {
    const media = createMediaFakes();
    const audio = new media.AudioData(interleaved());
    expect(audio.allocationSize({ planeIndex: 0 })).toBe(16);
    const out = new Int16Array(4);
    audio.copyTo(out, { planeIndex: 0, frameOffset: 1, frameCount: 2 });
    expect([...out]).toEqual([2, -2, 3, -3]);
    expect(() => audio.allocationSize({ planeIndex: 1 })).toThrow(RangeError);
    expect(() => audio.copyTo(new Int16Array(1), { planeIndex: 0 })).toThrow(RangeError);
    expect(() => audio.allocationSize({ planeIndex: 0, frameOffset: 4 })).toThrow(RangeError);
    expect(() => audio.allocationSize({ planeIndex: 0, frameOffset: 2, frameCount: 3 })).toThrow(RangeError);
    expect(() => audio.allocationSize({ planeIndex: 0, format: 'f32-planar' })).toThrow(expect.objectContaining({ name: 'NotSupportedError' }));
    audio.close();
  });

  it('copies one channel of planar data', () => {
    const media = createMediaFakes();
    const audio = new media.AudioData({ format: 'f32-planar', sampleRate: 8_000, numberOfFrames: 3, numberOfChannels: 2, timestamp: 0, data: Float32Array.of(0.1, 0.2, 0.3, -0.1, -0.2, -0.3) });
    const right = new Float32Array(3);
    audio.copyTo(right, { planeIndex: 1 });
    expect([...right].map((v) => Number(v.toFixed(2)))).toEqual([-0.1, -0.2, -0.3]);
    expect(audio.allocationSize({ planeIndex: 0, frameOffset: 1 })).toBe(8);
    audio.close();
  });

  it('clone, close accounting and use-after-close', () => {
    const media = createMediaFakes();
    const audio = new media.AudioData(interleaved());
    const clone = audio.clone();
    audio.close();
    expect(() => audio.clone()).toThrow(expect.objectContaining({ name: 'InvalidStateError' }));
    expect(() => audio.copyTo(new Int16Array(8), { planeIndex: 0 })).toThrow(expect.objectContaining({ name: 'InvalidStateError' }));
    expect(clone.numberOfFrames).toBe(4);
    expect(media.open().map((h) => [h.kind, h.clonedFrom])).toEqual([['AudioData', 1]]);
    clone.close();
    media.expectAllClosed();
  });

  it('rejects malformed inits', () => {
    const media = createMediaFakes();
    expect(() => new media.AudioData({ ...interleaved(), format: 'u12' as AudioSampleFormat })).toThrow(TypeError);
    expect(() => new media.AudioData({ ...interleaved(), sampleRate: 0 })).toThrow(TypeError);
    expect(() => new media.AudioData({ ...interleaved(), numberOfFrames: 1.5 })).toThrow(TypeError);
    expect(() => new media.AudioData({ ...interleaved(), data: new Int16Array(3) })).toThrow('needs 16');
  });
});

describe('close accounting', () => {
  it('expectAllClosed lists leaks with labels and clone parents (SF-TEST-015)', () => {
    const media = createMediaFakes();
    const frame = new media.VideoFrame(new Uint8Array(4), rgbaInit(1, 1, 40));
    const clone = frame.clone();
    media.label(clone, 'thumbnail');
    const audio = new media.AudioData({ format: 'u8', sampleRate: 8_000, numberOfFrames: 1, numberOfChannels: 1, timestamp: 9, data: new Uint8Array(1) });
    frame.close();
    expect(media.stats()).toEqual({ created: 3, closed: 1, open: 2, peakOpen: 3 });
    let thrown: unknown;
    try {
      media.expectAllClosed();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toMatchObject({ code: 'SF-TEST-015', message: '2 media handle(s) left open: VideoFrame #2 (t=40, clone of #1, thumbnail), AudioData #3 (t=9).' });
    expect((thrown as { details: { open: unknown[] } }).details.open).toHaveLength(2);
    expect(media.isClosed(clone)).toBe(false);
    clone.close();
    audio.close();
    media.expectAllClosed();
    expect(media.isClosed(clone)).toBe(true);
  });

  it('keeps separate accounts per createMediaFakes()', () => {
    const a = createMediaFakes();
    const b = createMediaFakes();
    const frame = new a.VideoFrame(new Uint8Array(4), rgbaInit(1, 1));
    b.expectAllClosed();
    expect(() => a.expectAllClosed()).toThrow(expect.objectContaining({ code: 'SF-TEST-015' }));
    frame.close();
  });
});
