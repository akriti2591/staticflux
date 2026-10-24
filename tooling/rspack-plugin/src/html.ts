/**
 * Boot-plan preload tags (R12.10) for `HtmlRspackPlugin` / `html-webpack-plugin`
 * (`getCompilationHooks(compilation).alterAssetTags`), with `crossorigin` per isolation (R11.16b).
 */
import type { CompilationLike } from './compilation.js';
import type { CrossOriginAttr } from './isolation.js';

/** `HtmlRspackPlugin` / html-webpack-plugin tag object. */
export interface HtmlTagLike {
  tagName: string;
  attributes: Record<string, string | boolean | undefined | null>;
  voidTag: boolean;
  innerHTML?: string;
}

export interface AlterAssetTagsData {
  assetTags: { scripts: HtmlTagLike[]; styles: HtmlTagLike[]; meta: HtmlTagLike[] };
  readonly outputName?: string;
}

/** The static side of `HtmlRspackPlugin` (or `HtmlWebpackPlugin`) the plugin hooks into. */
export interface HtmlPluginLike {
  getCompilationHooks(compilation: CompilationLike): {
    readonly alterAssetTags: { tapPromise(name: string, fn: (data: AlterAssetTagsData) => Promise<AlterAssetTagsData>): void };
  };
}

export interface PreloadTagOptions {
  readonly modulepreload: readonly string[];
  readonly stylesheets: readonly string[];
  readonly crossorigin: CrossOriginAttr;
  readonly integrity?: ReadonlyMap<string, string>;
  /** URLs already present in the page's tags (skipped). */
  readonly existing?: ReadonlySet<string>;
}

export function preloadTags(options: PreloadTagOptions): HtmlTagLike[] {
  const tags: HtmlTagLike[] = [];
  const crossorigin = options.crossorigin === true ? '' : options.crossorigin;
  for (const href of options.modulepreload) {
    if (options.existing?.has(href) === true) continue;
    const integrity = options.integrity?.get(href);
    tags.push({
      tagName: 'link',
      voidTag: true,
      attributes: { rel: 'modulepreload', href, crossorigin, ...(integrity === undefined ? {} : { integrity }) },
    });
  }
  for (const href of options.stylesheets) {
    if (options.existing?.has(href) === true) continue;
    tags.push({ tagName: 'link', voidTag: true, attributes: { rel: 'preload', as: 'style', href, crossorigin } });
  }
  return tags;
}

/** URLs referenced by existing tags (`src` / `href`). */
export function referencedUrls(data: AlterAssetTagsData): ReadonlySet<string> {
  const out = new Set<string>();
  for (const tag of [...data.assetTags.scripts, ...data.assetTags.styles, ...data.assetTags.meta]) {
    for (const key of ['src', 'href']) {
      const value = tag.attributes[key];
      if (typeof value === 'string') out.add(value);
    }
  }
  return out;
}
