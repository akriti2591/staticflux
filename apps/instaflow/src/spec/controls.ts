/**
 * The single control model of the HUD and the inspector (STUDIO-UX-SPEC §4.2.1, FOUNDATIONS §4.21, DENSITY-DISCLOSURE
 * §3.2): every editable property or action of a selection kind is declared **once** as a control — its kind, the
 * fact it reads, the capability it runs, label, icon, shortcut, inspector section and order, disclosure **tier**, and
 * an optional **HUD rank** (1–6). The HUD and the inspector are projections of the same list and hold no logic:
 *
 * - `hudControls(set)` — the controls with a rank, in rank order, at most six (`⋯` is not counted, never declared);
 * - `inspectorSections(set, mode)` — every control grouped by section in section order; `essential` controls open,
 *   `more` controls behind the section's `More ▾` row in Standard and Focus, all open in Pro.
 *
 * Types only plus pure projections: the per-kind contents (§4.2.4) and the wiring are B11b's. Facts and capabilities
 * are typed references (rule 1), never strings looked up at runtime.
 */
import type { Capability } from '@staticflux/capabilities';
import { err, ok, type Result, type SfError } from '@staticflux/core';
import type { IconDef } from '@staticflux/kit/icon';
import { ControlModelError } from './errors.js';

export const CONTROL_KINDS = ['swatch', 'number', 'menu', 'toggle', 'font', 'action', 'chip', 'align'] as const;
export type ControlKind = (typeof CONTROL_KINDS)[number];

/** Disclosure tier (DENSITY-DISCLOSURE §3.2): `essential` at rest in Standard, `more` behind `More ▾`. */
export type ControlTier = 'essential' | 'more';

/** HUD ranks 1–6 (§4.2.4: at most six items, then `⋯`). */
export type HudRank = 1 | 2 | 3 | 4 | 5 | 6;
export const HUD_MAX = 6;

/** The modes that change how the inspector folds (`focus` renders the rail; its sections follow Standard). */
export type DisclosureMode = 'focus' | 'standard' | 'pro';

/** A typed reference to a reactive fact the control reads (the selection facts of a kind). */
export interface FactRef<V = unknown> {
  readonly kind: 'fact';
  readonly id: `${string}/${string}`;
  /** Phantom: the value type. */
  readonly value?: V;
}

/** Declare a fact reference (data). */
export function defineFact<V>(id: `${string}/${string}`): FactRef<V> {
  return Object.freeze({ kind: 'fact', id });
}

/** An inspector section, in its fixed order (STUDIO-UX-SPEC §5.1). */
export interface InspectorSection {
  readonly id: `${string}/${string}`;
  readonly label: string;
  readonly order: number;
}

export interface ControlDecl {
  readonly id: `${string}/${string}`;
  readonly kind: ControlKind;
  readonly label: string;
  readonly icon?: IconDef;
  /** Shortcut combo shown as `kbd` in the tooltip and the More menu. */
  readonly shortcut?: string;
  /** The fact it shows (value controls); actions have none. */
  readonly fact?: FactRef;
  /** The capability it runs or commits through (one undo step, named once). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly capability: Capability<any, any>;
  readonly section: InspectorSection;
  /** Position within the section. */
  readonly order: number;
  readonly tier: ControlTier;
  readonly hudRank?: HudRank;
  /** Pro tooltip second line (the capability's one-line description). */
  readonly description?: string;
}

/** The controls of one selection kind (`shape`, `text`, `multi`, …). */
export interface ControlSet {
  readonly selection: string;
  readonly controls: readonly ControlDecl[];
}

/**
 * Validate and freeze a control set: unique ids, unique HUD ranks, at most six of them (IF-POL-001). The first three
 * HUD slots are fixed per kind (§4.2.2): they are simply the ranks 1–3 declared here.
 */
export function defineControls(selection: string, controls: readonly ControlDecl[]): Result<ControlSet, SfError> {
  const ids = new Set<string>();
  const ranks = new Set<number>();
  for (const control of controls) {
    if (ids.has(control.id)) return err(ControlModelError({ details: { selection, control: control.id, problem: 'duplicate id' } }));
    ids.add(control.id);
    if (control.hudRank === undefined) continue;
    if (ranks.has(control.hudRank)) return err(ControlModelError({ details: { selection, control: control.id, problem: `HUD rank ${control.hudRank} taken twice` } }));
    ranks.add(control.hudRank);
  }
  if (ranks.size > HUD_MAX) return err(ControlModelError({ details: { selection, problem: 'more than six HUD ranks' } }));
  return ok(Object.freeze({ selection, controls: Object.freeze([...controls]) }));
}

/** The HUD: ranked controls in rank order, at most six (`⋯` follows, not counted). */
export function hudControls(set: ControlSet): readonly ControlDecl[] {
  return set.controls
    .filter((c): c is ControlDecl & { hudRank: HudRank } => c.hudRank !== undefined)
    .sort((a, b) => a.hudRank - b.hudRank)
    .slice(0, HUD_MAX);
}

export interface InspectorGroup {
  readonly section: InspectorSection;
  /** Shown at rest. */
  readonly open: readonly ControlDecl[];
  /** Behind the section's `More ▾` row; empty in Pro (everything is open). */
  readonly more: readonly ControlDecl[];
}

/** The inspector: every control by section in section order; tiers fold per mode (DENSITY-DISCLOSURE §3.2). */
export function inspectorSections(set: ControlSet, mode: DisclosureMode): readonly InspectorGroup[] {
  const bySection = new Map<string, { section: InspectorSection; controls: ControlDecl[] }>();
  for (const control of set.controls) {
    const entry = bySection.get(control.section.id) ?? { section: control.section, controls: [] };
    entry.controls.push(control);
    bySection.set(control.section.id, entry);
  }
  return [...bySection.values()]
    .sort((a, b) => a.section.order - b.section.order)
    .map(({ section, controls }) => {
      const sorted = [...controls].sort((a, b) => a.order - b.order);
      if (mode === 'pro') return { section, open: sorted, more: [] };
      return { section, open: sorted.filter((c) => c.tier === 'essential'), more: sorted.filter((c) => c.tier === 'more') };
    });
}

/** The controls of a set that appear in the More `⋯` menu: every action without a HUD rank (§4.2.3). */
export function moreMenuControls(set: ControlSet): readonly ControlDecl[] {
  return set.controls.filter((c) => c.kind === 'action' && c.hudRank === undefined);
}
