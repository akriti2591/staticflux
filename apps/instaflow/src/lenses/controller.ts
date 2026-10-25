/**
 * The lens controller: the arrangement of the open composition under the current lens, the focused
 * page, and page navigation that moves the camera. It reads the current lens (reactive, e.g.
 * `() => studio.lens?.id`) and asks that lens's feature; switching lens re-arranges and refocuses the
 * current page (UX §4: selection persists across lenses). The camera itself belongs to the canvas
 * (A7 view state): the controller only asks the `CameraPort` to show a camera.
 *
 * Keyboard (`bindLensShortcuts`): PageDown / PageUp next and previous page, Mod+Home / Mod+End first and
 * last, Alt+0 fit everything; never while typing.
 */
import { defineShortcut, type ShortcutRegistry, type ShortcutScopeDef } from '@staticflux/a11y';
import { box, derived, err, ok, type Result, type Scope, type SfError, watch } from '@staticflux/core';
import type { NodeId } from '@staticflux/document/v2';
import type { LensContributionId } from '../spec/contributions.js';
import { UnknownPageError } from './errors.js';
import { type Camera, frameOf, type LensArrangement, type PageFrame, stepFrame, type Viewport } from './lens-feature.js';
import type { LensFeatureRegistry } from './lens-features.js';
import type { StructureFeed } from './structure.js';

export type CameraReason = 'focus' | 'overview';

/** Where cameras go (the canvas region's view state). */
export interface CameraPort {
  show(camera: Camera, reason: CameraReason): void;
}

export interface LensControllerOptions {
  readonly features: LensFeatureRegistry;
  /** The mounted lens (reactive). Undefined falls back to the registry's fallback lens. */
  readonly lens: () => LensContributionId | undefined;
  readonly structure: StructureFeed;
  readonly viewport: () => Viewport;
  readonly camera: CameraPort;
}

export interface LensController {
  /** The current arrangement (reactive); undefined when the part holds no composition (`error()` says why). */
  arrangement(): LensArrangement | undefined;
  error(): SfError | undefined;
  /** The focused page (reactive). */
  current(): NodeId | undefined;
  /** The last camera asked for (reactive). */
  camera(): Camera | undefined;
  goTo(page: NodeId): Result<PageFrame>;
  /** Move `delta` pages in the lens's navigation order (clamped). */
  step(delta: number): Result<PageFrame>;
  first(): Result<PageFrame>;
  last(): Result<PageFrame>;
  overview(): Result<Camera>;
  dispose(): void;
}

export function createLensController(options: LensControllerOptions): LensController {
  const version = box(0);
  const current = box<NodeId | undefined>(undefined);
  const camera = box<Camera | undefined>(undefined);
  const stopStructure = options.structure.observe(() => version.set(version.get() + 1));
  const lensId = (): LensContributionId => options.lens() ?? options.features.fallback;

  const state = derived((): { arrangement: LensArrangement | undefined; error: SfError | undefined } => {
    version.get();
    const read = options.structure.read();
    if (!read.ok) return { arrangement: undefined, error: read.error };
    return { arrangement: options.features.feature(lensId()).arrange(read.value), error: undefined };
  });

  const show = (next: Camera, reason: CameraReason): Camera => {
    camera.set(next);
    options.camera.show(next, reason);
    return next;
  };

  const focus = (frame: PageFrame | undefined, requested?: NodeId): Result<PageFrame> => {
    const { arrangement, error } = state.get();
    if (arrangement === undefined) return err(error ?? UnknownPageError());
    if (frame === undefined) return err(UnknownPageError({ details: { page: requested ?? null } }));
    current.set(frame.page);
    show(options.features.feature(lensId()).focus(frame, options.viewport(), camera.get()), 'focus');
    return ok(frame);
  };

  const overview = (): Result<Camera> => {
    const { arrangement, error } = state.get();
    if (arrangement === undefined) return err(error ?? UnknownPageError());
    return ok(show(options.features.feature(lensId()).overview(arrangement, options.viewport()), 'overview'));
  };

  // A lens switch re-arranges; keep the focused page in view under the new lens.
  const stopLens = watch(lensId, () => {
    const arrangement = state.get().arrangement;
    const page = current.get();
    const frame = arrangement === undefined || page === undefined ? undefined : frameOf(arrangement, page);
    if (frame !== undefined) void focus(frame);
    else if (arrangement !== undefined) void overview();
  });

  return {
    arrangement: () => state.get().arrangement,
    error: () => state.get().error,
    current: () => {
      const page = current.get();
      const arrangement = state.get().arrangement;
      return page !== undefined && arrangement !== undefined && frameOf(arrangement, page) !== undefined ? page : undefined;
    },
    camera: () => camera.get(),
    goTo: (page) => {
      const arrangement = state.get().arrangement;
      return focus(arrangement === undefined ? undefined : frameOf(arrangement, page), page);
    },
    step: (delta) => {
      const arrangement = state.get().arrangement;
      return focus(arrangement === undefined ? undefined : stepFrame(arrangement, current.get(), delta));
    },
    first: () => focus(state.get().arrangement?.frames[0]),
    last: () => {
      const frames = state.get().arrangement?.frames ?? [];
      return focus(frames[frames.length - 1]);
    },
    overview,
    dispose() {
      stopStructure();
      stopLens();
    },
  };
}

/** Page navigation shortcuts (data; registered for the lifetime of `scope`). */
export const LensShortcuts = Object.freeze({
  next: { id: 'instaflow/next-page', keys: ['PageDown'], description: 'Next page' },
  previous: { id: 'instaflow/previous-page', keys: ['PageUp'], description: 'Previous page' },
  first: { id: 'instaflow/first-page', keys: ['Mod+Home'], description: 'First page' },
  last: { id: 'instaflow/last-page', keys: ['Mod+End'], description: 'Last page' },
  overview: { id: 'instaflow/fit-all', keys: ['Alt+0'], description: 'Fit everything in view' },
} as const);

/** Register the page navigation shortcuts in `shortcutScope` (Studio's) until `scope` is disposed. */
export function bindLensShortcuts(registry: ShortcutRegistry, controller: LensController, options: { readonly scope: Scope; readonly shortcutScope: ShortcutScopeDef }): Result<void> {
  const run: Readonly<Record<keyof typeof LensShortcuts, () => unknown>> = {
    next: () => controller.step(1),
    previous: () => controller.step(-1),
    first: () => controller.first(),
    last: () => controller.last(),
    overview: () => controller.overview(),
  };
  for (const [name, def] of Object.entries(LensShortcuts) as [keyof typeof LensShortcuts, (typeof LensShortcuts)[keyof typeof LensShortcuts]][]) {
    const registered = registry.register(defineShortcut({ id: def.id, keys: [...def.keys], scope: options.shortcutScope, description: def.description, allowInInputs: false }), () => void run[name](), { scope: options.scope });
    if (!registered.ok) return registered;
  }
  return ok();
}
