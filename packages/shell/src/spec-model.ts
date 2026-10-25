/**
 * Layout spec model (R13.25): a declarative **spec** selects contributions from a closed
 * vocabulary of registered **sections** (for an editor: lens, tools, panels, HUD actions,
 * capabilities). The spec runtime validates a spec against the vocabulary, gates it through the
 * `DecidePort` (bound to `@staticflux/gate` by the app), diffs it against what is mounted and
 * mounts only the difference (`spec-runtime.ts`).
 *
 * Everything here is data: sections, contributions and specs are frozen plain objects, so presets,
 * saved specs and agent proposals are interchangeable (D16). Apps define their own spec schema and
 * compile it to a `ShellSpec` (Instaflow: `EditorSpec` → `toShellSpec`).
 *
 * @example
 * const tools = defineSpecSection({ id: 'tool', label: 'Tools', cardinality: 'many', pinnable: true });
 * const select = defineSpecContribution({ section: 'tool', id: 'editor/select', label: 'Select' });
 * const vocabulary = unwrap(createSpecVocabulary({ sections: [tools], contributions: [select] }));
 */
import { err, ok, type Result } from '@staticflux/core';
import type { GateResource } from '@staticflux/ui';
import { DuplicateContributionError } from './errors.js';
import { UnknownSpecContributionError } from './spec-errors.js';

/** A contribution id: app-unique, namespaced (`<package>/<name>`). */
export type SpecContributionId = `${string}/${string}`;
/** A section id (`tool`, `panel`, …): one registry of the vocabulary. */
export type SpecSectionId = string;
/** The identity of a mounted slot: `<section>:<contribution id>`. */
export type SpecSlotKey = `${string}:${string}/${string}`;
/** Where a slot sits inside its section (`dock`, `inspector`, …). Sections without placements use `default`. */
export type SpecPlacement = string;

export const DEFAULT_PLACEMENT: SpecPlacement = 'default';

export interface SpecSectionDef {
  readonly kind: 'spec-section';
  readonly id: SpecSectionId;
  readonly label: string;
  /** `one`: a spec names exactly one slot of this section (an editor's lens). `many`: zero or more, in order. */
  readonly cardinality: 'one' | 'many';
  /** People may pin slots of this section; a pinned slot is never removed by a new spec. */
  readonly pinnable: boolean;
  /** Allowed placements, in display order. Default `['default']`. */
  readonly placements: readonly SpecPlacement[];
}

/* @__NO_SIDE_EFFECTS__ */
export function defineSpecSection(init: {
  readonly id: SpecSectionId;
  readonly label?: string;
  readonly cardinality?: 'one' | 'many';
  readonly pinnable?: boolean;
  readonly placements?: readonly SpecPlacement[];
}): SpecSectionDef {
  return Object.freeze({
    kind: 'spec-section',
    id: init.id,
    label: init.label ?? init.id,
    cardinality: init.cardinality ?? 'many',
    pinnable: init.pinnable ?? false,
    placements: Object.freeze([...(init.placements ?? [DEFAULT_PLACEMENT])]),
  });
}

/**
 * One registered contribution. `when` lists the context values it applies under (every listed key
 * must hold one of its values; unlisted keys are unconstrained): a pixel tool declares
 * `{ lens: ['instaflow/lens-pixel'] }`, a page panel `{ scope: ['asset', 'page'] }`. Applicability is
 * data, never a mode check in feature code (IF-17.4).
 */
export interface SpecContribution<Section extends SpecSectionId = SpecSectionId> {
  readonly kind: 'spec-contribution';
  readonly section: Section;
  readonly id: SpecContributionId;
  readonly label: string;
  /** Gate resource: the slot is rejected (and a mounted one unmounted on `revalidate`) unless allowed. UX, not security. */
  readonly gate?: GateResource;
  readonly when?: Readonly<Record<string, readonly string[]>>;
  /** Placements this contribution may take (subset of the section's). Default: every placement of the section. */
  readonly placements?: readonly SpecPlacement[];
}

