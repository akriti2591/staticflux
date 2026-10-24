/**
 * Marketing params (R7.15): captured once into telemetry and stripped from the
 * URL with `replace`, so they never leak into shared links, bookmarks or
 * analytics of later navigations.
 */
import { createNoopTelemetry, metric, type Telemetry } from '@staticflux/core';
import { reserveParams, type ReservedParams } from './binding.js';
import type { HistoryPort } from './history.js';
import { URLSTATE_SOURCE } from './sync.js';
import { formatUrl, parseUrl, withoutParams } from './url.js';

export const DEFAULT_MARKETING_PARAMS: readonly string[] = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'gclid',
  'dclid',
  'fbclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
];

export const MarketingMetrics = {
  captured: metric.counter('urlstate/marketing-captured', { description: 'Landings with marketing params.' }),
} as const;

/** Declaration for collision checks: these keys are reserved. */
export const MarketingParams: ReservedParams = reserveParams('urlstate/marketing', DEFAULT_MARKETING_PARAMS);

export interface ExtractedMarketing {
  readonly params: Readonly<Record<string, string>>;
  /** `url` without the marketing params. */
  readonly url: string;
}

export function extractMarketingParams(url: string, keys: readonly string[] = DEFAULT_MARKETING_PARAMS): ExtractedMarketing {
  const parts = parseUrl(url);
  const wanted = new Set(keys);
  const params: Record<string, string> = {};
  for (const [key, value] of parts.params) if (wanted.has(key) && params[key] === undefined) params[key] = value;
  return { params, url: Object.keys(params).length === 0 ? url : formatUrl(withoutParams(parts, keys)) };
}

export interface MarketingCaptureOptions {
  readonly history: HistoryPort;
  readonly telemetry?: Telemetry;
  readonly keys?: readonly string[];
  /** Strip from the URL (default true). */
  readonly strip?: boolean;
}

export interface MarketingCapture {
  /** Capture from the current URL (once per page lifetime); returns what was captured. */
  capture(): Readonly<Record<string, string>> | undefined;
  readonly captured: Readonly<Record<string, string>> | undefined;
}

export function createMarketingCapture(options: MarketingCaptureOptions): MarketingCapture {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  let captured: Readonly<Record<string, string>> | undefined;
  return {
    capture() {
      const { params, url } = extractMarketingParams(options.history.url, options.keys);
      if (Object.keys(params).length === 0) return undefined;
      if (options.strip !== false) options.history.replace(url, { source: URLSTATE_SOURCE });
      if (captured !== undefined) return undefined; // once: later landings in the same page are stripped only
      captured = params;
      telemetry.record(MarketingMetrics.captured, 1, params);
      telemetry.event('urlstate.marketing', { subsystem: 'urlstate/marketing', level: 'critical', attrs: params });
      return params;
    },
    get captured() {
      return captured;
    },
  };
}
