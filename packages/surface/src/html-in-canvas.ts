/**
 * HTML-in-Canvas adapter (R11.22): one interface over the drawable-DOM canvas
 * API, which is still churning in origin trials:
 *
 * - opt-in attribute: `<canvas layoutsubtree>` (older) or `<canvas content="drawable">`;
 * - 2D draw: `ctx.drawElementImage(el, x, y)` (older `ctx.drawElement`), which may return a
 *   transform to keep hit testing in sync;
 * - textures: WebGL `texElementImage2D`, WebGPU `queue.drawElementImageToTexture`
 *   (older `queue.copyElementImageToTexture`);
 * - repaint: `canvas.requestPaint()` + `paint` event.
 *
 * Main thread only. Without native support the fallback is a **positioned DOM
 * overlay** synced to canvas transforms: elements stay real DOM, so hit testing
 * and accessibility are preserved in both modes.
 */
import { err, ok, type Result } from '@staticflux/core';
import { MainThreadOnlyError, SurfaceContextError } from './errors.js';

export interface HtmlInCanvasSupport {
  readonly native: boolean;
  readonly attribute: 'layoutsubtree' | 'content-drawable' | undefined;
  readonly draw2d: 'drawElementImage' | 'drawElement' | undefined;
  readonly webgl: 'texElementImage2D' | undefined;
  readonly webgpu: 'drawElementImageToTexture' | 'copyElementImageToTexture' | undefined;
}

export const NO_HTML_IN_CANVAS: HtmlInCanvasSupport = Object.freeze({
  native: false,
  attribute: undefined,
  draw2d: undefined,
  webgl: undefined,
  webgpu: undefined,
});

interface Proto {
  readonly prototype: object;
}

export interface HtmlInCanvasGlobals {
  readonly document?: Document;
  readonly CanvasRenderingContext2D?: Proto;
  readonly WebGLRenderingContext?: Proto;
  readonly WebGL2RenderingContext?: Proto;
  readonly GPUQueue?: Proto;
}

const has = (proto: Proto | undefined, name: string): boolean =>
  proto !== undefined && typeof (proto.prototype as Record<string, unknown>)[name] === 'function';

/** Feature-detect the drawable-content API (no UA sniffing). */
export function detectHtmlInCanvas(globals: HtmlInCanvasGlobals = globalThis as HtmlInCanvasGlobals): HtmlInCanvasSupport {
  const doc = globals.document;
  if (doc === undefined) return NO_HTML_IN_CANVAS;
  const ctx2d = globals.CanvasRenderingContext2D;
  const draw2d = has(ctx2d, 'drawElementImage') ? 'drawElementImage' : has(ctx2d, 'drawElement') ? 'drawElement' : undefined;
  const probe = doc.createElement('canvas') as HTMLCanvasElement & { layoutSubtree?: unknown };
  // `layoutsubtree` is reflected as a property; the newer `content="drawable"` form is not, so it is
  // inferred from the presence of the draw API.
  const attribute = 'layoutSubtree' in probe ? 'layoutsubtree' : draw2d !== undefined ? 'content-drawable' : undefined;
  const webgl = has(globals.WebGL2RenderingContext, 'texElementImage2D') || has(globals.WebGLRenderingContext, 'texElementImage2D') ? 'texElementImage2D' : undefined;
  const webgpu = has(globals.GPUQueue, 'drawElementImageToTexture')
    ? 'drawElementImageToTexture'
    : has(globals.GPUQueue, 'copyElementImageToTexture')
      ? 'copyElementImageToTexture'
      : undefined;
  return Object.freeze({ native: attribute !== undefined && draw2d !== undefined, attribute, draw2d, webgl, webgpu });
}

