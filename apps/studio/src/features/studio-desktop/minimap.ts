/**
 * The editor's minimap: a small rich surface (R11.20–R11.22) projecting the document.
 *
 * - Kind `html-in-canvas`: bars are drawn with Canvas2D, the caption is real DOM drawn
 *   into the canvas where the browser supports drawable content, or positioned as a DOM
 *   overlay otherwise (the surface package's adapter) — accessible in both modes.
 * - Engines see only the `RenderContext` (no globals), so the same engine could run in
 *   a render worker for `canvas2d`.
 */
import { ok, type Result } from '@staticflux/core';
import { createCanvasSurface, type RenderEngine, type Surface, type SurfaceEnvironment } from '@staticflux/surface';
import type { BlockView } from '../../app/contracts.js';

function minimapEngine(caption: HTMLElement): RenderEngine<readonly BlockView[], 'html-in-canvas'> {
  let context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | undefined;
  let width = 0;
  let height = 0;
  let html: { draw(context: object, element: HTMLElement, x: number, y: number): void; add(element: HTMLElement): void } | undefined;
  return {
    init(ctx) {
      context = ctx.context;
      width = ctx.size.width;
      height = ctx.size.height;
      html = ctx.htmlInCanvas;
      html?.add(caption);
      return ok();
    },
    frame(blocks) {
      if (context === undefined) return;
      context.clearRect(0, 0, width, height);
      const rowHeight = Math.max(4, Math.min(14, (height - 20) / Math.max(1, blocks.length)));
      blocks.forEach((block, index) => {
        const length = Math.min(1, block.text.length / 120);
        context!.fillStyle = block.kind === 'image' ? '#0ea5e9' : '#6366f1';
        context!.fillRect(4, 18 + index * (rowHeight + 2), Math.max(6, (width - 8) * (block.kind === 'image' ? 1 : length)), rowHeight);
      });
      caption.textContent = `${blocks.length} blocks`;
      html?.draw(context, caption, 4, 2);
    },
    resize(size) {
      width = size.width;
      height = size.height;
    },
    dispose() {
      context = undefined;
    },
  };
}

/** Create and attach the minimap; failures (no 2D context, e.g. headless DOMs) degrade to text. */
export async function attachMinimap(host: HTMLElement, env: SurfaceEnvironment, blocks: () => readonly BlockView[], signal: AbortSignal): Promise<Result<Surface>> {
  const caption = host.ownerDocument.createElement('span');
  caption.className = 'minimap-caption';
  const surface = createCanvasSurface({
    id: 'studio/minimap',
    kind: 'html-in-canvas',
    engine: () => minimapEngine(caption),
    state: blocks,
    env,
    label: 'Document minimap',
    input: false,
    budget: { frameMs: 8 },
  });
  const attached = await surface.attach(host, { size: { width: 160, height: 220 }, signal });
  if (!attached.ok) {
    await surface.dispose();
    return attached;
  }
  return ok(surface);
}
