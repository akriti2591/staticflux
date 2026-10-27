/**
 * Home's actions as capabilities (D18; C0 IF-28.9–28.11): "New design" (from a format), "Open design" and "Use
 * template". Home's buttons, cards and keyboard paths run them through the one capability pipeline, and agents call
 * the same declarations (they are described with typed input and output, `exposeToAgents`). Each one resolves to the
 * Studio href it opens and asks the host to go there: Home has no engine, so the work itself happens in Studio.
 *
 * Quick actions (`HOME_QUICK_ACTIONS`) are data rows over these capabilities, so a later quick action (remove
 * background, resize for socials, M2) is one more row with its own capability, never a branch in Home.
 */
import { type CapabilityInput, type CapabilityOutput, defineCapability, s } from '@staticflux/capabilities';
import type { LensId } from '../theme/lenses.js';
import { DESIGN_FORMAT_IDS, DESIGN_PAGE_LIMITS, DESIGN_SIZE_LIMITS, type DesignFormatId, designFormat, NEW_DESIGN_FORMAT_IDS } from './formats.js';
import { DESIGN_UNITS } from './routes.js';

const href = s.object({ href: s.string({ description: 'The Studio URL that was opened' }) });

export const NewDesignCapability = /* @__PURE__ */ defineCapability({
  id: 'instaflow/new-design',
  title: 'New design',
  description:
    'Start a new, empty design in Studio. `format` picks the page size and page count (default: a square post, 1080 × 1080); `custom` takes `width` and `height` in px (1…16 384). `pages`, `name` and `background` override the format’s.',
  input: s.object({
    format: s.optional(s.enum(NEW_DESIGN_FORMAT_IDS, { description: 'post, story, landscape, slides, poster, letter, carousel or custom' })),
    width: s.optional(s.number({ min: DESIGN_SIZE_LIMITS.min, max: DESIGN_SIZE_LIMITS.max, integer: true, description: 'custom: page width in px' })),
    height: s.optional(s.number({ min: DESIGN_SIZE_LIMITS.min, max: DESIGN_SIZE_LIMITS.max, integer: true, description: 'custom: page height in px' })),
    unit: s.optional(s.enum(DESIGN_UNITS, { description: 'The unit the size was chosen in (display only)' })),
    pages: s.optional(s.number({ min: DESIGN_PAGE_LIMITS.min, max: DESIGN_PAGE_LIMITS.max, integer: true, description: 'Page count (default: the format’s)' })),
    name: s.optional(s.string({ maxLength: 200, description: 'The design’s title (default: Untitled design)' })),
    background: s.optional(s.string({ pattern: '^#[0-9a-fA-F]{6}$', description: 'The pages’ background, #rrggbb (default: white)' })),
  }),
  output: href,
  requiresConfirmation: false,
  destructive: false,
});

export const OpenDesignCapability = /* @__PURE__ */ defineCapability({
  id: 'instaflow/open-design',
  title: 'Open design',
  description: 'Open a design from the workspace (one of Home’s recents or files) in Studio.',
  input: s.object({ asset: s.string({ minLength: 1, maxLength: 120, description: 'The asset id, e.g. "as_…"' }) }),
  output: href,
  requiresConfirmation: false,
  destructive: false,
});

export const UseTemplateCapability = /* @__PURE__ */ defineCapability({
  id: 'instaflow/use-template',
  title: 'Use template',
  description: 'Start a new design from a workspace template (B5: a new document from the template’s newest milestone) and open it in Studio.',
  input: s.object({ template: s.string({ minLength: 1, maxLength: 120, description: 'The template’s asset id' }), name: s.optional(s.string({ maxLength: 200, description: 'The new design’s title (default: the template’s)' })) }),
  output: href,
  requiresConfirmation: false,
  destructive: false,
});

// ---------------------------------------------------------------- B11c: every file operation (HOME-FILES §3)

const asset = (description = 'The asset id, e.g. "as_…"') => s.string({ minLength: 1, maxLength: 120, description });
const assets = s.array(asset(), { minItems: 1, maxItems: 500, description: 'Asset ids (from `window.__home.model.files()`)' });
const done = s.object({ count: s.number({ description: 'How many files the operation changed' }) });
/** A project name (one folder level in M1: no `/`). */
const projectName = (description: string) => s.string({ minLength: 1, maxLength: 60, pattern: '^[^/]*\\S[^/]*$', description });

export const RenameDesignCapability = /* @__PURE__ */ defineCapability({
  id: 'instaflow/rename-design',
  title: 'Rename',
  description: 'Rename a design, template or media file in the workspace (1–200 characters).',
  input: s.object({ asset: asset(), title: s.string({ minLength: 1, maxLength: 200, description: 'The new name' }) }),
  output: done,
  requiresConfirmation: false,
  destructive: false,
});

export const DuplicateDesignCapability = /* @__PURE__ */ defineCapability({
  id: 'instaflow/duplicate-design',
  title: 'Duplicate',
  description: 'Make a copy of a design (or template) next to it, in the same project, named "<title> copy". The copy is a new document from a snapshot of the original, with no history.',
  input: s.object({ asset: asset() }),
  output: s.object({ asset: s.string({ description: 'The copy’s asset id' }), title: s.string() }),
  requiresConfirmation: false,
  destructive: false,
});

