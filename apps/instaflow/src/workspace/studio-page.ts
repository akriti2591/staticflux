/**
 * The Studio page's boot (issue #62): the frame first, then the session. `dev/studio/main.ts` calls it with the page's
 * container, its status line (`#boot`) and how to open the session (`openStudioSession` over the local workspace).
 *
 * 1. `mountStudioFrame` renders the Studio frame at once (inert, placeholders where the engine and the document go).
 * 2. Once the frame is laid out, `open()` runs (workspace stores, workers, Wasm, fonts, document); the frame stays
 *    until it settles.
 * 3. The frame is disposed, then exactly one of:
 *    - the session opened: the app mounts in the same container and the status line goes;
 *    - the design is not on this device (`UnknownDesignError`): `missing(details)` (NAVIGATION §4) and the status goes;
 *    - anything else failed (an error result or a throw): the status line says "Studio could not start: …" as an alert.
 */
import { isSfError, type Result } from '@staticflux/core';
import { mountStudioFrame, type StudioFrame, type StudioFrameOptions } from '../app/studio-frame.js';
import { UnknownDesignError } from '../home/errors.js';
import type { StudioSession } from './studio-session.js';

export interface StudioPageOptions {
  /** Where the frame, then the app (or the missing-design page) renders. */
  readonly container: HTMLElement;
  /** The page's status line: the loading text, then the failure (`role="alert"`). */
  readonly status: HTMLElement;
  /** Open the session; a throw counts as a failure. */
  readonly open: () => Promise<Result<StudioSession>>;
  /** The design is not here (or is in the trash): show the missing-design page in the container. */
  readonly missing: (details: Readonly<Record<string, unknown>>) => void;
  readonly frame?: StudioFrameOptions;
}

/** What the status line says when Studio cannot start: an error result's code, message and cause; a throw's message. */
export function bootFailureText(failure: unknown): string {
  if (!isSfError(failure)) return `Studio could not start: ${failure instanceof Error ? failure.message : String(failure)}`;
  const cause = failure.cause instanceof Error ? ` (${failure.cause.message})` : '';
  return `Studio could not start: studio: ${failure.code} ${failure.message}${cause}`;
}

/** Boot the Studio page (see the module header). Resolves with the session, or undefined when it did not open. */
export async function bootStudioPage(options: StudioPageOptions): Promise<StudioSession | undefined> {
  const { container, status } = options;
  const framed = mountStudioFrame(container, options.frame);
  if (!framed.ok) console.warn(`[studio] the frame could not render: ${framed.error.code} ${framed.error.message}`);
  const frame: StudioFrame | undefined = framed.ok ? framed.value : undefined;
  // The frame's regions are laid out before the session starts (its module may block main while it loads).
  const laidOut = await frame?.opened;
  if (laidOut !== undefined && !laidOut.ok) console.warn(`[studio] the frame could not lay out: ${laidOut.error.code} ${laidOut.error.message}`);
  let opened: Result<StudioSession>;
  try {
    opened = await options.open();
  } catch (error) {
    await frame?.dispose();
    fail(status, error);
    return undefined;
  }
  // The frame leaves the DOM synchronously (its scope finishes after): the app renders in the same task, no blank paint.
  const closed = frame?.dispose();
  if (!opened.ok && opened.error.code === UnknownDesignError.code) {
    await closed;
    status.remove();
    options.missing(opened.error.details ?? {});
    return undefined;
  }
  if (!opened.ok) {
    await closed;
    fail(status, opened.error);
    return undefined;
  }
  opened.value.app.mount(container);
  status.remove();
  await closed;
  return opened.value;
}

function fail(status: HTMLElement, failure: unknown): void {
  status.textContent = bootFailureText(failure);
  status.setAttribute('role', 'alert');
  console.error(failure);
}
