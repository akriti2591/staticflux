/**
 * Build-side helpers for prerender/SSG steps (no DOM; runs in Node, workers or the browser).
 *
 *   const html = renderIslandMarker({
 *     chunk: 'feature:cart', hydrate: 'visible', props: { sku: 'a1' }, size: { width: 320, height: 48 },
 *     html: renderCartStatic({ sku: 'a1' }),   // trusted, already-escaped markup from your renderer
 *   });
 *   if (!html.ok) throw html.error;
 *
 * Escaping (XSS-safe embedding): props JSON escapes `<` `>` `&` U+2028 U+2029 as `\uXXXX`
 * (still valid JSON, can never close a `<script>` or start a tag/entity), and attribute values
 * are additionally HTML-attribute-escaped (`&` `"` `'` `<` `>`). The inner `html` is inserted
 * verbatim: it is the output of your (escaping) renderer, never raw user input.
 */
import { err, ok, type Result } from '@staticflux/core';
import { IslandMarkerInvalidError, PropsNotSerializableError } from './errors.js';
import {
  formatIslandSize,
  type HydrateStrategy,
  type IslandAttributeNames,
  type IslandChunkId,
  type IslandSize,
  isHydrateStrategy,
  isIslandChunkId,
  ISLAND_DATA_ATTRS,
  ISLAND_ELEMENT_ATTRS,
  ISLAND_PROPS_SCRIPT_TYPE,
  ISLAND_TAG,
} from './marker.js';

const JSON_ESCAPES: Readonly<Record<string, string>> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

const HTML_ATTR_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '"': '&quot;',
  "'": '&#39;',
  '<': '&lt;',
  '>': '&gt;',
};

/** Escape a string for use inside a quoted HTML attribute value. */
export function escapeHtmlAttribute(value: string): string {
  return value.replace(/[&"'<>]/g, (c) => HTML_ATTR_ESCAPES[c] ?? c);
}

/** Make JSON text safe to embed in HTML (script body or attribute): no `<`, `>`, `&`, U+2028/9 left. */
export function escapeJsonForHtml(json: string): string {
  return json.replace(/[<>&\u2028\u2029]/g, (c) => JSON_ESCAPES[c] ?? c);
}

function checkPlain(value: unknown, path: string, seen: Set<object>): string | undefined {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return undefined;
    case 'number':
      return Number.isFinite(value) ? undefined : `${path} is a non-finite number`;
    case 'object': {
      if (value === null) return undefined;
      if (seen.has(value)) return `${path} is a cycle`;
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          for (let i = 0; i < value.length; i += 1) {
            if (value[i] === undefined) return `${path}[${i}] is undefined`;
            const problem = checkPlain(value[i], `${path}[${i}]`, seen);
            if (problem !== undefined) return problem;
          }
          return undefined;
        }
        const proto = Object.getPrototypeOf(value) as unknown;
        if (proto !== Object.prototype && proto !== null) return `${path} is a class instance`;
        for (const [key, item] of Object.entries(value)) {
          if (item === undefined) continue; // optional prop (JSON drops it)
          const problem = checkPlain(item, `${path}.${key}`, seen);
          if (problem !== undefined) return problem;
        }
        return undefined;
      } finally {
        seen.delete(value);
      }
    }
    default:
      return `${path} is a ${typeof value}`;
  }
}

/** Serialize island props to HTML-safe JSON. Plain data only (`SF-HYD-030` otherwise). */
export function serializeIslandProps(props: unknown): Result<string> {
  if (props === undefined) return err(PropsNotSerializableError({ message: 'Island props are undefined (omit `props` instead).' }));
  const problem = checkPlain(props, 'props', new Set());
  if (problem !== undefined) return err(PropsNotSerializableError({ message: `Island props are not plain data: ${problem}.`, details: { problem } }));
  return ok(escapeJsonForHtml(JSON.stringify(props)));
}

