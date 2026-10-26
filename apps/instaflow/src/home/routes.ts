/**
 * The three surfaces' routes (D17; `docs/instaflow/EDITOR-AS-PRIMITIVE.md`), as typed values (rule 1): Home at `/`,
 * Studio on an asset at `/s/:asset`, and `/new` (Studio creating a design from a format or a template, then replacing
 * the URL with `/s/:asset`). Chat (`/c/:thread`) arrives in M2.
 *
 * Home and Studio are separate pages (separate boots: Home loads no engine), so a link between them is a full
 * navigation; these routes build and match the hrefs on both sides.
 */
import type { Result } from '@staticflux/core';
import { createRouteTable, defineRoute, isMatchOf, type RouteTable, searchParam } from '@staticflux/router';
import { CUSTOM_FORMAT, DESIGN_PAGE_LIMITS, DESIGN_SIZE_LIMITS, NEW_DESIGN_FORMAT_IDS, type NewDesignFormatId } from './formats.js';
import type { DesignSize } from './index-record.js';

/** The units New design converts with (the kit size field's; a display choice, the page is always in px). */
export const DESIGN_UNITS = ['px', 'mm', 'in', 'pt'] as const;
export type DesignUnit = (typeof DESIGN_UNITS)[number];

export const homeRoute = /* @__PURE__ */ defineRoute({ id: 'instaflow/home', path: '/', description: 'Home: recents, files, templates, quick actions (no engine).' });

export const studioRoute = /* @__PURE__ */ defineRoute({ id: 'instaflow/studio', path: '/s/:asset', description: 'Studio on one design.' });

export const newDesignRoute = /* @__PURE__ */ defineRoute({
  id: 'instaflow/new-design',
  path: '/new',
  search: {
    format: searchParam.enum(NEW_DESIGN_FORMAT_IDS),
    template: searchParam.string(),
    // B11b (HOME-FILES §1.3, NAVIGATION §2.2): the New design dialog's choices.
    w: searchParam.number(),
    h: searchParam.number(),
    unit: searchParam.enum(DESIGN_UNITS),
    pages: searchParam.number(),
    name: searchParam.string(),
    bg: searchParam.string(),
  },
  description: 'Studio creating a new design from a format (or a custom size) or a template.',
});

export const INSTAFLOW_ROUTES = [homeRoute, studioRoute, newDesignRoute] as const;

let table: RouteTable | undefined;

/** The route table (built once). */
export function instaflowRoutes(): RouteTable {
  if (table === undefined) {
    const built = createRouteTable(INSTAFLOW_ROUTES);
    if (!built.ok) throw built.error; // static data: a failure here is a programming error caught by the tests
    table = built.value;
  }
  return table;
}

/** Home's href. */
export function homeHref(): Result<string> {
  return instaflowRoutes().build({ to: homeRoute });
}

/** Studio on an existing design. */
export function studioHref(asset: string): Result<string> {
  return instaflowRoutes().build({ to: studioRoute, params: { asset } });
}

/** What New design asks Studio for (HOME-FILES §1.3): a format or a custom size, or a template; pages, name, background. */
export interface NewDesignRequest {
  readonly format?: NewDesignFormatId;
  readonly template?: string;
  /** `custom` only: the page size in px. */
  readonly size?: DesignSize;
  readonly unit?: DesignUnit;
  readonly pages?: number;
  readonly name?: string;
  /** The pages' background (`#rrggbb`). */
  readonly background?: string;
}

/** Studio creating a new design (a format, a custom size, or a new document from a template). */
export function newDesignHref(from: NewDesignRequest = {}): Result<string> {
  const search = {
    ...(from.format === undefined ? {} : { format: from.format }),
    ...(from.template === undefined ? {} : { template: from.template }),
    ...(from.size === undefined ? {} : { w: from.size.width, h: from.size.height }),
    ...(from.unit === undefined || from.unit === 'px' ? {} : { unit: from.unit }),
    ...(from.pages === undefined ? {} : { pages: from.pages }),
    ...(from.name === undefined || from.name.trim() === '' ? {} : { name: from.name.trim() }),
    ...(from.background === undefined ? {} : { bg: from.background }),
  };
  return instaflowRoutes().build({ to: newDesignRoute, search });
}

/** What a Studio URL asks for: an existing design, a new one, or neither (the dev entry's demo document). */
export type StudioIntent =
  | { readonly kind: 'open'; readonly asset: string }
  | {
      readonly kind: 'new';
      readonly format: NewDesignFormatId | undefined;
      readonly template: string | undefined;
      /** B11b: a custom size (whole px, 1…16 384 a side), pages (1…50), a name and a background, when asked for. */
      readonly size?: DesignSize;
      readonly pages?: number;
      readonly name?: string;
      readonly background?: string;
    }
  | { readonly kind: 'demo' };

/** Read a Studio URL (`pathname + search`). */
export function readStudioIntent(href: string): StudioIntent {
  const match = instaflowRoutes().match(href);
  if (isMatchOf(match, studioRoute) && match.params.asset.length > 0) return { kind: 'open', asset: decodeURIComponent(match.params.asset) };
  if (isMatchOf(match, newDesignRoute)) {
    const { format, template, w, h, pages, name, bg } = match.search;
    const side = (n: number | undefined): number | undefined => (n !== undefined && Number.isInteger(n) && n >= DESIGN_SIZE_LIMITS.min && n <= DESIGN_SIZE_LIMITS.max ? n : undefined);
    const width = side(w);
    const height = side(h);
    const count = pages !== undefined && Number.isInteger(pages) && pages >= DESIGN_PAGE_LIMITS.min && pages <= DESIGN_PAGE_LIMITS.max ? pages : undefined;
    const title = name?.trim().slice(0, 200);
    return {
      kind: 'new',
      format,
      template: template === undefined || template.length === 0 ? undefined : template,
      ...(format === CUSTOM_FORMAT && width !== undefined && height !== undefined ? { size: { width, height } } : {}),
      ...(count === undefined ? {} : { pages: count }),
      ...(title === undefined || title === '' ? {} : { name: title }),
      ...(bg !== undefined && /^#[0-9a-fA-F]{6}$/.test(bg) ? { background: bg.toLowerCase() } : {}),
    };
  }
  return { kind: 'demo' };
}
