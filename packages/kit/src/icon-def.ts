/**
 * Icon data (`IconDef`) and its SVG builder — no element code, so the generated icon modules
 * (`./icons/*.ts`) stay data only and tree-shake to what a surface imports. Rendered by
 * `<sf-icon>` (`./icon.ts`).
 */
/** SVG child elements an icon may use (Lucide's vocabulary). */
export type IconTag = 'path' | 'circle' | 'rect' | 'line' | 'polyline' | 'polygon' | 'ellipse';

/** One SVG child: tag + attributes (no `style`, no event handlers: data only). */
export type IconNode = readonly [tag: IconTag, attributes: Readonly<Record<string, string>>];

export type IconSource = 'lucide' | 'custom';

/** An icon: its kebab-case name, its SVG children on the 24-unit grid, and where it comes from. */
export interface IconDef {
  readonly kind: 'icon';
  readonly name: string;
  readonly nodes: readonly IconNode[];
  readonly source: IconSource;
}

export type IconSize = 16 | 18 | 24;

export const ICON_SIZES: readonly IconSize[] = [16, 18, 24];

const ICON_TAGS: ReadonlySet<string> = new Set<IconTag>(['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse']);
const ICON_ATTRIBUTE = /^(?:d|cx|cy|r|rx|ry|x|y|x1|x2|y1|y2|width|height|points|fill|fill-opacity|stroke|stroke-dasharray|stroke-width|opacity|transform)$/;

/** Declare an icon (data). Used by the generated icon modules. */
/* @__NO_SIDE_EFFECTS__ */
export function defineIcon(name: string, nodes: readonly IconNode[], source: IconSource = 'lucide'): IconDef {
  return Object.freeze({ kind: 'icon', name, nodes: Object.freeze(nodes.map((node) => Object.freeze([node[0], Object.freeze({ ...node[1] })] as const))), source });
}

/** Stroke width on the 24-unit viewBox for a rendered size (STUDIO-UX-SPEC §10.2 point 6). */
export function iconStrokeWidth(size: IconSize): number {
  return size === 16 ? 1.75 : 2;
}

/** Problems with an icon's data (unknown tags or attributes); empty when it is safe to render. */
export function iconProblems(icon: IconDef): string[] {
  const problems: string[] = [];
  icon.nodes.forEach(([tag, attributes], index) => {
    if (!ICON_TAGS.has(tag)) problems.push(`${icon.name}[${index}]: tag <${tag}> is not allowed`);
    for (const key of Object.keys(attributes)) if (!ICON_ATTRIBUTE.test(key)) problems.push(`${icon.name}[${index}]: attribute "${key}" is not allowed`);
  });
  return problems;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Build the `<svg>` for an icon (DOM, no markup parsing). Unknown tags and attributes are skipped. */
export function iconElement(icon: IconDef, doc: Document = document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attributes] of icon.nodes) {
    if (!ICON_TAGS.has(tag)) continue;
    const child = doc.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attributes)) if (ICON_ATTRIBUTE.test(key)) child.setAttribute(key, value);
    svg.append(child);
  }
  return svg;
}
