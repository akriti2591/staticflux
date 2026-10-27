/**
 * User-facing strings of Home (IF-16.2): a typed `@staticflux/i18n` catalog. `<if-home>` takes `I18nToken` as a lazy
 * dependency and shows the source text until it arrives.
 */
import type { DepHandle } from '@staticflux/core';
import { defineMessages, type I18n, type MessageArgs, type MessageRef } from '@staticflux/i18n';

export const homeMessages = /* @__PURE__ */ defineMessages('instaflow-home', {
  home: 'Instaflow home',
  newDesign: 'New design',
  heroBefore: 'Make something',
  heroBold: 'bold',
  heroAfter: 'today',
  heroLead: 'Open a blank canvas, or start from a template.',
  formats: 'Start a design',
  newFormats: 'New design formats',
  customSize: 'Custom size…',
  customSizeShort: 'Custom…',
  quickActions: 'Quick actions',
  recents: 'Jump back in',
  recentsEmpty: 'No designs yet. Choose New design or a quick action to start one.',
  templates: 'Templates',
  templatesEmpty: 'No templates yet. In Studio, choose “Save as template” to make one from a design.',
  templateMeta: 'Template · starts a new design',
  files: 'Files',
  filesEmpty: 'Your designs, templates and imported media appear here.',
  filesList: 'Files in this workspace',
  loading: 'Loading your workspace…',
  failed: 'Home could not read your workspace: {message}',
  retry: 'Try again',
  opening: 'Opening {title}…',
  edited: 'Edited {when}',
  size: '{width} × {height}',
  kindComposition: 'Design',
  kindTemplate: 'Template',
  kindMedia: 'Media',
  kindImage: 'Image',
  kindVector: 'SVG',
  kindFont: 'Font',
  // B11c: header and navigation (HOME-FILES §1.1)
  logo: 'Instaflow, go to Home',
  nav: 'Main',
  navHome: 'Home',
  navFiles: 'Files',
  navTemplates: 'Templates',
  navTrash: 'Trash',
  search: 'Search designs',
  searchResults: '{count, plural, one {# result} other {# results}} for “{query}”',
  noResults: 'No results for “{query}”',
  clearSearch: 'Clear',
  // First run (§1.4)
  welcomeTitle: 'Your designs live on this device',
  welcomeText: 'Instaflow saves as you work, in this browser.',
  welcomeKeep: 'Keep my designs on this device',
  welcomeDismiss: 'Dismiss',
  welcomeKept: 'Saved on this device',
  welcomeRefused: 'Chrome may clear this workspace under storage pressure. Pin this site to keep it.',
  formatsHint: 'Pick a size to start. You can change it later.',
  recentsEmptyCard: 'Your designs will appear here.',
  // Projects (§1.2, §2.3)
  projects: 'Projects',
  projectsEmpty: 'Group designs into projects',
  newProject: 'New project',
  newProjectName: 'Project name',
  createProject: 'Create',
  projectMeta: '{count, plural, =0 {Empty} one {# design} other {# designs}} · edited {when}',
  projectCount: '{count, plural, =0 {No designs yet} one {# design} other {# designs}}',
  projectBack: 'Back to Home',
  projectMenu: 'Project actions',
  renameProject: 'Rename project',
  deleteProject: 'Delete project',
  deleteProjectConfirm: 'Keep designs, delete project?',
  deleteProjectAction: 'Delete',
  projectEmpty: 'No designs in this project yet. Move designs here from their ⋯ menu, or drop files to import them.',
  noProject: 'No project',
  allProjects: 'All projects',
  newProjectEllipsis: 'New project…',
  // Cards and the file menu (§3, DENSITY §8.4)
  moreFor: 'More for {title}',
  favouriteOn: 'Add {title} to favourites',
  favouriteOff: 'Remove {title} from favourites',
  favourite: 'Favourite',
  selectFile: 'Select {title}',
  menuOpen: 'Open',
  menuOpenNewTab: 'Open in new tab',
  menuUse: 'Use template',
  menuEditTemplate: 'Edit template',
  menuRename: 'Rename',
  menuDuplicate: 'Duplicate',
  menuMove: 'Move to',
  menuFavourite: 'Add to favourites',
  menuUnfavourite: 'Remove from favourites',
  menuExport: 'Export…',
  menuCopyLink: 'Copy link',
  menuTrash: 'Move to trash',
  menuRestore: 'Restore',
  menuDeleteForever: 'Delete forever',
  use: 'Use',
  nameRequired: 'A name is required',
  titleLabel: 'Name of {title}',
  editedPages: 'Edited {when} · {pages, plural, one {# page} other {# pages}}',
  inProject: 'in {project}',
  // Files (§2.2)
  filesTitle: 'Files',
  filesFilter: 'Show',
  filterAll: 'All',
  filterDesigns: 'Designs',
  filterTemplates: 'Templates',
  filterMedia: 'Media',
  filterFavourites: 'Favourites',
  project: 'Project',
  sort: 'Sort',
  sortEdited: 'Last edited',
  sortCreated: 'Created',
  sortName: 'Name A–Z',
  sortKind: 'Kind',
  layout: 'View',
  layoutGrid: 'Grid',
  layoutList: 'List',
  import: 'Import',
  filesNothing: 'Nothing here yet.',
  colTitle: 'Name',
  colKind: 'Kind',
  colProject: 'Project',
  colEdited: 'Edited',
  colSize: 'Size',
  selected: '{count, plural, one {# selected} other {# selected}}',
  bulkActions: 'Selected files',
  bulkDuplicate: 'Duplicate',
  bulkTrash: 'Move to trash',
  bulkClear: 'Clear selection',
  bulkTrashConfirm: 'Move {count} files to trash?',
  confirmTrash: 'Move to trash',
  cancel: 'Cancel',
  // Trash (§2.4)
  trashTitle: 'Trash',
  trashKept: 'Items are kept for 30 days.',
  trashEmpty: 'The trash is empty.',
  emptyTrash: 'Empty trash',
  emptyTrashConfirm: 'Delete {count, plural, one {# file} other {# files}} forever? This can’t be undone.',
  deleteForeverConfirm: 'Delete forever? This can’t be undone.',
  deleteAction: 'Delete',
  trashedWhen: 'Moved to trash {when}',
  restore: 'Restore',
  deleteForever: 'Delete forever',
  // Templates page
  templatesTitle: 'Templates',
  // Toasts (§3)
  renamedTo: 'Renamed to “{title}”',
  duplicated: 'Duplicated “{title}”',
  movedTo: '{count, plural, one {Moved to {project}} other {Moved # files to {project}}}',
  movedOut: '{count, plural, one {Moved to No project} other {Moved # files to No project}}',
  trashedOne: 'Moved “{title}” to trash',
  trashedMany: 'Moved {count} files to trash',
  restored: '{count, plural, one {Restored “{title}”} other {Restored # files}}',
  deletedForever: '{count, plural, one {Deleted “{title}” forever} other {Deleted # files forever}}',
  projectRenamed: 'Renamed project to “{name}”',
  projectDeleted: 'Deleted project “{name}”',
  projectCreated: 'Made project “{name}”',
  linkCopied: 'Link copied',
  linkBlocked: 'Couldn’t copy the link. The browser blocked the clipboard.',
  imported: '{count, plural, one {Imported “{title}”} other {Imported # files}}',
  importedExisting: '{count, plural, one {“{title}” is already in this workspace} other {# files are already in this workspace}}',
  importing: 'Importing {done} of {total}…',
  importUnsupported: 'Couldn’t import “{name}”. Images, SVG and fonts are supported.',
  importVideo: 'Couldn’t import “{name}”. Video arrives with the Timeline lens.',
  importFailed: 'Couldn’t import “{name}”. {message}',
  importSkipped: '{count, plural, one {# file skipped} other {# files skipped}} (unsupported)',
  dropFiles: 'Drop files to import',
  undo: 'Undo',
  open: 'Open',
  failedAction: '{message}',
  // B11c slice 2: Settings, Home's shortcuts, Pro columns
  settings: 'Settings',
  homeShortcuts: 'Home',
  colPages: 'Pages',
  // Storage (§4)
  storageUsed: '{size} used on this device',
  storageFull: 'Storage is full. Your latest changes are kept until this tab closes. Free space by emptying the trash.',
  openTrash: 'Open Trash',
});

