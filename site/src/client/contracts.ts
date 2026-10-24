/**
 * Site contracts: the typed values shared by the site's units and islands
 * (tokens, URL bindings, registry merges). Declarations only — no behaviour.
 */
import { type Box, type TelemetryRecord, token } from '@staticflux/core';
import { codec, defineUrlBinding } from '@staticflux/urlstate';

export const LAYERS = ['core', 'runtime', 'vertical', 'ui', 'shell', 'tooling'] as const;
export type LayerId = (typeof LAYERS)[number];

declare module '@staticflux/core' {
  interface Registry {
    urlParams: {
      layer: LayerId;
    };
    chunks: {
      'island:theme': true;
      'island:code': true;
      'island:packages': true;
      'island:boot-trace': true;
    };
  }
}

/** `?layer=` on the packages page: view state owned by the package filter (replace, so Back leaves the page). */
export const LayerBinding = defineUrlBinding({
  key: 'layer',
  kind: 'view',
  codec: codec.enum(LAYERS),
  owner: 'site/package-filter',
  history: 'replace',
  description: 'Layer filter of the packages reference.',
});

/** Filter state of the packages reference (layer is URL-bound, the search text is not). */
export interface PackageFilter {
  readonly layer: Box<LayerId | undefined>;
  readonly query: Box<string>;
}
export const PackageFilterToken = token('site/package-filter').type<PackageFilter>();

/** The telemetry this page recorded since boot (fed by a memory sink attached before boot). */
export interface BootTrace {
  /** Reactive: bumps whenever a span ends. */
  readonly version: Box<number>;
  records(): readonly TelemetryRecord[];
}
export const BootTraceToken = token('site/boot-trace').type<BootTrace>();
