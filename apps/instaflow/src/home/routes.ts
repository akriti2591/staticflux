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

/** Settings' sections (STUDIO §2.4; NAVIGATION §2.1: `/settings/:section?`, `general` by default). */
export const SETTINGS_SECTION_IDS = ['general', 'shortcuts', 'storage', 'about'] as const;
export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

/** Studio's place-within params (NAVIGATION §2.2): view (`lens`, `page`, `dock`) and intents consumed once (`el`, `inspect`). */
export const STUDIO_LENSES = ['canvas', 'pages'] as const;
export type StudioLens = (typeof STUDIO_LENSES)[number];
export const STUDIO_DOCK_TABS = ['layers', 'pages', 'assets', 'milestones'] as const;
export type StudioDockTab = (typeof STUDIO_DOCK_TABS)[number];
/** Inspector sections a link may reveal (`?inspect=`; the inspector's own ids). */
export const INSPECT_SECTIONS = ['page', 'document', 'transform', 'text', 'image', 'frame', 'repeat', 'combine', 'mask', 'fill', 'stroke', 'corners', 'effects', 'layer'] as const;
export type InspectSection = (typeof INSPECT_SECTIONS)[number];
/** Routable dialogs (NAVIGATION §2.1: `<surface path>/d/:dialog`). */
export const STUDIO_DIALOGS = ['export', 'settings'] as const;
export type StudioDialog = (typeof STUDIO_DIALOGS)[number];

const studioSearch = {
  lens: searchParam.enum(STUDIO_LENSES),
  page: searchParam.string(),
  dock: searchParam.enum(STUDIO_DOCK_TABS),
  el: searchParam.string(),
  inspect: searchParam.enum(INSPECT_SECTIONS),
};

export const studioRoute = /* @__PURE__ */ defineRoute({ id: 'instaflow/studio', path: '/s/:asset', search: studioSearch, description: 'Studio on one design.' });

export const studioDialogRoute = /* @__PURE__ */ defineRoute({
  id: 'instaflow/studio-dialog',
  path: '/s/:asset/d/:dialog',
  search: { ...studioSearch, section: searchParam.enum(SETTINGS_SECTION_IDS) },
  description: 'Studio on one design with a routable dialog open (export, settings).',
});

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

export const settingsRoute = /* @__PURE__ */ defineRoute({ id: 'instaflow/settings', path: '/settings', description: 'Settings as a page in Home’s shell (General).' });
export const settingsSectionRoute = /* @__PURE__ */ defineRoute({ id: 'instaflow/settings-section', path: '/settings/:section', description: 'One Settings section as a page in Home’s shell.' });

export const projectRoute = /* @__PURE__ */ defineRoute({ id: 'instaflow/project', path: '/p/:name', description: 'One project’s designs.' });

export const trashRoute = /* @__PURE__ */ defineRoute({ id: 'instaflow/trash', path: '/trash', description: 'The trash: restore or delete forever (kept 30 days).' });

export const INSTAFLOW_ROUTES = [homeRoute, studioRoute, studioDialogRoute, newDesignRoute, filesRoute, projectRoute, templatesRoute, trashRoute, settingsRoute, settingsSectionRoute] as const;

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
  | { readonly kind: 'trash' }
  | { readonly kind: 'settings'; readonly section?: SettingsSectionId };

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
    settings: () => {
      const section = (view as Extract<HomeView, { kind: 'settings' }>).section;
      return section === undefined || section === 'general' ? routes.build({ to: settingsRoute }) : routes.build({ to: settingsSectionRoute, params: { section } });
    },
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
  if (isMatchOf(match, projectRoute) && match.params.name.length > 0) return { kind: 'project', name: match.params.name };
  if (isMatchOf(match, templatesRoute)) return { kind: 'templates' };
  if (isMatchOf(match, trashRoute)) return { kind: 'trash' };
  if (isMatchOf(match, settingsRoute)) return { kind: 'settings' };
  if (isMatchOf(match, settingsSectionRoute)) {
    const section = match.params.section;
    return (SETTINGS_SECTION_IDS as readonly string[]).includes(section) ? { kind: 'settings', section: section as SettingsSectionId } : { kind: 'settings' };
  }
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