/** Format a message through the (lazy) I18n dependency, falling back to the source text (English plurals included). */
export function homeText<P>(i18n: DepHandle<I18n> | undefined, ref: MessageRef<P>, ...args: MessageArgs<P>): string {
  const service = i18n?.value;
  if (service !== undefined) return service.t(ref, ...args);
  return fallbackText(ref.source, (args[0] ?? {}) as Readonly<Record<string, unknown>>);
}

const PLURAL = /\{(\w+), plural, ((?:\s*(?:=\d+|zero|one|two|few|many|other) \{(?:[^{}]|\{[^{}]*\})*\})+)\s*\}/g;
const CASES = /(=\d+|zero|one|two|few|many|other) \{((?:[^{}]|\{[^{}]*\})*)\}/g;

/** The source text with `{name}` filled and `{n, plural, …}` chosen (English rules; `#` is the number). */
export function fallbackText(source: string, params: Readonly<Record<string, unknown>>, locale = 'en-GB'): string {
  const rules = new Intl.PluralRules(locale);
  const plural = source.replace(PLURAL, (_, name: string, body: string) => {
    const n = Number(params[name] ?? 0);
    const cases = new Map([...body.matchAll(CASES)].map((c) => [c[1] as string, c[2] as string]));
    const chosen = cases.get(`=${n}`) ?? cases.get(rules.select(n)) ?? cases.get('other') ?? '';
    return chosen.replace(/#/g, new Intl.NumberFormat(locale).format(n));
  });
  return plural.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''));
}

const UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ['year', 365 * 24 * 3600_000],
  ['month', 30 * 24 * 3600_000],
  ['week', 7 * 24 * 3600_000],
  ['day', 24 * 3600_000],
  ['hour', 3600_000],
  ['minute', 60_000],
];

/** "2 minutes ago", "yesterday", "now" (Intl, the page's locale); `iso` in the future reads as now. */
export function relativeTime(iso: string, now: number, locale?: string): string {
  const elapsed = Math.max(0, now - Date.parse(iso));
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, ms] of UNITS) {
    if (elapsed >= ms) return format.format(-Math.floor(elapsed / ms), unit);
  }
  return format.format(0, 'second');
}
