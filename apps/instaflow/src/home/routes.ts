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
import { DESIGN_FORMAT_IDS, type DesignFormatId } from './formats.js';

export const homeRoute = /* @__PURE__ */ defineRoute({ id: 'instaflow/home', path: '/', description: 'Home: recents, files, templates, quick actions (no engine).' });

export const studioRoute = /* @__PURE__ */ defineRoute({ id: 'instaflow/studio', path: '/s/:asset', description: 'Studio on one design.' });

export const newDesignRoute = /* @__PURE__ */ defineRoute({
  id: 'instaflow/new-design',
  path: '/new',
  search: { format: searchParam.enum(DESIGN_FORMAT_IDS), template: searchParam.string() },
  description: 'Studio creating a new design from a format or a template.',
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

/** Studio creating a new design (a format, or a new document from a template). */
export function newDesignHref(from: { readonly format?: DesignFormatId; readonly template?: string } = {}): Result<string> {
  return instaflowRoutes().build({ to: newDesignRoute, search: from });
}

/** What a Studio URL asks for: an existing design, a new one, or neither (the dev entry's demo document). */
export type StudioIntent =
  | { readonly kind: 'open'; readonly asset: string }
  | { readonly kind: 'new'; readonly format: DesignFormatId | undefined; readonly template: string | undefined }
  | { readonly kind: 'demo' };

/** Read a Studio URL (`pathname + search`). */
export function readStudioIntent(href: string): StudioIntent {
  const match = instaflowRoutes().match(href);
  if (isMatchOf(match, studioRoute) && match.params.asset.length > 0) return { kind: 'open', asset: decodeURIComponent(match.params.asset) };
  if (isMatchOf(match, newDesignRoute)) {
    const { format, template } = match.search;
    return { kind: 'new', format, template: template === undefined || template.length === 0 ? undefined : template };
  }
  return { kind: 'demo' };
}
