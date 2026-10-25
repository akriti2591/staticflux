/**
 * Studio's canvas port (B8; IF-27.18–27.19): what `<if-studio>` starts on its canvas surface. It lays the canvas,
 * the distance-label layer and (B6) the accessibility layer inside the surface, starts the raster (Vello in the
 * browser, injected), and opens one **canvas tab** (`canvas-tab.ts`) per shown page. DOM pointer, wheel and resize
 * events go to the tab; pages switch through `showPage` (the Pages panel's lens controller drives it).
 *
 * The raster outlives tabs (a page switch publishes a fresh snapshot into the same canvas).
 */
import { createScope, err, ok, type Result, type Scope } from '@staticflux/core';
import type { NodeId } from '@staticflux/document/v2';
import type { CanvasPort, CanvasSession } from '../studio/canvas.js';
import type { ToolPointer } from '../tools/gesture.js';
import { type CanvasTab, type CanvasTabOptions, openCanvasTab } from './canvas-tab.js';
import type { CanvasRaster } from './element-port.js';
import { NoOpenPageError } from './errors.js';

/** Starts the raster on the canvas element (CSS px size). */
export type RasterFactory = (canvas: HTMLCanvasElement, size: { readonly width: number; readonly height: number }, signal: AbortSignal) => Promise<Result<CanvasRaster>>;

export interface StudioCanvasOptions extends Omit<CanvasTabOptions, 'surface' | 'raster' | 'overlay' | 'labels' | 'viewport' | 'page' | 'scope' | 'tab'> {
  /** The page shown first. */
  readonly page: NodeId;
  readonly raster: RasterFactory;
  /** The tab changed (opened on a page, or closed). */
  readonly onTab?: (tab: CanvasTab | undefined) => void;
  /** Viewport when the surface has no layout yet (tests, hidden tabs). */
  readonly fallbackSize?: { readonly width: number; readonly height: number };
}

export interface StudioCanvas extends CanvasPort {
  readonly tab: CanvasTab | undefined;
  showPage(page: NodeId): Promise<Result<CanvasTab>>;
}

/** A raster a tab may use but not dispose (the port owns it). */
const borrowed = (raster: CanvasRaster): CanvasRaster => ({ apply: (b) => raster.apply(b), setCamera: (c) => raster.setCamera(c), present: () => raster.present(), dispose: () => undefined });

export function studioCanvas(options: StudioCanvasOptions): StudioCanvas {
  let tab: CanvasTab | undefined;
  let tabScope: Scope | undefined;
  let open: ((page: NodeId) => Promise<Result<CanvasTab>>) | undefined;
  let forwarded = 0;

  const port: StudioCanvas = {
    get tab() {
      return tab;
    },
    showPage: (page) => (open === undefined ? Promise.resolve(err(NoOpenPageError({ message: 'The canvas has not started.' }))) : open(page)),
    async start(surface, signal): Promise<Result<CanvasSession>> {
      const host = surface as unknown as HTMLElement;
      const doc = host.ownerDocument;
      const canvas = doc.createElement('canvas');
      canvas.dataset['ifCanvas'] = 'content';
      canvas.setAttribute('aria-hidden', 'true');
      Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block' });
      const labels = doc.createElement('div');
      labels.dataset['ifGuideLabels'] = '';
      labels.setAttribute('aria-hidden', 'true');
      Object.assign(labels.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden' });
      host.append(canvas, labels);
      const measured = host.getBoundingClientRect();
      const size = measured.width > 0 && measured.height > 0 ? { width: measured.width, height: measured.height } : (options.fallbackSize ?? { width: 960, height: 640 });
      const raster = await options.raster(canvas, size, signal);
      if (!raster.ok) {
        canvas.remove();
        labels.remove();
        return raster;
      }
      const shared = borrowed(raster.value);
      open = async (page) => {
        const previous = tabScope;
        tab = undefined;
        options.onTab?.(undefined);
        await previous?.dispose();
        const scope = createScope(`instaflow/canvas-tab:${page}`);
        tabScope = scope;
        const opened = await openCanvasTab({ ...options, tab: 'main', page, surface: host, raster: shared, overlay: shared, labels, viewport: size, scope });
        if (!opened.ok) {
          await scope.dispose();
          return opened;
        }
        tab = opened.value;
        options.onTab?.(tab);
        return ok(tab);
      };
      const first = await open(options.page);
      if (!first.ok) {
        raster.value.dispose();
        canvas.remove();
        labels.remove();
        return first;
      }

      // DOM input → the tab (surface pixels).
      const listeners = new AbortController();
      const { signal: listening } = listeners;
      const point = (e: PointerEvent | WheelEvent): { x: number; y: number } => {
        const r = host.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
      };
      const fromTextHost = (e: Event): boolean => (e.target as Element | null)?.closest?.('[data-if-text-host]') != null;
      const send = (phase: ToolPointer['phase'], e: PointerEvent): void => {
        if (tab === undefined || fromTextHost(e)) return;
        forwarded += 1;
        const result = tab.pointer({ phase, ...point(e), shift: e.shiftKey, alt: e.altKey, mod: e.metaKey || e.ctrlKey, ...(phase === 'down' ? { clicks: e.detail } : {}) });
        if (!result.ok) options.onProblem?.(result.error);
      };
      host.addEventListener(
        'pointerdown',
        (e) => {
          if (e.button !== 0 || fromTextHost(e)) return;
          host.setPointerCapture?.(e.pointerId);
          host.focus({ preventScroll: true });
          send('down', e);
        },
        { signal: listening },
      );
      host.addEventListener('pointermove', (e) => send('move', e), { signal: listening });
      host.addEventListener('pointerup', (e) => send('up', e), { signal: listening });
      host.addEventListener('pointercancel', (e) => send('cancel', e), { signal: listening });
      host.addEventListener(
        'wheel',
        (e) => {
          if (tab === undefined) return;
          e.preventDefault();
          forwarded += 1;
          const r = tab.wheel({ ...point(e), dx: e.deltaX, dy: e.deltaY, mod: e.ctrlKey || e.metaKey });
          if (!r.ok) options.onProblem?.(r.error);
        },
        { signal: listening, passive: false },
      );
      const Observer = (doc.defaultView as (Window & { ResizeObserver?: typeof ResizeObserver }) | null)?.ResizeObserver;
      if (Observer !== undefined) {
        const observer = new Observer(() => {
          const r = host.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return;
          raster.value.resize?.(r.width, r.height);
          tab?.view.setViewport(r.width, r.height);
          raster.value.present();
        });
        observer.observe(host);
        listening.addEventListener('abort', () => observer.disconnect(), { once: true });
      }

      let stopped = false;
      const stop = async (): Promise<void> => {
        if (stopped) return;
        stopped = true;
        listeners.abort();
        open = undefined;
        tab = undefined;
        options.onTab?.(undefined);
        await tabScope?.dispose();
        tabScope = undefined;
        raster.value.dispose();
        canvas.remove();
        labels.remove();
      };
      signal.addEventListener('abort', () => void stop(), { once: true });
      return ok({
        get forwarded() {
          return forwarded;
        },
        stop,
      });
    },
  };
  return port;
}
