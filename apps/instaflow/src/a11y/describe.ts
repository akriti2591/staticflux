/**
 * The text behind the `instaflow/describe-canvas` capability and HUD action (B6): the selection, or what is in view in
 * reading order. DOM-free, so the editor worker runs it next to the projector (B9).
 */
import { ok, type Result } from '@staticflux/core';
import { a11yMessages } from './messages.js';
import { describeElement, type ElementDescription, type ProjectionInput, projectCanvas } from './projection.js';

export const DESCRIBE_TARGETS = ['selection', 'visible'] as const;
export type DescribeTarget = (typeof DESCRIBE_TARGETS)[number];

/** Most elements listed by a `visible` description (the count is always complete). */
export const DESCRIBE_MAX_ITEMS = 50;

const sentence = (d: ElementDescription): string => [d.name, d.role.roleDescription, ...d.extra].join(', ');

/** Plain-text description of the selection or of what is in view (reading order). */
export function describeCanvas(input: ProjectionInput, what: DescribeTarget): Result<{ readonly text: string; readonly count: number }> {
  const targets: Readonly<Record<DescribeTarget, () => Result<{ readonly text: string; readonly count: number }>>> = {
    selection: () => {
      const items = input.view.selection.flatMap((n) => describeElement(input, n) ?? []);
      return ok({ text: items.length === 0 ? a11yMessages.nothingSelected : items.map(sentence).join('; '), count: items.length });
    },
    visible: () => {
      const snapshot = projectCanvas(input);
      if (!snapshot.ok) return snapshot;
      const items = snapshot.value.ids.flatMap((n) => describeElement(input, n) ?? []);
      const listed = items.slice(0, DESCRIBE_MAX_ITEMS).map((d) => `${d.name} (${d.role.roleDescription})`);
      return ok({ text: [a11yMessages.visibleCount(items.length), ...listed].join('; '), count: items.length });
    },
  };
  return targets[what]();
}
