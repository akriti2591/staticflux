/**
 * Accessibility data for text elements (B2 → B6 seam; IF-7.12, IF-21.19): what the virtualized DOM projection needs to
 * expose canvas text to assistive technology — the plain text, paragraphs and lines with bounds (reading order,
 * find-in-page, magnifiers), links as named targets, the selection while editing, and a role (`textbox` while
 * editing, `heading` / `paragraph` from the element's semantic role otherwise). B6 owns the DOM; this module only
 * produces data in `@staticflux/surface`'s `AccessibleNode` shape plus the extra text structure.
 */
import type { AccessibleBounds, AccessibleNode } from '@staticflux/surface';
import type { Box, TextLayout } from './layout-result.js';
import type { TextBlockModel } from './rich-text.js';

export interface TextAccessibleLine {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly bounds: AccessibleBounds;
}

export interface TextAccessibleLink {
  readonly href: string;
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly bounds: AccessibleBounds;
}

export interface TextAccessibility {
  readonly id: string;
  readonly role: 'textbox' | 'heading' | 'paragraph' | 'note';
  /** Heading level when `role` is heading (from the element's semantic role, e.g. `headline` → 1). */
  readonly level?: number;
  readonly text: string;
  readonly paragraphs: readonly { readonly text: string; readonly start: number; readonly end: number; readonly bounds: AccessibleBounds }[];
  readonly lines: readonly TextAccessibleLine[];
  readonly links: readonly TextAccessibleLink[];
  /** While editing: the selection (UTF-16 offsets into `text`). */
  readonly selection?: readonly [number, number];
  readonly editing: boolean;
  readonly bounds: AccessibleBounds;
}

export interface TextAccessibilityOptions {
  readonly id: string;
  /** Semantic role of the element (document `role` field: `headline`, `subhead`, `body`, `legal`, …). */
  readonly semanticRole?: string;
  readonly editing?: boolean;
  readonly selection?: readonly [number, number];
  /** Block px → surface CSS px (the B6 layer's coordinate space). */
  readonly toSurface?: (box: Box) => Box;
}

/** Element role → (ARIA role, heading level). Data, not branches: extend the table for new semantic roles. */
export const SEMANTIC_TEXT_ROLES: Readonly<Record<string, { readonly role: TextAccessibility['role']; readonly level?: number }>> = Object.freeze({
  headline: { role: 'heading', level: 1 },
  title: { role: 'heading', level: 1 },
  subhead: { role: 'heading', level: 2 },
  heading: { role: 'heading', level: 2 },
  body: { role: 'paragraph' },
  legal: { role: 'note' },
  caption: { role: 'note' },
});

const toBounds = (b: Box): AccessibleBounds => ({ x: b.x0, y: b.y0, width: Math.max(0, b.x1 - b.x0), height: Math.max(0, b.y1 - b.y0) });

export function textAccessibility(block: TextBlockModel, layout: TextLayout, options: TextAccessibilityOptions): TextAccessibility {
  const map = options.toSurface ?? ((b: Box): Box => b);
  const semantic = SEMANTIC_TEXT_ROLES[options.semanticRole ?? 'body'] ?? { role: 'paragraph' as const };
  const lines = layout.lines().map((l) => ({ text: block.text.slice(l.start, l.end).replace(/\s+$/u, ''), start: l.start, end: l.end, bounds: toBounds(map(l.bounds)) }));
  const paragraphs = layout.paragraphs().map((p) => {
    const ls = layout.lines().filter((l) => l.paragraph === p.index);
    const x0 = Math.min(...ls.map((l) => l.bounds.x0));
    const x1 = Math.max(...ls.map((l) => l.bounds.x1));
    return { text: block.text.slice(p.start, p.end), start: p.start, end: p.end, bounds: toBounds(map({ x0: Number.isFinite(x0) ? x0 : 0, y0: p.top, x1: Number.isFinite(x1) ? x1 : 0, y1: p.bottom })) };
  });
  const links: TextAccessibleLink[] = [];
  for (const run of block.paragraphs.flatMap((p) => p.runs)) {
    if (run.style.link === undefined || run.end <= run.start) continue;
    const clusters = layout.clusters().filter((c) => c.start >= run.start && c.end <= run.end);
    const box = clusters.reduce<Box>((a, c) => ({ x0: Math.min(a.x0, c.bounds.x0), y0: Math.min(a.y0, c.bounds.y0), x1: Math.max(a.x1, c.bounds.x1), y1: Math.max(a.y1, c.bounds.y1) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
    const prev = links.at(-1);
    if (prev !== undefined && prev.href === run.style.link.href && prev.end === run.start) {
      links[links.length - 1] = { ...prev, end: run.end, text: block.text.slice(prev.start, run.end) };
      continue;
    }
    links.push({ href: run.style.link.href, text: block.text.slice(run.start, run.end), start: run.start, end: run.end, bounds: toBounds(map(clusters.length > 0 ? box : { x0: 0, y0: 0, x1: 0, y1: 0 })) });
  }
  const editing = options.editing === true;
  return {
    id: options.id,
    role: editing ? 'textbox' : semantic.role,
    ...(editing || semantic.level === undefined ? {} : { level: semantic.level }),
    text: block.text,
    paragraphs,
    lines,
    links,
    ...(editing && options.selection !== undefined ? { selection: options.selection } : {}),
    editing,
    bounds: toBounds(map({ x0: 0, y0: 0, x1: layout.width, y1: layout.height })),
  };
}

/** The same data as `AccessibleNode`s (the surface accessible layer's input): the element, its paragraphs and links. */
export function textAccessibleNode(data: TextAccessibility): AccessibleNode {
  const children: AccessibleNode[] = [
    ...data.paragraphs.map((p, i): AccessibleNode => ({ id: `${data.id}#p${i}`, role: 'paragraph', label: p.text, text: p.text, bounds: p.bounds })),
    ...data.links.map((l, i): AccessibleNode => ({ id: `${data.id}#link${i}`, role: 'link', label: l.text, description: l.href, text: l.text, bounds: l.bounds, focusable: true })),
  ];
  return {
    id: data.id,
    role: data.role,
    label: data.text.split('\n')[0] ?? '',
    text: data.text,
    bounds: data.bounds,
    focusable: true,
    ...(data.level === undefined ? {} : { description: `Heading level ${data.level}` }),
    children,
  };
}