interface MarkerBase {
  readonly chunk: IslandChunkId;
  /** Prerendered inner markup (trusted renderer output; inserted verbatim). */
  readonly html: string;
  readonly props?: unknown;
  readonly id?: string;
  readonly exportName?: string;
  /** Declared box for the size-stable check (R12.19). */
  readonly size?: IslandSize;
  /** `element` → `<sf-island>`; `{ tag }` → `<tag data-sf-island=…>`. Default `element`. */
  readonly form?: 'element' | { readonly tag: string };
  /** Where props go. Default `attribute`; use `script` for large props. */
  readonly propsIn?: 'attribute' | 'script';
  /** Extra host attributes (`class`, `style`, …). Values are escaped; `on*` handlers are rejected. */
  readonly attributes?: Readonly<Record<string, string>>;
}

/** `eager` requires a reason (R12.12), checked at compile time. */
export type IslandMarkerOptions =
  | (MarkerBase & { readonly hydrate?: Exclude<HydrateStrategy, 'eager'>; readonly reason?: string })
  | (MarkerBase & { readonly hydrate: 'eager'; readonly reason: string });

const TAG_NAME = /^[a-z][a-z0-9-]*$/;
const ATTR_NAME = /^[a-zA-Z_][-a-zA-Z0-9_:.]*$/;
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr', 'script', 'style', 'template', 'textarea', 'title']);

function invalid(message: string, details: Record<string, unknown>): Result<never> {
  return err(IslandMarkerInvalidError({ message, details }));
}

/** Render an island marker around prerendered markup. */
export function renderIslandMarker(options: IslandMarkerOptions): Result<string> {
  if (!isIslandChunkId(options.chunk)) return invalid(`Invalid island chunk id "${options.chunk}".`, { chunk: options.chunk });
  const strategy = options.hydrate;
  if (strategy !== undefined && !isHydrateStrategy(strategy)) return invalid(`Unknown hydrate strategy "${String(strategy)}".`, { hydrate: strategy });
  if (strategy === 'eager' && (options.reason === undefined || options.reason.trim() === '')) {
    return invalid('`hydrate: "eager"` requires a non-empty `reason` (R12.12).', { chunk: options.chunk });
  }
  const form = options.form ?? 'element';
  const tag = form === 'element' ? ISLAND_TAG : form.tag;
  if (!TAG_NAME.test(tag) || VOID_TAGS.has(tag)) return invalid(`Invalid island host tag "${tag}".`, { tag });
  const names: IslandAttributeNames = form === 'element' ? ISLAND_ELEMENT_ATTRS : ISLAND_DATA_ATTRS;
  const reserved = new Set<string>(Object.values(names));

  const attrs: [string, string][] = [[names.chunk, options.chunk]];
  if (strategy !== undefined) attrs.push([names.hydrate, strategy]);
  if (options.reason !== undefined) attrs.push([names.reason, options.reason]);
  if (options.id !== undefined) attrs.push([names.id, options.id]);
  if (options.exportName !== undefined) attrs.push([names.exportName, options.exportName]);
  if (options.size !== undefined) {
    if (!(options.size.width >= 0 && options.size.height >= 0)) return invalid('Island size must be non-negative.', { size: options.size });
    attrs.push([names.size, formatIslandSize(options.size)]);
  }
  let script = '';
  if (options.props !== undefined) {
    const json = serializeIslandProps(options.props);
    if (!json.ok) return json;
    if ((options.propsIn ?? 'attribute') === 'attribute') attrs.push([names.props, json.value]);
    else script = `<script type="${ISLAND_PROPS_SCRIPT_TYPE}">${json.value}</script>`;
  }
  for (const [name, value] of Object.entries(options.attributes ?? {})) {
    if (!ATTR_NAME.test(name)) return invalid(`Invalid attribute name "${name}".`, { attribute: name });
    if (/^on/i.test(name)) return invalid(`Event handler attribute "${name}" is not allowed on island markers.`, { attribute: name });
    if (reserved.has(name)) return invalid(`Attribute "${name}" is reserved by the island marker format.`, { attribute: name });
    attrs.push([name, value]);
  }
  const attrText = attrs.map(([name, value]) => ` ${name}="${escapeHtmlAttribute(value)}"`).join('');
  return ok(`<${tag}${attrText}>${script}${options.html}</${tag}>`);
}
