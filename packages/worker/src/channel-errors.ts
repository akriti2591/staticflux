/**
 * Error catalog for worker channels (R11.17–R11.19): binary layouts, data
 * channels (transferables) and frame channels (ring buffers / double-buffered
 * transfer). Codes continue the `SF-WK-*` series.
 */
import { defineError } from '@staticflux/core';

export const LayoutInvalidError = defineError(
  'SF-WK-019',
  'validation',
  'A binary layout declaration is invalid (bad field name, type, count or alignment).',
  'Use identifier field names, one of the scalar types (f32 f64 i8 u8 i16 u16 i32 u32 i64 u64), integer `count` ≥ 1 and a power-of-two `align`.',
);

export const LayoutViewError = defineError(
  'SF-WK-020',
  'validation',
  'A layout view does not fit its buffer (misaligned byte offset, buffer too small, or big-endian platform).',
  'Allocate the buffer with `layout.byteLength(count)` / `columnsByteLength(...)` and pass a byteOffset that is a multiple of `layout.align` (Wasm: allocate with that alignment).',
);

export const BufferDetachedError = defineError(
  'SF-WK-021',
  'invariant',
  'An ArrayBuffer was used after its ownership was transferred to another thread (it is detached).',
  'After `send()` the buffer belongs to the receiver. Allocate a new buffer, or wait for the receiver to transfer it back.',
);

export const NotTransferableError = defineError(
  'SF-WK-022',
  'validation',
  'A data-channel buffer is not transferable (SharedArrayBuffer, duplicate entry, or not an ArrayBuffer).',
  'Data channels move ArrayBuffers; share memory through a frame channel / ring buffer instead, and list each buffer once.',
);

export const FrameTooLargeError = defineError(
  'SF-WK-023',
  'validation',
  'A frame is larger than the frame channel slot size.',
  'Raise `frameBytes` in the frame channel definition (layout.byteLength(maxCount)), or split the frame.',
);

export const FrameChannelClosedError = defineError(
  'SF-WK-024',
  'aborted',
  'The frame channel was closed.',
  'Expected during shutdown/respawn. Reconnect the consumer with `connectFrameConsumer()` after the producer reopens.',
);

export const SharedMemoryUnavailableError = defineError(
  'SF-WK-025',
  'unavailable',
  'Shared memory was required, but the page is not cross-origin isolated (or SharedArrayBuffer/Atomics are missing).',
  'Serve the app with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`), or drop `require: "shared"` so the transfer fallback is used.',
);

export const FrameChannelMismatchError = defineError(
  'SF-WK-026',
  'invariant',
  'The frame channel producer and consumer disagree (different id, frame size, or unknown ring buffer format).',
  'Use the same `defineFrameChannel(...)` definition on both sides and deploy both bundles together.',
);
