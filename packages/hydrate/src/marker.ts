/**
 * The island marker format (stable, `ISLAND_MARKER_FORMAT = 1`) and the DOM scanner.
 *
 * Two equivalent forms, emitted by any prerender/SSG step (see `serialize.ts`):
 *
 *   <sf-island chunk="feature:cart" hydrate="visible" props='{"sku":"a1"}' size="320x48">…static…</sf-island>
 *   <div data-sf-island="feature:cart" data-sf-hydrate="visible" data-sf-props='{"sku":"a1"}'>…static…</div>
 *
 * | attribute (element form) | attribute (data form) | meaning                                                    |
 * |--------------------------|-----------------------|------------------------------------------------------------|
 * | `chunk`                  | `data-sf-island`      | logical chunk id (`feature:x`) whose entry exports the island module |
 * | `hydrate`                | `data-sf-hydrate`     | `visible` (default — lazy by default, R12.12) · `idle` · `interaction` · `eager` · `never` |
 * | `props`                  | `data-sf-props`       | JSON props (HTML-attribute-escaped)                         |
 * | `island-id`              | `data-sf-island-id`   | stable id (default `<chunk>#<n>` in document order)         |
 * | `export`                 | `data-sf-export`      | named export holding the island module (default `hydrate` / `default`) |
 * | `reason`                 | `data-sf-reason`      | mandatory for `eager` (R12.12); without it → `idle` + `SF-HYD-008` |
 * | `size`                   | `data-sf-size`        | declared box `WxH` in CSS px (size-stable placeholder check, R12.19) |
 *
 * Large props may instead live in a DIRECT child
 * `<script type="application/sf-island-props+json">…</script>` (JSON with `<`, `>`, `&`, U+2028/9
 * escaped — `serializeIslandProps`). The attribute wins when both exist.
 * `hydrate="never"` islands are static only (no listeners, no chunk).
 */
import { err, ok, type Result, type SfError } from '@staticflux/core';
import { IslandEagerWithoutReasonError, IslandMarkerInvalidError, IslandPropsInvalidError } from './errors.js';

export const ISLAND_MARKER_FORMAT = 1;
export const ISLAND_TAG = 'sf-island';
export const ISLAND_PROPS_SCRIPT_TYPE = 'application/sf-island-props+json';
/** Reflected on every registered island element (CSS hook: `[sf-island-state=hydrated]`). */
export const ISLAND_STATE_ATTR = 'sf-island-state';

export const HYDRATE_STRATEGIES = ['visible', 'idle', 'interaction', 'eager', 'never'] as const;
export type HydrateStrategy = (typeof HYDRATE_STRATEGIES)[number];
/** Lazy by default (R12.12). */
export const DEFAULT_HYDRATE_STRATEGY: HydrateStrategy = 'visible';

export interface IslandAttributeNames {
  readonly chunk: string;
  readonly hydrate: string;
  readonly props: string;
  readonly id: string;
  readonly exportName: string;
  readonly reason: string;
  readonly size: string;
}

/** Attribute names of `<sf-island>`. */
export const ISLAND_ELEMENT_ATTRS: IslandAttributeNames = Object.freeze({
  chunk: 'chunk',
  hydrate: 'hydrate',
  props: 'props',
  id: 'island-id',
  exportName: 'export',
  reason: 'reason',
  size: 'size',
});

/** Attribute names of the `data-sf-island` form. */
export const ISLAND_DATA_ATTRS: IslandAttributeNames = Object.freeze({
  chunk: 'data-sf-island',
  hydrate: 'data-sf-hydrate',
  props: 'data-sf-props',
  id: 'data-sf-island-id',
  exportName: 'data-sf-export',
  reason: 'data-sf-reason',
  size: 'data-sf-size',
});

/** CSS selector matching both marker forms. */
export const ISLAND_SELECTOR = `${ISLAND_TAG}, [${ISLAND_DATA_ATTRS.chunk}]`;

export type IslandChunkId = `${string}:${string}`;

export interface IslandSize {
  readonly width: number;
  readonly height: number;
}

export type IslandPropsSource =
  | { readonly kind: 'attribute'; readonly raw: string }
  | { readonly kind: 'script'; readonly raw: string }
  | { readonly kind: 'none' };

/** One island found in the DOM. */
export interface IslandDescriptor {
  readonly id: string;
  readonly element: Element;
  readonly form: 'element' | 'attribute';
  readonly chunk: IslandChunkId;
  readonly strategy: HydrateStrategy;
  readonly exportName: string | undefined;
  readonly reason: string | undefined;
  readonly declaredSize: IslandSize | undefined;
  readonly props: IslandPropsSource;
}

export interface ScanResult {
  /** Islands in document order. */
  readonly islands: readonly IslandDescriptor[];
  /** Malformed markers (skipped) and downgrades (still listed). */
  readonly issues: readonly SfError[];
}

export interface ScanOptions {
  /** Id for islands without an explicit id. Default: `<chunk>#<n>` (per-chunk counter of this scan). */
  readonly idFor?: (chunk: IslandChunkId, element: Element) => string;
}

const CHUNK_ID = /^[a-z][a-z0-9-]*:[A-Za-z0-9._/-]+$/;

export function isIslandChunkId(value: string): value is IslandChunkId {
  return CHUNK_ID.test(value);
}

export function isHydrateStrategy(value: string): value is HydrateStrategy {
  return (HYDRATE_STRATEGIES as readonly string[]).includes(value);
}

