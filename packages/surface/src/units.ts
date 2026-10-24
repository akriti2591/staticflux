/**
 * DI units: apps register these instead of constructing surfaces by hand.
 *
 * @example
 * export const CanvasToken = token('studio/canvas-surface').type<Surface>();
 * const units = [
 *   surfaceEnvironmentUnit(),
 *   surfaceImagePolicyUnit(),                  // or bind the app's IsolationPolicy-backed policy
 *   surfaceImageLoaderUnit(),
 *   surfaceUnit({ id: 'studio/canvas-surface-unit', provides: CanvasToken, scope: 'feature',
 *     create: (env, ctx) => createRenderSurface({ id: 'studio/canvas', kind: 'webgl', engineId: 'scene',
 *       engine: createSceneEngine, link: renderWorker.link, state: () => projection.view, env, telemetry: ctx.telemetry }) }),
 * ];
 */
import { err, type ScopeLevel, type Token, type TokenId, token, unit, type UnitContext, type UnitDefinition } from '@staticflux/core';
import { defaultSurfaceEnvironment, type SurfaceEnvironment } from './env.js';
import { ImageLoadError } from './errors.js';
import { detectHtmlInCanvas, type HtmlInCanvasSupport } from './html-in-canvas.js';
import {
  anonymousImagePolicy,
  createSurfaceImageLoader,
  defaultImageLoaderPorts,
  type ImageLoaderPorts,
  type SurfaceImageLoader,
  type SurfaceImagePolicy,
} from './images.js';
import type { Surface } from './surface.js';

export const SurfaceEnvironmentToken = /* @__PURE__ */ token('surface/environment').type<SurfaceEnvironment>();
export const SurfaceImagePolicyToken = /* @__PURE__ */ token('surface/image-policy').type<SurfaceImagePolicy>();
export const SurfaceImageLoaderToken = /* @__PURE__ */ token('surface/image-loader').type<SurfaceImageLoader>();
export const HtmlInCanvasSupportToken = /* @__PURE__ */ token('surface/html-in-canvas-support').type<HtmlInCanvasSupport>();

export function surfaceEnvironmentUnit(
  overrides: Partial<SurfaceEnvironment> = {},
): UnitDefinition<SurfaceEnvironment, Record<never, never>, 'surface/environment'> {
  return unit<SurfaceEnvironment, Record<never, never>, 'surface/environment'>({
    id: 'surface/environment-unit',
    provides: SurfaceEnvironmentToken,
    scope: 'app',
    description: 'Clock, time origin, DPR, frame scheduler (rAF/timer), document and ResizeObserver for surfaces.',
    create: () => defaultSurfaceEnvironment(overrides),
  });
}

/** Isolation-policy port for surface images; default: anonymous CORS for every cross-origin image. */
export function surfaceImagePolicyUnit(
  policy: SurfaceImagePolicy = anonymousImagePolicy,
): UnitDefinition<SurfaceImagePolicy, Record<never, never>, 'surface/image-policy'> {
  return unit<SurfaceImagePolicy, Record<never, never>, 'surface/image-policy'>({
    id: 'surface/image-policy-unit',
    provides: SurfaceImagePolicyToken,
    scope: 'app',
    create: () => policy,
  });
}

const missingPorts: SurfaceImageLoader = {
  load: (url) =>
    Promise.resolve(err(ImageLoadError({ message: 'fetch/createImageBitmap are not available here.', details: { url } }))),
};

export function surfaceImageLoaderUnit(
  options: { readonly ports?: ImageLoaderPorts } = {},
): UnitDefinition<SurfaceImageLoader, { readonly required: { readonly policy: typeof SurfaceImagePolicyToken } }, 'surface/image-loader'> {
  return unit({
    id: 'surface/image-loader-unit',
    provides: SurfaceImageLoaderToken,
    scope: 'app',
    deps: { required: { policy: SurfaceImagePolicyToken } },
    description: 'CORS-clean image/texture loading for surfaces (R11.16b).',
    create: ({ policy }, context) => {
      const ports = options.ports ?? defaultImageLoaderPorts();
      return ports === undefined ? missingPorts : createSurfaceImageLoader({ ports, policy, telemetry: context.telemetry });
    },
  });
}

/** HTML-in-Canvas feature facts (main thread; all-false in workers). */
export function htmlInCanvasSupportUnit(): UnitDefinition<HtmlInCanvasSupport, Record<never, never>, 'surface/html-in-canvas-support'> {
  return unit<HtmlInCanvasSupport, Record<never, never>, 'surface/html-in-canvas-support'>({
    id: 'surface/html-in-canvas-support-unit',
    provides: HtmlInCanvasSupportToken,
    scope: 'app',
    create: () => detectHtmlInCanvas(),
  });
}

export interface SurfaceUnitOptions<Id extends TokenId> {
  readonly id: TokenId;
  readonly provides: Token<Surface, Id>;
  /** Default `feature` (the surface lives as long as the feature that shows it). */
  readonly scope?: ScopeLevel;
  readonly create: (env: SurfaceEnvironment, context: UnitContext) => Surface;
}

/** A unit providing a surface; disposed with its scope (detach → dispose). */
export function surfaceUnit<const Id extends TokenId>(
  options: SurfaceUnitOptions<Id>,
): UnitDefinition<Surface, { readonly required: { readonly env: typeof SurfaceEnvironmentToken } }, Id> {
  return unit({
    id: options.id,
    provides: options.provides,
    scope: options.scope ?? 'feature',
    deps: { required: { env: SurfaceEnvironmentToken } },
    create: ({ env }, context) => {
      const surface = options.create(env, context);
      context.scope.defer(() => surface.dispose());
      return surface;
    },
  });
}
