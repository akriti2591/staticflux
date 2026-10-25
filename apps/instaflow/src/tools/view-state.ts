/**
 * Per-tab view state (IF-7.2, IF-24.1): camera (pan and zoom), selection, the entered container, the active tool,
 * hover and the tool overlay. It lives in the tab's editor worker, is never written to the CRDT and never shared
 * through the store: two tabs on one document each keep their own camera and selection.
 *
 * - `createViewState({ tab, root })` — one tab's state (reactive reads through `@staticflux/core` boxes).
 * - `createViewStates()` — the tabs of this editor: `open(tab, init)`, `get(tab)` (IF-TOOL-003 for an unknown tab),
 *   `close(tab)`.
 * - Camera maths: `toPage(camera, sx, sy)`, `toScreen`, `zoomAbout`, `fitCamera(box, viewport)`, `ZOOM_RANGE`,
 *   `ZOOM_STEPS` (keyboard zoom in / out steps).
 */
import { box, err, ok, type Result } from '@staticflux/core';
import type { Box } from '@staticflux/document/spatial-index';
import type { NodeId } from '@staticflux/document/v2';
import { InvalidViewStateError } from './errors.js';
import { EMPTY_OVERLAY, type ToolOverlay } from './overlay.js';

/** Screen = page × zoom + (tx, ty). */
export interface Camera {
  readonly tx: number;
  readonly ty: number;
  readonly zoom: number;
}

export const ZOOM_RANGE = Object.freeze({ min: 0.02, max: 256 });
/** Keyboard zoom steps (Mod+= / Mod+-), as in design tools. */
export const ZOOM_STEPS: readonly number[] = Object.freeze([0.02, 0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 32, 64, 128, 256]);
export const IDENTITY_CAMERA: Camera = Object.freeze({ tx: 0, ty: 0, zoom: 1 });

export function toPage(camera: Camera, sx: number, sy: number): readonly [number, number] {
  return [(sx - camera.tx) / camera.zoom, (sy - camera.ty) / camera.zoom];
}

export function toScreen(camera: Camera, px: number, py: number): readonly [number, number] {
  return [px * camera.zoom + camera.tx, py * camera.zoom + camera.ty];
}

const clampZoom = (z: number): number => Math.min(ZOOM_RANGE.max, Math.max(ZOOM_RANGE.min, z));

/** Zoom to `zoom` keeping the page point under the screen point `(sx, sy)` fixed. */
export function zoomAbout(camera: Camera, zoom: number, sx: number, sy: number): Camera {
  const z = clampZoom(zoom);
  const f = z / camera.zoom;
  return { tx: sx - (sx - camera.tx) * f, ty: sy - (sy - camera.ty) * f, zoom: z };
}

/** The camera that shows `box` centred in a `width × height` viewport with `padding` screen px around it. */
export function fitCamera(target: Box, viewport: { readonly width: number; readonly height: number }, padding = 48): Camera {
  const w = Math.max(1e-9, target.maxX - target.minX);
  const h = Math.max(1e-9, target.maxY - target.minY);
  const zoom = clampZoom(Math.min((viewport.width - 2 * padding) / w, (viewport.height - 2 * padding) / h));
  const cx = (target.minX + target.maxX) / 2;
  const cy = (target.minY + target.maxY) / 2;
  return { tx: viewport.width / 2 - cx * zoom, ty: viewport.height / 2 - cy * zoom, zoom };
}

/** The next keyboard zoom step above (`+1`) or below (`-1`) `zoom`. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  const steps = direction > 0 ? ZOOM_STEPS : [...ZOOM_STEPS].reverse();
  return steps.find((s) => (direction > 0 ? s > zoom + 1e-9 : s < zoom - 1e-9)) ?? clampZoom(zoom);
}

export type TabId = string;

export interface ViewStateInit {
  readonly tab: TabId;
  /** The page (or canvas root) this tab edits; the default entered container. */
  readonly root: NodeId;
  readonly camera?: Camera;
  readonly tool?: string;
  readonly viewport?: { readonly width: number; readonly height: number };
}

