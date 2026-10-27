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

// B11c (HOME-FILES §2, NAVIGATION §2.1): Home's own pages — one boot, moved between with history.
/** Files' list state (HOME-FILES §2.2; NAVIGATION §2.2: view params, replaced in history, remembered per device). */
export const FILES_FILTERS = ['all', 'designs', 'templates', 'media', 'favourites'] as const;
export type FilesFilter = (typeof FILES_FILTERS)[number];
export const FILES_SORTS = ['edited', 'created', 'name', 'kind'] as const;
export type FilesSort = (typeof FILES_SORTS)[number];
export const FILES_LAYOUTS = ['grid', 'list'] as const;
export type FilesLayout = (typeof FILES_LAYOUTS)[number];

export const filesRoute = /* @__PURE__ */ defineRoute({
  id: 'instaflow/files',
  path: '/files',
  search: { q: searchParam.string(), filter: searchParam.enum(FILES_FILTERS), sort: searchParam.enum(FILES_SORTS), view: searchParam.enum(FILES_LAYOUTS) },
  description: 'Files: everything in the workspace, with filters, sort, grid or list, and search.',
});

export const templatesRoute = /* @__PURE__ */ defineRoute({ id: 'instaflow/templates', path: '/templates', description: 'The workspace’s templates.' });

export const projectRoute = /* @__PURE__ */ defineRoute({ id: 'instaflow/project', path: '/p/:name', description: 'One project’s designs.' });

export const trashRoute = /* @__PURE__ */ defineRoute({ id: 'instaflow/trash', path: '/trash', description: 'The trash: restore or delete forever (kept 30 days).' });

export const INSTAFLOW_ROUTES = [homeRoute, studioRoute, newDesignRoute, filesRoute, projectRoute, templatesRoute, trashRoute] as const;

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

/** Which Home page a URL shows (B11c). */
export type HomeView =
  | { readonly kind: 'home' }
  | { readonly kind: 'files'; readonly query?: string; readonly filter?: FilesFilter; readonly sort?: FilesSort; readonly layout?: FilesLayout }
  | { readonly kind: 'project'; readonly name: string }
  | { readonly kind: 'templates' }
  | { readonly kind: 'trash' };

export type HomeViewKind = HomeView['kind'];

/** The href of a Home page. */
export function homeViewHref(view: HomeView): Result<string> {
  const routes = instaflowRoutes();
  const HREFS: Readonly<Record<HomeView['kind'], () => Result<string>>> = {
    home: () => routes.build({ to: homeRoute }),
    files: () => {
      const f = view as Extract<HomeView, { kind: 'files' }>;
      const q = f.query?.trim();
      return routes.build({
        to: filesRoute,
        search: {
          ...(q === undefined || q === '' ? {} : { q }),
          ...(f.filter === undefined || f.filter === 'all' ? {} : { filter: f.filter }),
          ...(f.sort === undefined || f.sort === 'edited' ? {} : { sort: f.sort }),
          ...(f.layout === undefined ? {} : { view: f.layout }),
        },
      });
    },
    project: () => routes.build({ to: projectRoute, params: { name: (view as Extract<HomeView, { kind: 'project' }>).name } }),
    templates: () => routes.build({ to: templatesRoute }),
    trash: () => routes.build({ to: trashRoute }),
  };
  return HREFS[view.kind]();
}

/** The Home page for a URL (`pathname + search`); anything else is Home itself. */
export function readHomeView(href: string): HomeView {
  const match = instaflowRoutes().match(href);
  if (isMatchOf(match, filesRoute)) {
    const { q, filter, sort, view } = match.search;
    return {
      kind: 'files',
      ...(q === undefined || q.trim() === '' ? {} : { query: q }),
      ...(filter === undefined ? {} : { filter }),
      ...(sort === undefined ? {} : { sort }),
      ...(view === undefined ? {} : { layout: view }),
    };
  }
  if (isMatchOf(match, projectRoute) && match.params.name.length > 0) return { kind: 'project', name: decodeURIComponent(match.params.name) };
  if (isMatchOf(match, templatesRoute)) return { kind: 'templates' };
  if (isMatchOf(match, trashRoute)) return { kind: 'trash' };
  return { kind: 'home' };
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
