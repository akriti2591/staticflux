// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { brandKitOps, brandRuleGuard, brandTokenRule, brandViolations, checkBrandRules, checkToken, composeGuards, lintBrandRules, resolveTokens, ruleValue, stageRuleContext, tokenType } from './brand-kit.js';
import { BRAND_KIT_ROOT, P } from './components.js';
import { agent, createFixture, human, KIT, PAGE, shape, unwrap } from './testing/fixtures.js';

describe('brand kits', () => {
  it('builds a kit: root tokens and rules, class children with finals', () => {
    const ops = brandKitOps({ tokens: { a: '#fff' }, classes: { h: { props: { [P.radius]: 4 }, final: [P.radius] } }, rules: [] });
    expect(ops[0]).toMatchObject({ node: BRAND_KIT_ROOT, kind: 'composition', props: { 'brand.tokens.a': '#fff', [P.rules]: [] } });
    expect(ops[1]).toMatchObject({ node: 'h', kind: 'class', parent: BRAND_KIT_ROOT, props: { name: 'h', [P.final]: [P.radius] } });
  });

  it('reads tokens (aliases followed, cycles undefined), classes and rules; types tokens', async () => {
    const f = await createFixture();
    expect(f.kit.token('accent')).toBe('#ff5c39');
    expect(f.kit.token('loopA')).toBeUndefined();
    expect(f.kit.token('nope')).toBeUndefined();
    expect(f.kit.classes().map((c) => c.name)).toEqual(['Card', 'Outline']);
    expect(f.kit.rules().map((r) => r.id)).toEqual(['cta-primary']);
    expect(tokenType('#fff')).toBe('color');
    expect(tokenType(12)).toBe('size');
    expect(tokenType({ family: 'Geist' })).toBe('font');
    expect(tokenType(f.kit.token('shadow-md'))).toBe('effect');
    expect(tokenType({ kind: 'layer-blur', radius: 1 })).toBe('effect');
    expect(tokenType('hello')).toBe('other');
    expect(unwrap(checkToken(f.kit, '@primary', 'color'))).toBe('#ff5c39');
    const wrong = checkToken(f.kit, '@primary', 'size');
    expect(!wrong.ok && wrong.error.code).toBe('IF-EL-002');
  });

  it('resolves tokens nested in values and lists the missing ones', () => {
    const lookup = (n: string): string | undefined => ({ ink: '#16151a' })[n];
    const r = resolveTokens([{ paint: '@ink' }, { paint: { kind: 'linear', stops: [{ offset: 0, color: '@nope' }] } }], lookup);
    expect(r.value).toEqual([{ paint: '#16151a' }, { paint: { kind: 'linear', stops: [{ offset: 0, color: '@nope' }] } }]);
    expect(r.missing).toEqual(['nope']);
    expect(r.used).toEqual(['ink']);
    expect(brandTokenRule(KIT).match('#fff')).toBeUndefined();
    expect(brandTokenRule(KIT).match('@ink')).toEqual({ ref: KIT, node: BRAND_KIT_ROOT, path: 'brand.tokens.ink' });
  });

  it('the stage resolves top-level tokens with provenance; finals of a class win (IF-CS-013)', async () => {
    const f = await createFixture([shape('a', { [P.radius]: '@radius-md' }), shape('b', { [P.inherit]: { kit: KIT, class: 'card' } })]);
    expect(f.stage.value('a', P.radius)).toBe(12);
    expect(f.stage.explain('a', P.radius).winner?.token?.path).toBe('brand.tokens.radius-md');
    expect(ruleValue(f.stage, 'a', P.radius)).toBe('@radius-md');
    expect(f.stage.value('b', P.radius)).toBe(12);
    const final = f.stage.checkWrite([{ op: 'set', node: 'b', path: P.radius, value: 4 }], { actor: human });
    expect(!final.ok && final.error.code).toBe('SF-STAGE-003');
  });

  it('brand rules block writes (agents and humans), lint existing content, and guard the undo service', async () => {
    const f = await createFixture([shape('cta', { role: 'cta', [P.fills]: [{ paint: '@primary' }] }), shape('plain', { [P.fills]: [{ paint: '#000' }] })]);
    const ctx = stageRuleContext(f.stage, f.kit);
    expect(checkBrandRules([{ op: 'set', node: 'cta', path: P.fills, value: [{ paint: '@primary' }] }], ctx).ok).toBe(true);
    const bad = checkBrandRules([{ op: 'set', node: 'cta', path: P.fills, value: [{ paint: '#123456' }] }], ctx);
    expect(!bad.ok && bad.error.code).toBe('IF-EL-003');
    // Becoming a CTA with the wrong fill breaks the rule too; other nodes are not covered.
    expect(checkBrandRules([{ op: 'set', node: 'plain', path: 'role', value: 'cta' }], ctx).ok).toBe(false);
    expect(checkBrandRules([{ op: 'set', node: 'plain', path: P.fills, value: [{ paint: '#fff' }] }], ctx).ok).toBe(true);
    expect(checkBrandRules([{ op: 'create', node: 'new', kind: 'shape', parent: 'p1', props: { role: 'cta', [P.fills]: [{ paint: '#fff' }] } }], ctx).ok).toBe(false);
    expect(brandViolations([{ op: 'delete', node: 'cta' }], ctx)).toEqual([]);
    expect(lintBrandRules(f.stage, ['cta', 'plain'], f.kit)).toEqual([]);
    f.seed([{ op: 'set', node: 'plain', path: 'role', value: 'cta' }]);
    expect(lintBrandRules(f.stage, ['plain'], f.kit).map((v) => v.rule.id)).toEqual(['cta-primary']);
    for (const actor of [human, agent]) {
      const refused = f.undo.commit(actor, 'Recolour', { [PAGE]: [{ op: 'set', node: 'cta', path: P.fills, value: [{ paint: '#123456' }] }] });
      expect(!refused.ok && refused.error.code).toBe('IF-EL-003');
    }
    const warnOnly = checkBrandRules([{ op: 'set', node: 'cta', path: P.fills, value: [] }], { ...ctx, kit: { ...f.kit, rules: () => f.kit.rules().map((r) => ({ ...r, severity: 'warn' as const })) } });
    expect(warnOnly.ok).toBe(true);
    expect(brandRuleGuard(() => undefined)({}, human).ok).toBe(true);
    expect(composeGuards()({}, human).ok).toBe(true);
  });
});