/** `"320x200"` → `{ width: 320, height: 200 }`. */
export function parseIslandSize(value: string | null | undefined): IslandSize | undefined {
  if (value === null || value === undefined) return undefined;
  const match = /^\s*(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*$/i.exec(value);
  if (match === null) return undefined;
  return { width: Number(match[1]), height: Number(match[2]) };
}

export function formatIslandSize(size: IslandSize): string {
  return `${size.width}x${size.height}`;
}

/** Marker attribute names for an element, or undefined when it is not an island marker. */
export function islandAttributesOf(element: Element): IslandAttributeNames | undefined {
  if (element.localName === ISLAND_TAG) return ISLAND_ELEMENT_ATTRS;
  if (element.hasAttribute(ISLAND_DATA_ATTRS.chunk)) return ISLAND_DATA_ATTRS;
  return undefined;
}

function propsScriptOf(element: Element): Element | undefined {
  for (const child of Array.from(element.children)) {
    if (child.localName === 'script' && child.getAttribute('type') === ISLAND_PROPS_SCRIPT_TYPE) return child;
  }
  return undefined;
}

/** Read one marker. `id` is used when the marker carries no explicit id. */
export function readIslandMarker(element: Element, fallbackId: (chunk: IslandChunkId) => string): Result<{ descriptor: IslandDescriptor; issues: readonly SfError[] }> {
  const names = islandAttributesOf(element);
  if (names === undefined) {
    return err(IslandMarkerInvalidError({ message: 'Element is not an island marker.', details: { tag: element.localName } }));
  }
  const chunk = (element.getAttribute(names.chunk) ?? '').trim();
  if (!isIslandChunkId(chunk)) {
    return err(IslandMarkerInvalidError({ message: `Island marker has an invalid chunk id "${chunk}".`, details: { tag: element.localName, chunk } }));
  }
  const issues: SfError[] = [];
  const rawStrategy = element.getAttribute(names.hydrate)?.trim();
  let strategy: HydrateStrategy = DEFAULT_HYDRATE_STRATEGY;
  if (rawStrategy !== undefined && rawStrategy !== '') {
    if (isHydrateStrategy(rawStrategy)) strategy = rawStrategy;
    else {
      issues.push(IslandMarkerInvalidError({
        message: `Island "${chunk}" has an unknown hydrate strategy "${rawStrategy}"; using "${DEFAULT_HYDRATE_STRATEGY}".`,
        details: { chunk, hydrate: rawStrategy },
      }));
    }
  }
  const reason = element.getAttribute(names.reason)?.trim() || undefined;
  if (strategy === 'eager' && reason === undefined) {
    strategy = 'idle';
    issues.push(IslandEagerWithoutReasonError({ details: { chunk } }));
  }
  const rawSize = element.getAttribute(names.size);
  const declaredSize = parseIslandSize(rawSize);
  if (rawSize !== null && declaredSize === undefined) {
    issues.push(IslandMarkerInvalidError({ message: `Island "${chunk}" has an invalid size "${rawSize}" (expected WxH).`, details: { chunk, size: rawSize } }));
  }
  const attrProps = element.getAttribute(names.props);
  let props: IslandPropsSource = { kind: 'none' };
  if (attrProps !== null) props = { kind: 'attribute', raw: attrProps };
  else {
    const script = propsScriptOf(element);
    if (script !== undefined) props = { kind: 'script', raw: script.textContent ?? '' };
  }
  const explicitId = element.getAttribute(names.id)?.trim();
  return ok({
    descriptor: {
      id: explicitId !== undefined && explicitId !== '' ? explicitId : fallbackId(chunk),
      element,
      form: names === ISLAND_ELEMENT_ATTRS ? 'element' : 'attribute',
      chunk,
      strategy,
      exportName: element.getAttribute(names.exportName)?.trim() || undefined,
      reason,
      declaredSize,
      props,
    },
    issues,
  });
}

/** Find every island marker under `root` (including `root` itself), in document order. */
export function scanIslands(root: ParentNode, options: ScanOptions = {}): ScanResult {
  const counters = new Map<string, number>();
  const idFor = options.idFor ?? ((chunk: IslandChunkId): string => {
    const n = counters.get(chunk) ?? 0;
    counters.set(chunk, n + 1);
    return `${chunk}#${n}`;
  });
  const elements: Element[] = [];
  if (isElement(root) && islandAttributesOf(root) !== undefined) elements.push(root);
  elements.push(...Array.from(root.querySelectorAll(ISLAND_SELECTOR)));
  const islands: IslandDescriptor[] = [];
  const issues: SfError[] = [];
  for (const element of elements) {
    const read = readIslandMarker(element, (chunk) => idFor(chunk, element));
    if (!read.ok) {
      issues.push(read.error);
      continue;
    }
    islands.push(read.value.descriptor);
    issues.push(...read.value.issues);
  }
  return { islands, issues };
}

/** Parse an island's props (`undefined` when it has none). */
export function parseIslandProps(descriptor: Pick<IslandDescriptor, 'chunk' | 'id' | 'props'>): Result<unknown> {
  if (descriptor.props.kind === 'none') return ok(undefined);
  try {
    return ok(JSON.parse(descriptor.props.raw) as unknown);
  } catch (cause) {
    return err(IslandPropsInvalidError({
      message: `Island "${descriptor.id}" has props that are not valid JSON.`,
      details: { island: descriptor.id, chunk: descriptor.chunk, source: descriptor.props.kind },
      cause,
    }));
  }
}

/** The island element that owns `node` (nearest marker ancestor-or-self). */
export function closestIsland(node: Node | null): Element | undefined {
  let current: Node | null = node;
  while (current !== null) {
    if (isElement(current) && islandAttributesOf(current) !== undefined) return current;
    current = current.parentNode;
  }
  return undefined;
}

function isElement(node: unknown): node is Element {
  return typeof node === 'object' && node !== null && (node as Node).nodeType === 1;
}
