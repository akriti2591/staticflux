/**
 * Minimal, order-preserving URL helpers for relative app URLs
 * (`/path?query#hash`). Empty values serialize as bare keys (`?sf-debug`).
 */

export interface UrlParts {
  readonly pathname: string;
  readonly params: readonly (readonly [key: string, value: string])[];
  readonly hash: string;
}

const BASE = 'http://staticflux.invalid';

export function parseUrl(url: string): UrlParts {
  const parsed = new URL(url, BASE);
  return { pathname: parsed.pathname, params: [...parsed.searchParams.entries()], hash: parsed.hash };
}

const encode = (value: string): string => encodeURIComponent(value).replace(/%20/g, '+');

export function formatUrl(parts: UrlParts): string {
  const query = parts.params.map(([k, v]) => (v === '' ? encode(k) : `${encode(k)}=${encode(v)}`)).join('&');
  return `${parts.pathname}${query === '' ? '' : `?${query}`}${parts.hash}`;
}

export function getParam(parts: UrlParts, key: string): string | undefined {
  return parts.params.find(([k]) => k === key)?.[1];
}

export function hasParam(parts: UrlParts, key: string): boolean {
  return parts.params.some(([k]) => k === key);
}

/** Set (replacing every occurrence, keeping the first position) or delete (`undefined`). */
export function withParam(parts: UrlParts, key: string, value: string | undefined): UrlParts {
  const index = parts.params.findIndex(([k]) => k === key);
  const rest = parts.params.filter(([k]) => k !== key);
  if (value === undefined) return { ...parts, params: rest };
  const at = index < 0 ? rest.length : index;
  return { ...parts, params: [...rest.slice(0, at), [key, value] as const, ...rest.slice(at)] };
}

export function withoutParams(parts: UrlParts, keys: Iterable<string>): UrlParts {
  const drop = new Set(keys);
  return { ...parts, params: parts.params.filter(([k]) => !drop.has(k)) };
}
