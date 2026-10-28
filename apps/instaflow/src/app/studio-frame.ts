/**
 * Studio's frame before the session (issue #62; ARCHITECTURE §4.1 step 4, "shell renders frame + placeholders"): the
 * page renders `<if-studio>` as soon as its JavaScript runs, while the workspace, the workers, the Wasm, the fonts and
 * the document load. Then `bootStudioPage` (`../workspace/studio-page.ts`) disposes the frame and mounts the real app
 * in the same container.
 *
 * The frame is the same element laid out from the same Studio spec at this device's density, so the top bar, the tool
 * picker, the dock tabs (Layers first), the inspector column and the zoom pill sit exactly where the app puts them
 * (no layout shift). Everything that needs the engine or the document is a placeholder, through the existing seams
 * instead of a loading mode:
 * - the panels render a skeleton (the registries' panel binder, the hook the app binds its models with);
 * - the canvas region is `placeholderCanvas()`, a `CanvasPort` whose surface holds a page-shaped skeleton;
 * - the save state is a skeleton (`status`);
 * - no chrome port, no shortcut registry (no key reaches a command), and the element is `inert` (nothing is clickable
 *   or focusable) while the container is `aria-busy`.
 */
import { createInjector, createScope, ok, type Result } from '@staticflux/core';
import { createGate } from '@staticflux/gate';
import { defineUiElements, provideScope } from '@staticflux/ui';
import { html, render } from 'lit';
import { createDeviceSettings, type DeviceSettings } from '../settings/device-settings.js';
import { gateSpecDecide } from '../spec/gate.js';
import type { CanvasPort } from '../studio/canvas.js';
import { createStudio, type Studio } from '../studio/studio.js';
import { defineStudio, type IfStudioElement } from '../studio/studio-element.js';
import { studioAppRegistries } from './registries.js';

/** Marks the canvas placeholder in the surface (tests and the smoke read it). */
export const CANVAS_PLACEHOLDER_ATTR = 'data-if-canvas-placeholder';

export interface StudioFrameOptions {
  /** This device's settings (the frame lays out at its density; default: `localStorage`). */
  readonly settings?: DeviceSettings;
  /** The top bar's Home link (default `/`). */
  readonly homeHref?: string;
}

export interface StudioFrame {
  /** The frame's `<if-studio>` (inert). */
  readonly element: IfStudioElement;
  /** The frame's Studio controller (the spec it is laid out from). */
  readonly studio: Studio;
  /** Resolves once the Studio spec is mounted at the device's density (the regions show). */
  readonly opened: Promise<Result<void>>;
  /** Remove the frame from the container (before the app mounts there). */
  dispose(): Promise<void>;
}

/**
 * The canvas region's placeholder: a page-shaped skeleton in the surface, where the real port puts its `<canvas>`. It
 * forwards no input and starts no engine; stopping it (the element disconnecting) removes the skeleton.
 */
export function placeholderCanvas(): CanvasPort {
  return {
    start(target) {
      const surface = target as unknown as HTMLElement;
      const card = surface.ownerDocument.createElement('div');
      card.setAttribute(CANVAS_PLACEHOLDER_ATTR, '');
      card.setAttribute('aria-hidden', 'true');
      // The page card's look (studio-element.ts `.page-card`), faded, centred in the canvas room.
      Object.assign(card.style, {
        position: 'absolute',
        insetBlockStart: '50%',
        insetInlineStart: '50%',
        blockSize: 'min(60%, 520px)',
        aspectRatio: '4 / 5',
        transform: 'translate(-50%, -50%)',
        boxSizing: 'border-box',
        padding: '24px',
        background: '#ffffff',
        opacity: '0.7',
        boxShadow: '0 2px 6px rgba(22, 21, 26, 0.1), 0 24px 56px rgba(22, 21, 26, 0.18)',
        pointerEvents: 'none',
      });
      const lines = surface.ownerDocument.createElement('sf-skeleton');
      lines.setAttribute('lines', '3');
      card.append(lines);
      surface.append(card);
      return Promise.resolve(
        ok({
          forwarded: 0,
          stop: () => {
            card.remove();
            return Promise.resolve();
          },
        }),
      );
    },
  };
}

/** Render the Studio frame into `container` (see the module header). */
export function mountStudioFrame(container: HTMLElement, options: StudioFrameOptions = {}): Result<StudioFrame> {
  const registries = studioAppRegistries((panel) => ({ ...panel, render: () => html`<sf-skeleton lines="6"></sf-skeleton>` }));
  if (!registries.ok) return registries;
  defineUiElements();
  defineStudio();
  const scope = createScope('instaflow/studio-frame');
  const settings = options.settings ?? createDeviceSettings();
  settings.apply(container.ownerDocument.documentElement, scope);
  // The frame only mounts the preset spec and the person's density: no agent policies to consult.
  const gate = createGate();
  // No entering motion: the frame is where the app will be, and the session waits for its layout.
  const studio = createStudio({ registries: registries.value, decideFor: (s) => gateSpecDecide(gate, s), reducedMotion: () => true });
  scope.defer(() => studio.dispose());
  // The frame's own scope element (no services: nothing in the frame resolves any), so the container stays clean for the
  // app's scope; `display: contents` keeps the element's layout exactly the app's.
  const host = container.ownerDocument.createElement('div');
  host.style.display = 'contents';
  const injector = createInjector({ units: [] });
  const provided = provideScope(host, { injector, name: 'instaflow/studio-frame' });
  scope.defer(() => injector.dispose());
  scope.defer(() => provided.dispose());
  container.setAttribute('aria-busy', 'true');
  container.append(host);
  render(
    html`<if-studio
      inert
      .studio=${studio}
      .canvas=${placeholderCanvas()}
      .status=${html`<sf-skeleton></sf-skeleton>`}
      home-href=${options.homeHref ?? '/'}
      project-title="Instaflow"
    ></if-studio>`,
    host,
  );
  const element = host.querySelector('if-studio') as IfStudioElement;
  const opened = (async (): Promise<Result<void>> => {
    const mounted = await studio.open(scope.signal);
    if (!mounted.ok) return mounted;
    const density = settings.current.density;
    if (density === studio.density) return ok();
    const dense = await studio.setDensity(density, scope.signal);
    return dense.ok ? ok() : dense;
  })();
  return ok({
    element,
    studio,
    opened,
    async dispose() {
      host.remove();
      container.removeAttribute('aria-busy');
      await scope.dispose();
    },
  });
}
