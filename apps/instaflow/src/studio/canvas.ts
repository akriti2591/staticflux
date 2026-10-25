/**
 * The canvas region's port: Studio mounts the A7 editor and render modules behind it (D15). The shell
 * hands the port its surface element; the port boots the editor ↔ render pipeline and forwards the
 * surface's pointer, wheel and key input into the editor's input ring. Studio never touches the modules:
 * a fake renderer (the digest renderer) or Vello sits behind the `RenderPort` the boot settings name.
 *
 * @example
 * const canvas = sequencingCanvas({ boot: (signal) => bootSequencing({ settings, spawn, scene, peer, signal }) });
 * studioElement.canvas = canvas;
 */
import { err, ok, type Result } from '@staticflux/core';
import { createInputForwarder, type InputForwarder, type InputTarget } from '@staticflux/surface';
import { inputRingSink } from '@staticflux/surface/input-ring';
import type { SequencingSession } from '../sequencing/boot.js';
import { CanvasStartError } from '../spec/errors.js';

export interface CanvasSession {
  /** Input samples forwarded to the editor so far. */
  readonly forwarded: number;
  stop(): Promise<void>;
}

export interface CanvasPort {
  /** Start on `surface` (a focusable element inside the canvas region). */
  start(surface: InputTarget, signal: AbortSignal): Promise<Result<CanvasSession>>;
}

export interface SequencingCanvasOptions {
  /** Boot the pipeline (`bootSequencing` with the app's spawner and render port). */
  readonly boot: (signal: AbortSignal) => Promise<Result<SequencingSession>>;
  readonly env?: { readonly now: () => number; readonly timeOrigin: number };
  /** Flush scheduling for the forwarder (default microtask). */
  readonly schedule?: (flush: () => void) => void;
}

const defaultEnv = { now: () => performance.now(), timeOrigin: performance.timeOrigin };

/** A canvas port over the A7 sequencing pipeline. Boot failures are IF-SPEC-005 (cause: IF-SEQ-001). */
export function sequencingCanvas(options: SequencingCanvasOptions): CanvasPort {
  return {
    async start(surface, signal) {
      const booted = await options.boot(signal);
      if (!booted.ok) return err(CanvasStartError({ cause: booted.error, details: { cause: booted.error.code } }));
      const session = booted.value;
      if (signal.aborted) {
        await session.stop();
        return err(CanvasStartError({ details: { cause: 'aborted' } }));
      }
      const forwarder: InputForwarder = createInputForwarder({
        target: surface,
        env: options.env ?? defaultEnv,
        sinks: [inputRingSink(session.input)],
        captureWheel: true,
        ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
      });
      let stopped = false;
      const stop = async (): Promise<void> => {
        if (stopped) return;
        stopped = true;
        forwarder.dispose();
        await session.stop();
      };
      signal.addEventListener('abort', () => void stop(), { once: true });
      return ok({
        get forwarded() {
          return forwarder.forwarded;
        },
        stop,
      });
    },
  };
}
