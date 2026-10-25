// @vitest-environment node
/** The HUD / inspector control model (STUDIO-UX-SPEC §4.2.1, DENSITY-DISCLOSURE §3.2). */
import { defineCapability, s } from '@staticflux/capabilities';
import { describe, expect, it } from 'vitest';
import { type ControlDecl, defineControls, defineFact, hudControls, inspectorSections, moreMenuControls } from './controls.js';

const run = defineCapability({ id: 'test/run', title: 'Run', input: s.object({}), output: s.object({}) });
const transform = { id: 'inspector/transform', label: 'Transform', order: 1 } as const;
const fill = { id: 'inspector/fill', label: 'Fill', order: 2 } as const;

const control = (id: `${string}/${string}`, extra: Partial<ControlDecl> = {}): ControlDecl => ({
  id,
  kind: 'number',
  label: id,
  capability: run,
  section: transform,
  order: 1,
  tier: 'essential',
  ...extra,
});

describe('control model', () => {
  const shape = defineControls('shape', [
    control('shape/x', { order: 1 }),
    control('shape/skew', { order: 5, tier: 'more' }),
    control('shape/fill', { kind: 'swatch', section: fill, hudRank: 1, fact: defineFact<string>('shape/fill') }),
    control('shape/radius', { order: 3, hudRank: 3 }),
    control('shape/delete', { kind: 'action', hudRank: 5, section: fill, order: 9 }),
    control('shape/flip', { kind: 'action', section: fill, order: 8, tier: 'more' }),
  ]);

  it('projects the HUD in rank order, ≤ 6, and the More menu from unranked actions', () => {
    expect(shape.ok).toBe(true);
    if (!shape.ok) return;
    expect(hudControls(shape.value).map((c) => c.id)).toEqual(['shape/fill', 'shape/radius', 'shape/delete']);
    expect(moreMenuControls(shape.value).map((c) => c.id)).toEqual(['shape/flip']);
  });

  it('projects the inspector by section; `more` folds in Standard and Focus, all open in Pro', () => {
    if (!shape.ok) return;
    const standard = inspectorSections(shape.value, 'standard');
    expect(standard.map((g) => g.section.id)).toEqual(['inspector/transform', 'inspector/fill']);
    expect(standard[0]?.open.map((c) => c.id)).toEqual(['shape/x', 'shape/radius']);
    expect(standard[0]?.more.map((c) => c.id)).toEqual(['shape/skew']);
    expect(inspectorSections(shape.value, 'focus')[0]?.more).toHaveLength(1);
    const pro = inspectorSections(shape.value, 'pro');
    expect(pro[0]?.open.map((c) => c.id)).toEqual(['shape/x', 'shape/radius', 'shape/skew']);
    expect(pro.every((g) => g.more.length === 0)).toBe(true);
  });

  it('refuses duplicate ids, duplicate ranks and more than six ranks (IF-POL-001)', () => {
    const dup = defineControls('x', [control('a/a'), control('a/a')]);
    expect(dup.ok ? '' : dup.error.code).toBe('IF-POL-001');
    const rank = defineControls('x', [control('a/a', { hudRank: 2 }), control('a/b', { hudRank: 2 })]);
    expect(rank.ok ? '' : String(rank.error.details['problem'])).toContain('rank 2');
  });
});