/** 2D affine transform (DOMMatrix-shaped). */
export interface Affine {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

export const IDENTITY: Affine = Object.freeze({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

/** What the adapter reads from a 2D context (`draw` accepts any 2D context object). */
export interface Drawable2D {
  getTransform?(): Affine;
}

export interface HtmlInCanvasAdapter {
  readonly mode: 'native' | 'overlay';
  readonly support: HtmlInCanvasSupport;
  /** Elements stay in the DOM in both modes: hit testing + accessibility preserved (no parallel a11y layer needed). */
  readonly providesAccessibility: true;
  /** The overlay container (overlay mode). */
  readonly overlay: HTMLElement | undefined;
  /** Make `element` drawable content (native: canvas child; overlay: overlay child). */
  add(element: HTMLElement): void;
  remove(element: HTMLElement): void;
  /**
   * Draw `element` at (x, y) in the context's coordinate space. Native: calls the draw API and syncs
   * the returned hit-testing transform; overlay: positions the element over the canvas.
   */
  draw(context: object, element: HTMLElement, x: number, y: number, width?: number, height?: number): void;
  /** Upload `element` into a GPU texture (native only); `args` are passed to the API as-is. */
  drawToTexture(api: 'webgl' | 'webgpu', target: unknown, element: HTMLElement, ...args: readonly unknown[]): Result<void>;
  /** Position `element` for hit testing / overlay at a canvas-space transform (3D: project the quad yourself). */
  place(element: HTMLElement, transform: Affine, width?: number, height?: number): void;
  /** Native: `paint` event; overlay: called after `requestPaint()`. */
  onPaint(callback: () => void): () => void;
  requestPaint(): void;
  dispose(): void;
}

export interface HtmlInCanvasOptions {
  readonly canvas: HTMLCanvasElement;
  readonly document: Document | undefined;
  /** Detected support (default `detectHtmlInCanvas()`); pass `NO_HTML_IN_CANVAS` to force the overlay. */
  readonly support?: HtmlInCanvasSupport;
  /** CSS size of the canvas (default from style/width). */
  readonly cssSize?: () => { readonly width: number; readonly height: number };
}

const matrixCss = (m: Affine): string => `matrix(${m.a}, ${m.b}, ${m.c}, ${m.d}, ${m.e}, ${m.f})`;

export function createHtmlInCanvas(options: HtmlInCanvasOptions): Result<HtmlInCanvasAdapter> {
  const doc = options.document;
  if (doc === undefined) return err(MainThreadOnlyError({ details: { api: 'html-in-canvas' } }));
  const { canvas } = options;
  const support = options.support ?? detectHtmlInCanvas({ ...(globalThis as HtmlInCanvasGlobals), document: doc });
  const mode = support.native ? 'native' : 'overlay';
  const paintListeners = new Set<() => void>();
  const cssSize =
    options.cssSize ??
    ((): { width: number; height: number } => ({
      width: Number.parseFloat(canvas.style.width) || canvas.width,
      height: Number.parseFloat(canvas.style.height) || canvas.height,
    }));
  /** Canvas backing px → CSS px. */
  const cssScale = (): number => {
    const width = cssSize().width;
    return canvas.width === 0 ? 1 : width / canvas.width;
  };

  let overlay: HTMLElement | undefined;
  if (mode === 'native') {
    if (support.attribute === 'layoutsubtree') canvas.setAttribute('layoutsubtree', '');
    else canvas.setAttribute('content', 'drawable');
  } else {
    overlay = doc.createElement('div');
    overlay.setAttribute('data-sf-html-overlay', '');
    Object.assign(overlay.style, { position: 'absolute', left: '0px', top: '0px', pointerEvents: 'none', overflow: 'hidden' });
  }
  const syncOverlay = (): void => {
    if (overlay === undefined) return;
    if (overlay.parentElement === null && canvas.parentElement !== null) canvas.after(overlay);
    const size = cssSize();
    overlay.style.left = `${canvas.offsetLeft}px`;
    overlay.style.top = `${canvas.offsetTop}px`;
    overlay.style.width = `${size.width}px`;
    overlay.style.height = `${size.height}px`;
  };

  const place = (element: HTMLElement, transform: Affine, width?: number, height?: number): void => {
    const s = cssScale();
    element.style.position = 'absolute';
    element.style.left = '0px';
    element.style.top = '0px';
    element.style.transformOrigin = '0 0';
    element.style.transform = matrixCss({ a: transform.a * s, b: transform.b * s, c: transform.c * s, d: transform.d * s, e: transform.e * s, f: transform.f * s });
    if (mode === 'overlay') element.style.pointerEvents = 'auto';
    if (width !== undefined) element.style.width = `${width}px`;
    if (height !== undefined) element.style.height = `${height}px`;
  };

  const onNativePaint = (): void => {
    for (const listener of [...paintListeners]) listener();
  };
  if (mode === 'native') canvas.addEventListener('paint', onNativePaint);

  const adapter: HtmlInCanvasAdapter = {
    mode,
    support,
    providesAccessibility: true,
    get overlay() {
      return overlay;
    },
    add(element) {
      if (overlay === undefined) {
        canvas.appendChild(element);
        return;
      }
      syncOverlay();
      overlay.appendChild(element);
    },
    remove(element) {
      element.remove();
    },
    draw(context, element, x, y, width, height) {
      if (mode === 'native' && support.draw2d !== undefined) {
        const draw = (context as unknown as Record<string, (...args: unknown[]) => unknown>)[support.draw2d];
        const args: unknown[] = width === undefined ? [element, x, y] : height === undefined ? [element, x, y, width] : [element, x, y, width, height];
        const transform = typeof draw === 'function' ? draw.apply(context, args) : undefined;
        // Newer builds return the transform that keeps hit testing aligned with the drawn pixels.
        if (transform !== undefined && transform !== null && typeof (transform as { toString?: unknown }).toString === 'function') {
          element.style.transform = String(transform);
        }
        return;
      }
      syncOverlay();
      const m = (context as Drawable2D).getTransform?.() ?? IDENTITY;
      place(element, { a: m.a, b: m.b, c: m.c, d: m.d, e: m.a * x + m.c * y + m.e, f: m.b * x + m.d * y + m.f }, width, height);
    },
    drawToTexture(api, target, element, ...args) {
      const method = api === 'webgl' ? support.webgl : support.webgpu;
      if (mode !== 'native' || method === undefined) {
        return err(SurfaceContextError({ message: `HTML-in-Canvas ${api} textures are not supported here; use the overlay (place()).`, details: { api } }));
      }
      const fn = (target as Record<string, (...a: unknown[]) => unknown> | null)?.[method];
      if (typeof fn !== 'function') return err(SurfaceContextError({ message: `Target has no ${method}().`, details: { api, method } }));
      try {
        fn.apply(target, api === 'webgl' ? [...args, element] : [element, ...args]);
        return ok();
      } catch (error) {
        return err(SurfaceContextError({ message: `${method}() failed.`, cause: error, details: { api, method } }));
      }
    },
    place: (element, transform, width, height) => {
      syncOverlay();
      place(element, transform, width, height);
    },
    onPaint(callback) {
      paintListeners.add(callback);
      return () => {
        paintListeners.delete(callback);
      };
    },
    requestPaint() {
      if (mode === 'native') {
        const request = (canvas as unknown as { requestPaint?: () => void }).requestPaint;
        if (typeof request === 'function') {
          request.call(canvas);
          return;
        }
      }
      queueMicrotask(onNativePaint);
    },
    dispose() {
      paintListeners.clear();
      if (mode === 'native') {
        canvas.removeEventListener('paint', onNativePaint);
        canvas.removeAttribute('layoutsubtree');
        canvas.removeAttribute('content');
      }
      overlay?.remove();
      overlay = undefined;
    },
  };
  return ok(adapter);
}
