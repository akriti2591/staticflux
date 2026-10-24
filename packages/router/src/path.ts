/**
 * Typed path patterns (R7.9). A pattern is a `/`-separated list of static segments and
 * `:param` segments. Param names are extracted at the type level with template literal
 * types, so `route.path = '/studio/doc/:id'` types `params` as `{ readonly id: string }`.
 *
 * Runtime: patterns compile once into segment lists; matching is segment-wise and
 * decodes URI components; building encodes them.
 */
import { err, ok, type Result } from '@staticflux/core';
import { MissingParamError } from './errors.js';

// ---------------------------------------------------------------- types

/** Remove leading/trailing slashes. */
export type TrimSlashes<S extends string> = S extends `/${infer R}`
  ? TrimSlashes<R>
  : S extends `${infer R}/`
    ? TrimSlashes<R>
    : S;

/** Join a parent full path and a child segment into a normalized full path (`/a/b`, root = `/`). */
export type JoinPaths<A extends string, B extends string> = TrimSlashes<A> extends ''
  ? `/${TrimSlashes<B>}`
  : TrimSlashes<B> extends ''
    ? `/${TrimSlashes<A>}`
    : `/${TrimSlashes<A>}/${TrimSlashes<B>}`;

type SegmentParam<S extends string> = S extends `:${infer Name}` ? Name : never;

/** Union of `:param` names in a path pattern. */
export type ParamNames<P extends string> = P extends `${infer Head}/${infer Rest}`
  ? SegmentParam<Head> | ParamNames<Rest>
  : SegmentParam<P>;

/** Typed params object of a path pattern. */
export type PathParams<P extends string> = { readonly [K in ParamNames<P>]: string };

// ---------------------------------------------------------------- runtime

export type PatternSegment =
  | { readonly type: 'static'; readonly value: string }
  | { readonly type: 'param'; readonly name: string };

export interface CompiledPattern {
  readonly pattern: string;
  readonly segments: readonly PatternSegment[];
  /** Static segments outrank params (higher = more specific). */
  readonly score: number;
  readonly paramNames: readonly string[];
}

/** Split a pathname into non-empty segments. */
export function splitPath(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

/** Normalize `a/b/` → `/a/b`, `''` → `/`. */
export function normalizePath(path: string): string {
  const segments = splitPath(path);
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

/** Runtime counterpart of `JoinPaths`. */
export function joinPaths(parent: string, child: string): string {
  return normalizePath(`${parent}/${child}`);
}

export function compilePattern(pattern: string): CompiledPattern {
  const segments: PatternSegment[] = splitPath(pattern).map((s) =>
    s.startsWith(':') ? { type: 'param', name: s.slice(1) } : { type: 'static', value: s },
  );
  const score = segments.reduce((sum, s) => sum + (s.type === 'static' ? 3 : 2), 0);
  const paramNames = segments.flatMap((s) => (s.type === 'param' ? [s.name] : []));
  return { pattern: normalizePath(pattern), segments, score, paramNames };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Match pathname segments exactly; returns decoded params or undefined. */
export function matchPattern(compiled: CompiledPattern, segments: readonly string[]): Record<string, string> | undefined {
  if (compiled.segments.length !== segments.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < segments.length; i += 1) {
    const expected = compiled.segments[i] as PatternSegment;
    const actual = segments[i] as string;
    if (expected.type === 'static') {
      if (expected.value !== actual) return undefined;
    } else {
      const decoded = safeDecode(actual);
      if (decoded.length === 0) return undefined;
      params[expected.name] = decoded;
    }
  }
  return params;
}

/** Fill a pattern with params (encoded). Missing params → SF-NAV-011. */
export function buildPath(compiled: CompiledPattern, params: Readonly<Record<string, string>>): Result<string> {
  const parts: string[] = [];
  for (const segment of compiled.segments) {
    if (segment.type === 'static') {
      parts.push(segment.value);
      continue;
    }
    const value = params[segment.name];
    if (value === undefined || value.length === 0) {
      return err(MissingParamError({ details: { pattern: compiled.pattern, param: segment.name } }));
    }
    parts.push(encodeURIComponent(value));
  }
  return ok(parts.length === 0 ? '/' : `/${parts.join('/')}`);
}