/** Where within a design a link points (NAVIGATION §2.2, §6): view params, intents consumed once, a routable dialog. */
export interface StudioLink {
  readonly dialog?: StudioDialog;
  /** A `/d/<key>` this build does not have (dropped; the path is replaced by its parent, §4). */
  readonly unknownDialog?: string;
  readonly section?: SettingsSectionId;
  readonly lens?: StudioLens;
  readonly page?: string;
  readonly dock?: StudioDockTab;
  /** Element ids to select and zoom to (≤ 20). */
  readonly el?: readonly string[];
  readonly inspect?: InspectSection;
}

/** Up to 20 element ids from `el=` (comma-separated, empty and repeated ones dropped). */
export function readElementIds(raw: string | undefined): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  const ids = [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0))].slice(0, 20);
  return ids.length === 0 ? undefined : ids;
}

/** The href of a place in a design (NAVIGATION §5 "Copy link to this"): path, then lens, page, dock, el, inspect, dialog params. */
export function studioLinkHref(asset: string, link: StudioLink = {}): Result<string> {
  const search = {
    ...(link.lens === undefined || link.lens === 'canvas' ? {} : { lens: link.lens }),
    ...(link.page === undefined ? {} : { page: link.page }),
    ...(link.dock === undefined ? {} : { dock: link.dock }),
    ...(link.el === undefined || link.el.length === 0 ? {} : { el: link.el.slice(0, 20).join(',') }),
    ...(link.inspect === undefined ? {} : { inspect: link.inspect }),
  };
  if (link.dialog === undefined) return instaflowRoutes().build({ to: studioRoute, params: { asset }, search });
  return instaflowRoutes().build({ to: studioDialogRoute, params: { asset, dialog: link.dialog }, search: { ...search, ...(link.dialog === 'settings' && link.section !== undefined ? { section: link.section } : {}) } });
}

/** A link without its intents (`el`, `inspect`): what the URL keeps once they are consumed (§6 step 7). */
export function withoutIntents(link: StudioLink): StudioLink {
  const { el: _el, inspect: _inspect, unknownDialog: _unknown, ...rest } = link;
  return rest;
}

/** What a Studio URL asks for: an existing design, a new one, or neither (the dev entry's demo document). */
export type StudioIntent =
  | { readonly kind: 'open'; readonly asset: string; readonly link?: StudioLink }
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
  const linkOf = (q: { lens?: StudioLens | undefined; page?: string | undefined; dock?: StudioDockTab | undefined; el?: string | undefined; inspect?: InspectSection | undefined }): StudioLink => {
    const el = readElementIds(q.el);
    return {
      ...(q.lens === undefined ? {} : { lens: q.lens }),
      ...(q.page === undefined || q.page.length === 0 ? {} : { page: q.page }),
      ...(q.dock === undefined ? {} : { dock: q.dock }),
      ...(el === undefined ? {} : { el }),
      ...(q.inspect === undefined ? {} : { inspect: q.inspect }),
    };
  };
  const open = (asset: string, link: StudioLink): StudioIntent => (Object.keys(link).length === 0 ? { kind: 'open', asset } : { kind: 'open', asset, link });
  if (isMatchOf(match, studioRoute) && match.params.asset.length > 0) return open(match.params.asset, linkOf(match.search));
  if (isMatchOf(match, studioDialogRoute) && match.params.asset.length > 0) {
    const dialog = match.params.dialog;
    const known = (STUDIO_DIALOGS as readonly string[]).includes(dialog);
    const section = match.search.section;
    return open(match.params.asset, {
      ...linkOf(match.search),
      ...(known ? { dialog: dialog as StudioDialog } : { unknownDialog: dialog }),
      ...(known && dialog === 'settings' && section !== undefined ? { section } : {}),
    });
  }
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