export const MoveToProjectCapability = /* @__PURE__ */ defineCapability({
  id: 'instaflow/move-to-project',
  title: 'Move to project',
  description: 'Move files into a project, or out of every project with `project: ""` ("No project"). A project that does not exist yet is made.',
  input: s.object({ assets, project: s.string({ maxLength: 60, pattern: '^[^/]*$', description: 'The project name; "" for No project' }) }),
  output: done,
  requiresConfirmation: false,
  destructive: false,
});

export const FavoriteCapability = /* @__PURE__ */ defineCapability({
  id: 'instaflow/favorite',
  title: 'Add to favourites',
  description: 'Mark a file as a favourite (a star on its card, the Favourites filter in Files), or unmark it.',
  input: s.object({ asset: asset(), favorite: s.boolean({ description: 'true to add, false to remove' }) }),
  output: done,
  requiresConfirmation: false,
  destructive: false,
});

export const TrashDesignsCapability = /* @__PURE__ */ defineCapability({
  id: 'instaflow/trash-designs',
  title: 'Move to trash',
  description: 'Move files to the trash. They can be restored for 30 days, then they are deleted.',
  input: s.object({ assets }),
  output: done,
  requiresConfirmation: false,
  destructive: false,
});

export const RestoreDesignsCapability = /* @__PURE__ */ defineCapability({
  id: 'instaflow/restore-designs',
  title: 'Restore',
  description: 'Bring files back from the trash into their project.',
  input: s.object({ assets }),
  output: done,
  requiresConfirmation: false,
  destructive: false,
});

export const DeleteForeverCapability = /* @__PURE__ */ defineCapability({
  id: 'instaflow/delete-forever',
  title: 'Delete forever',
  description: 'Delete files in the trash for good. This cannot be undone; only files already in the trash can be deleted.',
  input: s.object({ assets }),
  output: done,
  requiresConfirmation: false,
  destructive: true,
});

export const NewProjectCapability = /* @__PURE__ */ defineCapability({
  id: 'instaflow/new-project',
  title: 'New project',
  description: 'Make an empty project (a group of designs; one level in M1).',
  input: s.object({ name: projectName('The project name (1–60 characters, no "/")') }),
  output: done,
  requiresConfirmation: false,
  destructive: false,
});

export const RenameProjectCapability = /* @__PURE__ */ defineCapability({
  id: 'instaflow/rename-project',
  title: 'Rename project',
  description: 'Rename a project; its designs move with it.',
  input: s.object({ name: projectName('The project to rename'), to: projectName('The new name') }),
  output: done,
  requiresConfirmation: false,
  destructive: false,
});

export const DeleteProjectCapability = /* @__PURE__ */ defineCapability({
  id: 'instaflow/delete-project',
  title: 'Delete project',
  description: 'Delete a project. Its designs move to "No project"; nothing goes to the trash.',
  input: s.object({ name: projectName('The project to delete') }),
  output: done,
  requiresConfirmation: false,
  destructive: false,
});

export const SearchFilesCapability = /* @__PURE__ */ defineCapability({
  id: 'instaflow/search-files',
  title: 'Search designs',
  description: 'Find files whose title or project contains the text (case-insensitive), newest edit first.',
  input: s.object({ query: s.string({ maxLength: 200, description: 'The text to find' }) }),
  output: s.object({ assets: s.array(s.string()) }),
  requiresConfirmation: false,
  destructive: false,
});

/** The file operations (B11c): output `{ count }` unless noted. */
export const HOME_FILE_CAPABILITIES = [
  RenameDesignCapability,
  DuplicateDesignCapability,
  MoveToProjectCapability,
  FavoriteCapability,
  TrashDesignsCapability,
  RestoreDesignsCapability,
  DeleteForeverCapability,
  NewProjectCapability,
  RenameProjectCapability,
  DeleteProjectCapability,
  SearchFilesCapability,
] as const;

export const HOME_CAPABILITIES = [NewDesignCapability, OpenDesignCapability, UseTemplateCapability, ...HOME_FILE_CAPABILITIES] as const;

export type NewDesignInput = CapabilityInput<typeof NewDesignCapability>;
export type OpenDesignInput = CapabilityInput<typeof OpenDesignCapability>;
export type UseTemplateInput = CapabilityInput<typeof UseTemplateCapability>;
export type HomeActionOutput = CapabilityOutput<typeof NewDesignCapability>;

/** A quick action on Home: a capability with a fixed input, and how its card reads. */
export interface HomeQuickAction {
  readonly id: string;
  readonly capability: typeof NewDesignCapability;
  readonly input: NewDesignInput;
  readonly title: string;
  readonly detail: string;
  readonly lens: LensId;
}

const startFormat = (format: DesignFormatId): HomeQuickAction => {
  const f = designFormat(format);
  return Object.freeze({ id: `new-${format}`, capability: NewDesignCapability, input: Object.freeze({ format }), title: f.title, detail: f.detail, lens: f.lens });
};

/** M1's quick actions: start each format (the agent-backed ones of the design arrive with their capabilities in M2). */
export const HOME_QUICK_ACTIONS: readonly HomeQuickAction[] = Object.freeze(DESIGN_FORMAT_IDS.map(startFormat));
