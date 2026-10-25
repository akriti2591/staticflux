import { validateBootPlan } from '@staticflux/loader';
import { describe, expect, it } from 'vitest';
import { bootClosure, HOME_BOOT_PLAN, INSTAFLOW_CHUNKS, STUDIO_BOOT_PLAN } from './boot-plan.js';

describe('surface boot plans (Δ26, D17)', () => {
  it('Home boots its own chunk and the kit, and reaches no engine, Wasm or Studio chunk', () => {
    expect(bootClosure(HOME_BOOT_PLAN)).toEqual(['surface:home', 'lib:kit']);
    expect(bootClosure(HOME_BOOT_PLAN).some((id) => /^(engine|wasm):|^surface:studio$/.test(id))).toBe(false);
    expect(validateBootPlan(HOME_BOOT_PLAN).ok).toBe(true);
  });

  it('Studio makes the engine eager, every eager chunk with a reason', () => {
    expect(validateBootPlan(STUDIO_BOOT_PLAN).ok).toBe(true);
    expect([...bootClosure(STUDIO_BOOT_PLAN)].sort()).toEqual(['engine:document', 'engine:editor-worker', 'lib:kit', 'surface:studio', 'wasm:authoring', 'wasm:render']);
    expect(STUDIO_BOOT_PLAN.eager.every((e) => e.reason.length > 0)).toBe(true);
  });

  it('every chunk a plan names is declared', () => {
    const declared = new Set(Object.values(INSTAFLOW_CHUNKS).map((c) => c.id as string));
    for (const plan of [HOME_BOOT_PLAN, STUDIO_BOOT_PLAN]) for (const id of bootClosure(plan)) expect(declared.has(id)).toBe(true);
  });
});
