/**
 * Form factors (R18.3): an open set of width classes derived from the viewport.
 * Built-ins follow the Material window size classes: compact < 600 ≤ medium < 840 ≤ expanded.
 *
 * Extend the set with declaration merging plus a runtime definition:
 *
 *   declare module '@staticflux/platform' {
 *     interface FormFactorRegistry { large: true }
 *   }
 *   const formFactors = [...BUILT_IN_FORM_FACTORS, defineFormFactor({ id: 'large', minWidth: 1200 })];
 *
 * Hysteresis (R18.6) prevents flapping at a boundary: crossing *up* needs
 * `minWidth + hysteresis`, crossing *down* needs `< minWidth - hysteresis`.
 *
 * Runtime-import free: used by the inline mode detector.
 */

/** Open set of form factor ids; extend via declaration merging. */
export interface FormFactorRegistry {
  compact: true;
  medium: true;
  expanded: true;
}

export type FormFactorId = keyof FormFactorRegistry & string;

export interface FormFactorDefinition<Id extends FormFactorId = FormFactorId> {
  readonly id: Id;
  /** Inclusive lower bound in CSS px of the viewport width. The smallest definition should use 0. */
  readonly minWidth: number;
  readonly description?: string;
}

export function defineFormFactor<const Id extends FormFactorId>(definition: FormFactorDefinition<Id>): FormFactorDefinition<Id> {
  return definition;
}

// Descriptions live in comments, not data: these ship in the inline detector (< 1 KB).
/** Phones, narrow windows. */
export const compactFormFactor = defineFormFactor({ id: 'compact', minWidth: 0 });
/** Tablets in portrait, foldables, split windows. */
export const mediumFormFactor = defineFormFactor({ id: 'medium', minWidth: 600 });
/** Tablets in landscape, desktops. */
export const expandedFormFactor = defineFormFactor({ id: 'expanded', minWidth: 840 });

export const BUILT_IN_FORM_FACTORS: readonly FormFactorDefinition[] = [compactFormFactor, mediumFormFactor, expandedFormFactor];

/** Default hysteresis band in CSS px. */
export const DEFAULT_HYSTERESIS_PX = 24;

/**
 * Pick the form factor for `width`. With `previous`, a boundary is only crossed
 * once the width is more than `hysteresis` px past it.
 */
export function computeFormFactor(
  width: number,
  definitions: readonly FormFactorDefinition[] = BUILT_IN_FORM_FACTORS,
  previous?: FormFactorId,
  hysteresis: number = DEFAULT_HYSTERESIS_PX,
): FormFactorId {
  const sorted = [...definitions].sort((a, b) => a.minWidth - b.minWidth);
  const first = sorted[0];
  if (first === undefined) return 'compact';
  let raw: FormFactorDefinition = first;
  for (const definition of sorted) if (width >= definition.minWidth) raw = definition;
  if (previous === undefined || previous === raw.id) return raw.id;
  const prevIndex = sorted.findIndex((d) => d.id === previous);
  if (prevIndex < 0) return raw.id;
  const rawIndex = sorted.indexOf(raw);
  if (rawIndex > prevIndex) {
    // Growing: every boundary we cross must be cleared by the band.
    let index = prevIndex;
    for (let i = prevIndex + 1; i <= rawIndex; i += 1) {
      const boundary = sorted[i] as FormFactorDefinition;
      if (width >= boundary.minWidth + hysteresis) index = i;
    }
    return (sorted[index] as FormFactorDefinition).id;
  }
  // Shrinking: stay while within the band below the previous class's lower bound.
  let index = prevIndex;
  for (let i = prevIndex; i > rawIndex; i -= 1) {
    const boundary = sorted[i] as FormFactorDefinition;
    if (width < boundary.minWidth - hysteresis) index = i - 1;
    else break;
  }
  return (sorted[index] as FormFactorDefinition).id;
}
