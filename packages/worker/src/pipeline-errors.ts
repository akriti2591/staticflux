/**
 * Error catalog for the editor ↔ render pipeline plumbing (SF-Δ17–Δ19): regions,
 * seqlock and clock cells, record rings, delta streams, the blob side channel,
 * handle channels and peer channels. Codes continue the `SF-WK-*` series.
 */
import { defineError } from '@staticflux/core';

export const PipeMismatchError = defineError(
  'SF-WK-032',
  'invariant',
  'A pipe endpoint does not match the definition it is attached with (id, format version, schema version or size).',
  'Attach with the same `define…()` value the writer used and deploy both bundles together; bump `version` on breaking layout changes.',
);

export const PipeClosedError = defineError(
  'SF-WK-033',
  'aborted',
  'The pipe (cell, ring, delta stream or side channel) was closed.',
  'Expected during shutdown or respawn. Create a new pipe and re-send its endpoint when the peer reconnects (`peer.onConnect`).',
);

export const DeltaOrderError = defineError(
  'SF-WK-034',
  'invariant',
  'A delta record was appended with a version that does not increase.',
  'Append deltas in increasing `version` order (one per applied transaction); start a new epoch with `snapshot()` after a reset.',
);

export const RecordTooLargeError = defineError(
  'SF-WK-035',
  'validation',
  'A record is larger than the pipe can hold.',
  'Raise `capacityBytes` (records may use at most half of it), or move large payloads to the blob side channel and reference them by digest.',
);

export const PipeOverflowError = defineError(
  'SF-WK-036',
  'quota',
  'The writer queue overflowed because the reader stopped consuming; queued records were dropped.',
  'Lossless pipes queue under back-pressure up to `maxPendingBytes`/`maxPending`. Delta streams recover with a resnapshot; check that the reader is alive and drains every frame.',
);

export const HandleReleasedError = defineError(
  'SF-WK-037',
  'invariant',
  'A transferable handle was used after it was sent, released or closed.',
  'After `send()` the handle belongs to the receiver. Keep using only handles you still own (`owned.closed === false`).',
);

export const HandleLeakError = defineError(
  'SF-WK-038',
  'invariant',
  'A closeable handle (VideoFrame, AudioData, ImageBitmap) was dropped or its owner disposed without closing it.',
  'Call `owned.close()` when done, or dispose the ledger scope that owns it. Leaked GPU/decoder memory stalls decoders.',
);

export const UnsupportedHandleError = defineError(
  'SF-WK-039',
  'validation',
  'The value is not a handle kind this channel accepts.',
  'Send only the kinds declared in `defineHandleChannel({ kinds })` (video-frame, audio-data, image-bitmap, offscreen-canvas, file-system-handle); ArrayBuffers go through a data channel.',
);

export const PeerNotConnectedError = defineError(
  'SF-WK-040',
  'unavailable',
  'The peer channel is not connected (the other worker is starting or respawning).',
  'Wait with `peer.whenConnected(signal)` or pass `{ waitForConnection: true }`; re-send state in `peer.onConnect` after a re-wire.',
);

export const BlobGoneError = defineError(
  'SF-WK-041',
  'not-found',
  'A content-addressed blob referenced by a record is no longer available on either side.',
  'The reader resnapshots automatically. Raise the sender `retainBytes` / receiver `budgetBytes` if this happens during normal editing.',
);

export const PipeEndpointTakenError = defineError(
  'SF-WK-042',
  'invariant',
  'A pipe endpoint was requested or attached twice (each reader index or message endpoint has exactly one reader).',
  'Create one endpoint per reader (`ring.endpoint(i)` with distinct `i`); a respawned reader needs a fresh endpoint or a new pipe.',
);
