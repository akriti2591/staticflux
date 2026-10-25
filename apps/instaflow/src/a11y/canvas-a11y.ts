/**
 * One tab's accessibility layer in one call (IF-25.17, IF-25.18): the projector (editor side), the DOM mount (main
 * side) and the polite selection announcer, wired for the colocated topology. In the split topology the projector
 * runs in the editor worker and posts snapshots (plain data) to the main thread, where `mountCanvasA11y` applies them;
 * the pieces are the same.
 *
 * `describeCanvas(input, what)` is the text behind the `instaflow/describe-canvas` capability and HUD action: the
 * selection, or what is in view in reading order.
 */
import type { Announcer, Timers } from '@staticflux/a11y';
import { ok, type Result, type Scope } from '@staticflux/core';
import type { NodeId } from '@staticflux/document/v2';
import type { ViewState } from '../tools/view-state.js';
import type { SelectionAnnouncer } from './announce.js';
import { type CanvasA11yMount, mountCanvasA11y } from './dom.js';
import type { DescribeTarget } from './describe.js';
import { createCanvasA11yEditor } from './editor-side.js';
import type { CanvasProjector, ProjectionInput } from './projection.js';

export { DESCRIBE_MAX_ITEMS, DESCRIBE_TARGETS, type DescribeTarget, describeCanvas } from './describe.js';

export interface CanvasA11yOptions extends Omit<ProjectionInput, 'view'> {
  readonly view: ViewState;
  /** The canvas surface element. */
  readonly host: HTMLElement;
  readonly document: Document | undefined;
  readonly announcer: Pick<Announcer, 'announce'>;
  readonly timers: Timers;
  /** B3's tool controller (announcements wait while `state` is not `idle`). */
  readonly gesture?: { readonly state: string };
  /** Coalesces projection flushes (default a microtask; pass `requestAnimationFrame` in a browser). */
  readonly schedule?: (flush: () => void) => void;
  readonly debounceMs?: number;
  /** The tab scope: everything is disposed with it (rule 5). */
  readonly scope: Pick<Scope, 'defer'>;
}

export interface CanvasA11y {
  readonly projector: CanvasProjector;
  readonly mount: CanvasA11yMount;
  readonly announcer: SelectionAnnouncer;
  describe(what: DescribeTarget): Result<{ readonly text: string; readonly count: number }>;
  dispose(): void;
}

/** Wire the projection, the DOM mount and the announcer for one tab (see the module header). */
export function createCanvasA11y(options: CanvasA11yOptions): Result<CanvasA11y> {
  const { view } = options;
  const mounted = mountCanvasA11y({
    host: options.host,
    document: options.document,
    onFocusNode: (id: NodeId) => {
      if (view.selection.length !== 1 || view.selection[0] !== id) view.select([id]);
    },
  });
  if (!mounted.ok) return mounted;
  const mount = mounted.value;
  const editor = createCanvasA11yEditor({ ...options, scope: { defer: () => undefined } });
  if (!editor.ok) {
    mount.dispose();
    return editor;
  }
  const { projector, announcer } = editor.value;
  const stopApply = projector.onChange((snapshot) => {
    mount.apply(snapshot);
  });
  const first = projector.snapshot();
  if (first.ok) mount.apply(first.value);
  let disposed = false;
  const a11y: CanvasA11y = {
    projector,
    mount,
    announcer,
    describe: (what) => editor.value.describe(what),
    dispose() {
      if (disposed) return;
      disposed = true;
      stopApply();
      editor.value.dispose();
      mount.dispose();
    },
  };
  options.scope.defer(() => a11y.dispose());
  return ok(a11y);
}
