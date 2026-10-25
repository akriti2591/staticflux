/**
 * The editor-side half of one tab's accessibility layer (B6, used by B9's editor worker): the projector, the polite
 * selection announcer and `describe`, with no DOM. The main thread mounts the snapshots it posts (`mountCanvasA11y`)
 * and turns a focused node back into a selection; `createCanvasA11y` wires both halves in one realm.
 */
import type { Announcer, Timers } from '@staticflux/a11y';
import { ok, type Result, type Scope } from '@staticflux/core';
import type { ViewState } from '../tools/view-state.js';
import { createSelectionAnnouncer, type SelectionAnnouncer } from './announce.js';
import { type DescribeTarget, describeCanvas } from './describe.js';
import { type CanvasProjector, createCanvasProjector, describeElement, type ProjectionInput } from './projection.js';

export interface CanvasA11yEditorOptions extends Omit<ProjectionInput, 'view'> {
  readonly view: ViewState;
  readonly announcer: Pick<Announcer, 'announce'>;
  readonly timers: Timers;
  /** B3's tool controller (announcements wait while `state` is not `idle`). */
  readonly gesture?: { readonly state: string };
  /** Coalesces projection flushes (default a microtask; `requestAnimationFrame` where there is one). */
  readonly schedule?: (flush: () => void) => void;
  readonly debounceMs?: number;
  /** The tab scope: everything is disposed with it (rule 5). */
  readonly scope: Pick<Scope, 'defer'>;
}

export interface CanvasA11yEditor {
  readonly projector: CanvasProjector;
  readonly announcer: SelectionAnnouncer;
  describe(what: DescribeTarget): Result<{ readonly text: string; readonly count: number }>;
  dispose(): void;
}

/** The projector (flushed once, so a first snapshot exists), the announcer and `describe` for one tab. */
export function createCanvasA11yEditor(options: CanvasA11yEditorOptions): Result<CanvasA11yEditor> {
  const projector = createCanvasProjector({ ...options, ...(options.schedule === undefined ? {} : { schedule: options.schedule }) });
  const first = projector.flush();
  if (!first.ok) {
    projector.dispose();
    return first;
  }
  const gesture = options.gesture;
  const announcer = createSelectionAnnouncer({
    view: options.view,
    describe: (n) => describeElement(options, n),
    announcer: options.announcer,
    timers: options.timers,
    ...(gesture === undefined ? {} : { busy: () => gesture.state !== 'idle' }),
    ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
  });
  let disposed = false;
  const side: CanvasA11yEditor = {
    projector,
    announcer,
    describe: (what) => describeCanvas(options, what),
    dispose() {
      if (disposed) return;
      disposed = true;
      announcer.dispose();
      projector.dispose();
    },
  };
  options.scope.defer(() => side.dispose());
  return ok(side);
}
