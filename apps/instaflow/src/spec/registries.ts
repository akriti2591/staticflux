/**
 * The editor spec registries: lenses, tools, panels, HUD actions and capabilities, compiled into the
 * framework's closed `SpecVocabulary` (`@staticflux/shell/spec`). `toShellSpec` turns an `EditorSpec`
 * into the framework form: context `{ lens, scope, density }`, slots in order (lens, tools, panels with
 * their dock, HUD actions, capabilities), pins.
 *
 * Applicability is compiled to data: a contribution's `lenses` becomes `when.lens`, `scopes` becomes
 * `when.scope`, a lens's `scopes` gates which scopes it can open. Capabilities are gated at the
 * `capability` level with their own id (the same resource the capability pipeline checks).
 */
import type { AnyCapability, CapabilityId } from '@staticflux/capabilities';
import { err, ok, type Result } from '@staticflux/core';
import {
  createSpecVocabulary,
  defineSpecContribution,
  defineSpecSection,
  type ShellSpec,
  slotKey,
  type SpecContribution,
  type SpecSlotKey,
  type SpecVocabulary,
} from '@staticflux/shell/spec';
import { gateResource } from '@staticflux/ui';
import {
  type ActionId,
  type ContributionId,
  type HudActionContribution,
  type LensContribution,
  type LensContributionId,
  PANEL_PLACEMENTS,
  type PanelContribution,
  type PanelId,
  type ToolContribution,
  type ToolId,
} from './contributions.js';
import { ContributionRegistryError } from './errors.js';
import type { EditorSpec } from './schema.js';

/** Section ids of the editor vocabulary (the `<section>` of a slot key). */
export const EditorSection = Object.freeze({ lens: 'lens', tool: 'tool', panel: 'panel', hud: 'hud', capability: 'capability' } as const);
export type EditorSectionId = (typeof EditorSection)[keyof typeof EditorSection];

export const EDITOR_SECTIONS = Object.freeze([
  defineSpecSection({ id: EditorSection.lens, label: 'lens', cardinality: 'one' }),
  defineSpecSection({ id: EditorSection.tool, label: 'tool', pinnable: true }),
  defineSpecSection({ id: EditorSection.panel, label: 'panel', pinnable: true, placements: PANEL_PLACEMENTS }),
  defineSpecSection({ id: EditorSection.hud, label: 'HUD action', pinnable: true }),
  defineSpecSection({ id: EditorSection.capability, label: 'capability' }),
]);

/** The slot key of a contribution in a section (`tool:instaflow/select`). */
export function slotOf(section: EditorSectionId, id: ContributionId): SpecSlotKey {
  return slotKey(section, id);
}

export interface EditorRegistriesInit {
  readonly lenses: readonly LensContribution[];
  readonly tools: readonly ToolContribution[];
  readonly panels: readonly PanelContribution[];
  readonly hud: readonly HudActionContribution[];
  readonly capabilities: readonly AnyCapability[];
}

export interface EditorRegistries {
  readonly vocabulary: SpecVocabulary;
  readonly lenses: readonly LensContribution[];
  lens(id: LensContributionId): LensContribution | undefined;
  tool(id: ToolId): ToolContribution | undefined;
  panel(id: PanelId): PanelContribution | undefined;
  hud(id: ActionId): HudActionContribution | undefined;
  capability(id: CapabilityId): AnyCapability | undefined;
}

const when = (lenses: readonly string[] | undefined, scopes: readonly string[] | undefined): SpecContribution['when'] => {
  const out: Record<string, readonly string[]> = {};
  if (lenses !== undefined) out['lens'] = lenses;
  if (scopes !== undefined) out['scope'] = scopes;
  return Object.keys(out).length === 0 ? undefined : out;
};

const common = (c: { id: ContributionId; label: string; gate?: SpecContribution['gate']; lenses?: readonly string[]; scopes?: readonly string[] }) => {
  const condition = when(c.lenses, c.scopes);
  return { id: c.id, label: c.label, ...(c.gate === undefined ? {} : { gate: c.gate }), ...(condition === undefined ? {} : { when: condition }) };
};

/** Build the registries; duplicate ids and tools/panels naming unknown lenses are IF-SPEC-002. */
export function createEditorRegistries(init: EditorRegistriesInit): Result<EditorRegistries> {
  const lensIds = new Set(init.lenses.map((l) => l.id));
  const unknownLens = [...init.tools, ...init.panels, ...init.hud].flatMap((c) => (c.lenses ?? []).filter((l) => !lensIds.has(l)).map((l) => ({ id: c.id, lens: l })));
  if (unknownLens.length > 0) return err(ContributionRegistryError({ message: `Contribution ${unknownLens[0]?.id} names unknown lens ${unknownLens[0]?.lens}.`, details: { unknownLens } }));
  const contributions: SpecContribution[] = [
    ...init.lenses.map((l) => defineSpecContribution({ section: EditorSection.lens, ...common({ id: l.id, label: l.label, ...(l.gate === undefined ? {} : { gate: l.gate }), ...(l.scopes === undefined ? {} : { scopes: l.scopes }) }) })),
    ...init.tools.map((t) => defineSpecContribution({ section: EditorSection.tool, ...common(t) })),
    ...init.panels.map((p) => defineSpecContribution({ section: EditorSection.panel, ...common(p), placements: p.placements })),
    ...init.hud.map((h) => defineSpecContribution({ section: EditorSection.hud, ...common(h) })),
    ...init.capabilities.map((c) => defineSpecContribution({ section: EditorSection.capability, id: c.id, label: c.title, gate: gateResource('capability', c.id) })),
  ];
  const vocabulary = createSpecVocabulary({ sections: EDITOR_SECTIONS, contributions });
  if (!vocabulary.ok) return err(ContributionRegistryError({ message: vocabulary.error.message, details: vocabulary.error.details, cause: vocabulary.error }));
  const index = <T extends { id: string }>(list: readonly T[]): ReadonlyMap<string, T> => new Map(list.map((item) => [item.id, item] as const));
  const lenses = index(init.lenses);
  const tools = index(init.tools);
  const panels = index(init.panels);
  const hud = index(init.hud);
  const capabilities = index(init.capabilities);
  return ok({
    vocabulary: vocabulary.value,
    lenses: init.lenses,
    lens: (id) => lenses.get(id),
    tool: (id) => tools.get(id),
    panel: (id) => panels.get(id),
    hud: (id) => hud.get(id),
    capability: (id) => capabilities.get(id),
  });
}

/** Default density when a spec does not say (B11c: Standard, DENSITY-DISCLOSURE §7.1 "First run opens in Standard"). */
export const DEFAULT_DENSITY = 'standard';

/** The framework form of an editor spec. */
export function toShellSpec(spec: EditorSpec): ShellSpec {
  return {
    id: spec.id,
    context: { lens: spec.lens, scope: spec.scope.kind, density: spec.density ?? DEFAULT_DENSITY },
    slots: [
      { section: EditorSection.lens, id: spec.lens },
      ...spec.tools.map((id) => ({ section: EditorSection.tool, id })),
      ...spec.panels.map((p) => ({ section: EditorSection.panel, id: p.panel, placement: p.dock })),
      ...spec.hud.map((id) => ({ section: EditorSection.hud, id })),
      ...spec.capabilities.map((id) => ({ section: EditorSection.capability, id })),
    ],
    ...(spec.pinned === undefined ? {} : { pinned: spec.pinned }),
  };
}
