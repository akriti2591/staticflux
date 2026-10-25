/**
 * The `EditorSpec` schema (D16, EDITOR-AS-PRIMITIVE.md): an editor is a lens, a scope, and an ordered
 * selection of registered tools, panels (with where they dock), HUD actions and capabilities, plus a
 * density and the person's pins. Specs are data: presets ship as specs (`defineEditorSpec`), people save
 * their own, agents propose them as untrusted JSON (`parseEditorSpec`, IF-SPEC-001), Studio is the
 * largest one.
 *
 * The schema is declared once with the capability schema DSL, so the same declaration types the spec,
 * validates untrusted input and gives agents a JSON Schema (`toJsonSchema(EditorSpecSchema)`).
 */
import { s, toJsonSchema, validate } from '@staticflux/capabilities';
import type { CapabilityId } from '@staticflux/capabilities';
import { err, ok, type Result } from '@staticflux/core';
import type { SpecSlotKey } from '@staticflux/shell/spec';
import { type ActionId, DENSITIES, type Density, type LensContributionId, PANEL_PLACEMENTS, type PanelId, type PanelPlacementId, SCOPE_KINDS, type ScopeKind, type ToolId } from './contributions.js';
import { EditorSpecSchemaError } from './errors.js';

export type SpecId = `${string}/${string}`;
/** A pinnable slot: `tool:<id>`, `panel:<id>` or `hud:<id>`. */
export type SlotId = SpecSlotKey;

/** What a spec edits. Fields beyond `kind` are required per kind (`SCOPE_FIELDS`). */
export interface ScopeRef {
  readonly kind: ScopeKind;
  readonly page?: string;
  readonly nodes?: readonly string[];
  readonly start?: number;
  readonly end?: number;
  readonly layer?: string;
}

export interface PanelPlacement {
  readonly panel: PanelId;
  readonly dock: PanelPlacementId;
}

export interface EditorSpec {
  readonly id: SpecId;
  readonly label?: string;
  readonly lens: LensContributionId;
  readonly scope: ScopeRef;
  /** Toolbar order. */
  readonly tools: readonly ToolId[];
  readonly panels: readonly PanelPlacement[];
  /** HUD order. */
  readonly hud: readonly ActionId[];
  /** What may run here (still gated per call). */
  readonly capabilities: readonly CapabilityId[];
  readonly density?: Density;
  /** What the person pinned; a new spec never removes these. */
  readonly pinned?: readonly SlotId[];
}

/** Which ScopeRef fields each scope kind requires (a variant table, not a branch). */
export const SCOPE_FIELDS: Readonly<Record<ScopeKind, readonly (keyof Omit<ScopeRef, 'kind'>)[]>> = Object.freeze({
  asset: [],
  page: ['page'],
  selection: ['nodes'],
  'time-range': ['start', 'end'],
  layer: ['layer'],
});

const ID_PATTERN = '^[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9.-]*$';
const SLOT_PATTERN = '^(tool|panel|hud):[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9.-]*$';
const id = (description: string) => s.string({ pattern: ID_PATTERN, maxLength: 96, description });

export const ScopeRefSchema = s.object({
  kind: s.enum(SCOPE_KINDS, { description: 'What the editor edits' }),
  page: s.optional(s.string({ maxLength: 96 })),
  nodes: s.optional(s.array(s.string({ maxLength: 96 }), { minItems: 1, maxItems: 1024 })),
  start: s.optional(s.number({ min: 0 })),
  end: s.optional(s.number({ min: 0 })),
  layer: s.optional(s.string({ maxLength: 96 })),
});

export const EditorSpecSchema = s.object(
  {
    id: id('Spec id, e.g. instaflow/pixel-touchup'),
    label: s.optional(s.string({ maxLength: 80 })),
    lens: id('A registered lens contribution'),
    scope: ScopeRefSchema,
    tools: s.array(id('A registered tool'), { maxItems: 32 }),
    panels: s.array(s.object({ panel: id('A registered panel'), dock: s.enum(PANEL_PLACEMENTS) }), { maxItems: 16 }),
    // 48 (B8, was 12): actions of tone `more` share the HUD's one More menu, so a selection's actions fit.
    hud: s.array(id('A registered HUD action'), { maxItems: 48 }),
    capabilities: s.array(id('A declared capability'), { maxItems: 64 }),
    density: s.optional(s.enum(DENSITIES)),
    pinned: s.optional(s.array(s.string({ pattern: SLOT_PATTERN, maxLength: 112 }), { maxItems: 32 })),
  },
  { description: 'An Instaflow editor spec (closed vocabulary: name only registered contributions).' },
);

/** JSON Schema for agents (the `proposeSpecCapability` input). */
export const editorSpecJsonSchema = /* @__PURE__ */ toJsonSchema(EditorSpecSchema);

/** Type-checked, frozen preset spec. */
/* @__NO_SIDE_EFFECTS__ */
export function defineEditorSpec<const S extends EditorSpec>(spec: S): S {
  return Object.freeze(spec);
}

/** Parse an untrusted spec (agent JSON, a saved spec). Schema problems are IF-SPEC-001 with `details.issues`. */
export function parseEditorSpec(value: unknown): Result<EditorSpec> {
  const parsed = validate(EditorSpecSchema, value, 'editor spec');
  if (!parsed.ok) return err(EditorSpecSchemaError({ message: parsed.error.message, details: parsed.error.details, cause: parsed.error }));
  const spec = parsed.value as EditorSpec;
  const missing = SCOPE_FIELDS[spec.scope.kind].filter((field) => spec.scope[field] === undefined);
  const issues = missing.map((field) => ({ path: `/scope/${field}`, message: `required for scope "${spec.scope.kind}"` }));
  if (spec.scope.start !== undefined && spec.scope.end !== undefined && spec.scope.end < spec.scope.start) issues.push({ path: '/scope/end', message: 'must be ≥ start' });
  if (issues.length > 0) return err(EditorSpecSchemaError({ message: `Invalid editor spec: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`, details: { issues } }));
  return ok(Object.freeze(spec));
}