export interface ViewState {
  readonly tab: TabId;
  readonly root: NodeId;
  /** Reactive. */
  readonly camera: Camera;
  readonly selection: readonly NodeId[];
  /** The container clicks select inside (the root, or a group or frame entered with Enter / double click). */
  readonly context: NodeId;
  readonly tool: string;
  readonly hover: NodeId | undefined;
  readonly overlay: ToolOverlay;
  readonly viewport: { readonly width: number; readonly height: number };
  setCamera(camera: Camera): Result<void>;
  panBy(dx: number, dy: number): Result<void>;
  /** Zoom by `factor` about the screen point (default the viewport centre). */
  zoomBy(factor: number, sx?: number, sy?: number): Result<void>;
  setViewport(width: number, height: number): void;
  select(nodes: readonly NodeId[]): void;
  /** Add or remove one node (Shift+click). */
  toggle(node: NodeId): void;
  clear(): void;
  setContext(container: NodeId): void;
  setTool(tool: string): void;
  setHover(node: NodeId | undefined): void;
  setOverlay(overlay: ToolOverlay): void;
}

const finiteCamera = (c: Camera): boolean => Number.isFinite(c.tx) && Number.isFinite(c.ty) && Number.isFinite(c.zoom) && c.zoom > 0;

/** One tab's view state (see the module header). */
export function createViewState(init: ViewStateInit): ViewState {
  const camera = box<Camera>(init.camera ?? IDENTITY_CAMERA);
  const selection = box<readonly NodeId[]>([]);
  const context = box<NodeId>(init.root);
  const tool = box<string>(init.tool ?? 'instaflow/select');
  const hover = box<NodeId | undefined>(undefined);
  const overlay = box<ToolOverlay>(EMPTY_OVERLAY);
  const viewport = box(init.viewport ?? { width: 1280, height: 800 });
  const setCamera = (next: Camera): Result<void> => {
    if (!finiteCamera(next)) return err(InvalidViewStateError({ message: 'The camera must be finite with a positive zoom.', details: { camera: next } }));
    if (next.zoom < ZOOM_RANGE.min - 1e-12 || next.zoom > ZOOM_RANGE.max + 1e-12) return err(InvalidViewStateError({ message: `Zoom ${next.zoom} is out of range.`, details: { range: ZOOM_RANGE } }));
    camera.set({ tx: next.tx, ty: next.ty, zoom: next.zoom });
    return ok();
  };
  return {
    tab: init.tab,
    root: init.root,
    get camera() {
      return camera.get();
    },
    get selection() {
      return selection.get();
    },
    get context() {
      return context.get();
    },
    get tool() {
      return tool.get();
    },
    get hover() {
      return hover.get();
    },
    get overlay() {
      return overlay.get();
    },
    get viewport() {
      return viewport.get();
    },
    setCamera,
    panBy(dx, dy) {
      const c = camera.get();
      return setCamera({ ...c, tx: c.tx + dx, ty: c.ty + dy });
    },
    zoomBy(factor, sx, sy) {
      if (!(Number.isFinite(factor) && factor > 0)) return err(InvalidViewStateError({ message: 'The zoom factor must be positive.', details: { factor, range: ZOOM_RANGE } }));
      const v = viewport.get();
      const c = camera.get();
      return setCamera(zoomAbout(c, c.zoom * factor, sx ?? v.width / 2, sy ?? v.height / 2));
    },
    setViewport: (width, height) => viewport.set({ width, height }),
    select: (nodes) => selection.set([...new Set(nodes)]),
    toggle(node) {
      const current = selection.get();
      selection.set(current.includes(node) ? current.filter((n) => n !== node) : [...current, node]);
    },
    clear: () => selection.set([]),
    setContext: (container) => context.set(container),
    setTool: (id) => tool.set(id),
    setHover: (node) => hover.set(node),
    setOverlay: (next) => overlay.set(next),
  };
}

export interface ViewStates {
  open(init: ViewStateInit): ViewState;
  get(tab: TabId): Result<ViewState>;
  close(tab: TabId): boolean;
  tabs(): readonly TabId[];
}

/** The view states of this editor's tabs: each tab is independent (IF-7.2). */
export function createViewStates(): ViewStates {
  const tabs = new Map<TabId, ViewState>();
  return {
    open(init) {
      const existing = tabs.get(init.tab);
      if (existing !== undefined) return existing;
      const state = createViewState(init);
      tabs.set(init.tab, state);
      return state;
    },
    get(tab) {
      const state = tabs.get(tab);
      return state === undefined ? err(InvalidViewStateError({ message: `No view state for tab "${tab}".`, details: { tab } })) : ok(state);
    },
    close: (tab) => tabs.delete(tab),
    tabs: () => [...tabs.keys()],
  };
}