/* @__NO_SIDE_EFFECTS__ */
export function defineSpecContribution<const Section extends SpecSectionId>(
  init: Omit<SpecContribution<Section>, 'kind' | 'label'> & { readonly label?: string },
): SpecContribution<Section> {
  return Object.freeze({ ...init, kind: 'spec-contribution', label: init.label ?? init.id });
}

/** A request for one slot in a spec. `placement` defaults to the section's first placement. */
export interface SpecSlotRequest {
  readonly section: SpecSectionId;
  readonly id: SpecContributionId;
  readonly placement?: SpecPlacement;
}

/** The framework form of a spec (apps compile their schema to it). */
export interface ShellSpec {
  readonly id: string;
  /** Context the slots are checked against (`when`) and that the mount port receives (`lens`, `scope`, `density`). */
  readonly context: Readonly<Record<string, string>>;
  /** Slots in display order (order matters within one section and placement). */
  readonly slots: readonly SpecSlotRequest[];
  /** Slots to pin when this spec mounts (they must be slots of the spec). Pins are only ever added by specs. */
  readonly pinned?: readonly SpecSlotKey[];
}

/** A slot after validation: its contribution and its position inside its section and placement. */
export interface ResolvedSlot {
  readonly key: SpecSlotKey;
  readonly section: SpecSectionId;
  readonly id: SpecContributionId;
  readonly placement: SpecPlacement;
  /** Index within (section, placement). */
  readonly index: number;
  readonly contribution: SpecContribution;
}

export function slotKey(section: SpecSectionId, id: SpecContributionId): SpecSlotKey {
  return `${section}:${id}` as SpecSlotKey;
}

/** The (section, placement) group a slot belongs to: moves and order are computed per group. */
export function groupKey(slot: Pick<ResolvedSlot, 'section' | 'placement'>): string {
  return `${slot.section}@${slot.placement}`;
}

export interface SpecVocabulary {
  readonly sections: readonly SpecSectionDef[];
  section(id: SpecSectionId): SpecSectionDef | undefined;
  contribution(section: SpecSectionId, id: SpecContributionId): SpecContribution | undefined;
  /** Contributions of a section in registration order. */
  list(section: SpecSectionId): readonly SpecContribution[];
}

export interface SpecVocabularyInit {
  readonly sections: readonly SpecSectionDef[];
  readonly contributions: readonly SpecContribution[];
}

/**
 * Build the closed vocabulary. Duplicate section or contribution ids are SF-SHELL-008; a contribution
 * of an unknown section or with a placement its section does not offer is SF-SHELL-010.
 */
export function createSpecVocabulary(init: SpecVocabularyInit): Result<SpecVocabulary> {
  const sections = new Map<SpecSectionId, SpecSectionDef>();
  for (const section of init.sections) {
    if (sections.has(section.id)) return err(DuplicateContributionError({ details: { section: section.id } }));
    sections.set(section.id, section);
  }
  const bySection = new Map<SpecSectionId, Map<SpecContributionId, SpecContribution>>();
  for (const section of sections.keys()) bySection.set(section, new Map());
  for (const item of init.contributions) {
    const registry = bySection.get(item.section);
    const section = sections.get(item.section);
    if (registry === undefined || section === undefined) {
      return err(UnknownSpecContributionError({ message: `Contribution ${item.id} names an unknown section "${item.section}".`, details: { section: item.section, id: item.id } }));
    }
    if (registry.has(item.id)) return err(DuplicateContributionError({ details: { section: item.section, id: item.id } }));
    const stray = (item.placements ?? []).find((p) => !section.placements.includes(p));
    if (stray !== undefined) {
      return err(UnknownSpecContributionError({ message: `Contribution ${item.id} declares placement "${stray}", which section "${item.section}" does not offer.`, details: { section: item.section, id: item.id, placement: stray } }));
    }
    registry.set(item.id, item);
  }
  const list = [...sections.values()];
  return ok({
    sections: list,
    section: (id) => sections.get(id),
    contribution: (section, id) => bySection.get(section)?.get(id),
    list: (section) => [...(bySection.get(section)?.values() ?? [])],
  });
}
