/**
 * Boot-plan preload tags for index.html (R12.10): `<link rel="modulepreload">` for every JS
 * file of the profile's boot set and `<link rel="preload" as="style">` for its CSS, with the
 * isolation policy's `crossorigin` (R11.16b). URLs already referenced by the HTML (Vite's own
 * entry preloads) are skipped.
 */
import type { CrossOriginAttr } from './isolation.js';

/** Structural `HtmlTagDescriptor` (Vite). */
export interface PreloadTag {
  readonly tag: 'link';
  readonly attrs: Readonly<Record<string, string | boolean>>;
  readonly injectTo: 'head';
}

export interface PreloadTagOptions {
  readonly modulepreload: readonly string[];
  readonly stylesheets: readonly string[];
  readonly crossorigin: CrossOriginAttr;
  /** SRI per URL (from manifest `integrity`). */
  readonly integrity?: ReadonlyMap<string, string>;
  /** Existing HTML: URLs it already references are not injected again. */
  readonly html?: string;
}

function referenced(html: string | undefined, url: string): boolean {
  if (html === undefined) return false;
  return html.includes(`"${url}"`) || html.includes(`'${url}'`) || html.includes(`=${url} `) || html.includes(`=${url}>`);
}

export function preloadTags(options: PreloadTagOptions): readonly PreloadTag[] {
  const tags: PreloadTag[] = [];
  for (const href of options.modulepreload) {
    if (referenced(options.html, href)) continue;
    const integrity = options.integrity?.get(href);
    tags.push({
      tag: 'link',
      attrs: { rel: 'modulepreload', href, crossorigin: options.crossorigin, ...(integrity === undefined ? {} : { integrity }) },
      injectTo: 'head',
    });
  }
  for (const href of options.stylesheets) {
    if (referenced(options.html, href)) continue;
    tags.push({ tag: 'link', attrs: { rel: 'preload', as: 'style', href, crossorigin: options.crossorigin }, injectTo: 'head' });
  }
  return tags;
}

const escapeAttr = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Render tags as HTML (for per-profile boot HTML outside Vite, e.g. an edge function). */
export function renderTags(tags: readonly PreloadTag[]): string {
  return tags
    .map((t) => {
      const attrs = Object.entries(t.attrs)
        .flatMap(([k, v]) => (v === false ? [] : [v === true ? k : `${k}="${escapeAttr(v)}"`]))
        .join(' ');
      return `<${t.tag} ${attrs}>`;
    })
    .join('\n');
}
