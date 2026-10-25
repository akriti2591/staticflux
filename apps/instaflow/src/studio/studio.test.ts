import { createShortcutRegistry } from '@staticflux/a11y';
import { createScope } from '@staticflux/core';
import { press } from '@staticflux/testkit/a11y';
import { afterEach, describe, expect, it } from 'vitest';
import { gateSpecDecide, pixelTouchUpSpec, StudioIds, studioSpec } from '../spec/index.js';
import { editorGate, studioRegistries } from '../spec/testing/fixtures.js';
import { scriptedProposer } from '../spec/testing/scripted-proposer.js';
import { createStudio, PERSON, StudioShortcutScope } from './studio.js';

const make = (options: Partial<Parameters<typeof createStudio>[0]> = {}) => {
  const { gate } = editorGate('pro');
  return createStudio({ registries: studioRegistries(), decideFor: (s) => gateSpecDecide(gate, s), reducedMotion: () => true, ...options });
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('createStudio', () => {
  it('opens the Studio spec: canvas lens, full toolbar, dock, inspector, HUD, Pro density', async () => {
    const studio = make();
    expect(studio.spec).toBeUndefined();
    expect(studio.density).toBe('focus');
    const opened = await studio.open();
    expect(opened.ok).toBe(true);
    expect(studio.spec?.id).toBe('instaflow/studio');
    expect(studio.lens?.label).toBe('Canvas');
    expect(studio.density).toBe('pro');
    expect(studio.activeTool).toBe(StudioIds.tool.select);
    expect(studio.port.groups()).toMatchObject({
      'lens@default': ['lens:instaflow/lens-canvas'],
      'panel@side': ['panel:instaflow/chat'],
      'panel@dock': ['panel:instaflow/layers', 'panel:instaflow/pages', 'panel:instaflow/assets', 'panel:instaflow/milestones', 'panel:instaflow/brand'],
      'panel@inspector': ['panel:instaflow/typography'],
      'hud@default': ['hud:instaflow/rewrite', 'hud:instaflow/animate', 'hud:instaflow/ask'],
    });
    expect(studio.proposals.history.map((p) => p.source.kind)).toEqual(['preset']);
    await studio.dispose();
  });

  it('a lens switch and a density change are spec changes by the person; pins survive them', async () => {
    const studio = make();
    await studio.open();
    expect(studio.togglePin('panel:instaflow/layers')).toEqual({ ok: true, value: true });
    const pixel = await studio.switchLens(StudioIds.lens.pixel);
    expect(pixel.ok && pixel.value.source).toEqual(PERSON);
    expect(studio.lens?.label).toBe('Pixel');
    expect(studio.port.groups()['panel@inspector']).toEqual(['panel:instaflow/adjust']);
    const focus = await studio.setDensity('focus');
    expect(focus.ok).toBe(true);
    expect(studio.density).toBe('focus');
    expect(studio.lens?.label).toBe('Pixel');
    expect(studio.runtime.pinned.has('panel:instaflow/layers')).toBe(true);
    expect(studio.togglePin('panel:instaflow/layers')).toEqual({ ok: true, value: false });
    expect(studio.togglePin('lens:instaflow/lens-pixel').ok).toBe(false);
    await studio.dispose();
  });

  it('spec changes run in order on the latest spec: a lens switch during a scope change keeps the new scope (B9)', async () => {
    const studio = make();
    await studio.open();
    const first = await studio.setScope({ kind: 'page', page: 'p1' });
    expect(first.ok ? 'ok' : first.error.message).toBe('ok');
    const scoped = studio.setScope({ kind: 'asset' });
    const switched = studio.switchLens(StudioIds.lens.pixel);
    const [s, l] = await Promise.all([scoped, switched]);
    expect([s.ok, l.ok]).toEqual([true, true]);
    expect(studio.spec?.scope).toEqual({ kind: 'asset' });
    expect(studio.lens?.label).toBe('Pixel');
    await studio.dispose();
  });

  it('a pinned slot the next lens does not name is retained, and the change is not rejected', async () => {
    const studio = make();
    await studio.open();
    expect(studio.togglePin('tool:instaflow/text').ok).toBe(true);
    const pixel = await studio.switchLens(StudioIds.lens.pixel);
    expect(pixel.ok).toBe(true);
    expect(studio.port.groups()['tool@default']).toContain('tool:instaflow/text');
    expect(studio.spec?.pinned).toEqual([]);
    await studio.dispose();
  });

  it('selectTool picks mounted tools only; the pick follows spec changes', async () => {
    const studio = make();
    await studio.open();
    expect(studio.selectTool(StudioIds.tool.text).ok).toBe(true);
    expect(studio.activeTool).toBe(StudioIds.tool.text);
    expect(studio.selectTool(StudioIds.tool.brush).ok).toBe(false);
    await studio.switchLens(StudioIds.lens.pixel);
    expect(studio.activeTool).toBe(StudioIds.tool.select);
    expect(studio.selectTool(StudioIds.tool.brush).ok).toBe(true);
    await studio.dispose();
  });

  it('opening a spec that does not validate is an error; a gated switch reports it', async () => {
    const free = editorGate('free');
    const studio = createStudio({ registries: studioRegistries({ gated: true }), decideFor: (s) => gateSpecDecide(free.gate, s), reducedMotion: () => true });
    const opened = await studio.open();
    expect(!opened.ok && opened.error.code).toBe('SF-SHELL-009');
    free.setPlan('pro');
    expect((await studio.open()).ok).toBe(true);
    free.setPlan('free');
    const switched = await studio.switchLens(StudioIds.lens.pixel);
    expect(!switched.ok && switched.error.code).toBe('SF-SHELL-009');
    expect(studio.lens?.label).toBe('Canvas');
  });

  it('agent proposals preview in Ask and the person opens them (scripted proposer)', async () => {
    const studio = make({ autonomy: 'ask' });
    await studio.open();
    const pulled = await studio.proposals.pull(scriptedProposer([{ spec: pixelTouchUpSpec(['img-1']) }]));
    expect(pulled.ok && pulled.value?.state).toBe('previewing');
    expect(studio.spec?.id).toBe('instaflow/studio');
    await studio.proposals.pending?.open();
    expect(studio.spec?.id).toBe('instaflow/pixel-touchup');
    await studio.dispose();
  });

  it('keyboard: 1–5 switch lenses, tool letters pick tools, Alt+Enter / Mod+K / Escape move focus', async () => {
    const studio = make();
    await studio.open();
    const registry = createShortcutRegistry({ isMac: false });
    const scope = createScope('test');
    const focus: string[] = [];
    expect(studio.bindShortcuts(registry, { focusHud: () => focus.push('hud'), focusCommandBar: () => focus.push('bar'), focusCanvas: () => focus.push('canvas') }, scope).ok).toBe(true);
    expect(registry.activeScopes).toContain(StudioShortcutScope.id);
    registry.attach(document, scope);
    press(document.body, '2');
    await until(() => studio.lens?.label === 'Pixel');
    press(document.body, 'b');
    expect(studio.activeTool).toBe(StudioIds.tool.brush);
    press(document.body, 'r'); // Shape is not in the Pixel toolbar: ignored.
    expect(studio.activeTool).toBe(StudioIds.tool.brush);
    press(document.body, 'Enter', { alt: true });
    press(document.body, 'k', { ctrl: true });
    press(document.body, 'Escape');
    expect(focus).toEqual(['hud', 'bar', 'canvas']);
    press(document.body, '1');
    await until(() => studio.lens?.label === 'Canvas');
    press(document.body, '5');
    await until(() => studio.lens?.label === 'Pages');
    expect(registry.list().filter((s) => s.scope === StudioShortcutScope.id).length).toBe(5 + 11 + 3);
    await scope.dispose();
    expect(studio.bindShortcuts(registry, { focusHud: () => undefined, focusCommandBar: () => undefined, focusCanvas: () => undefined }, createScope('again')).ok).toBe(true);
    const conflicting = studio.bindShortcuts(registry, { focusHud: () => undefined, focusCommandBar: () => undefined, focusCanvas: () => undefined }, createScope('twice'));
    expect(conflicting.ok).toBe(false);
    await studio.dispose();
  });

  it('opens a custom spec', async () => {
    const studio = make({ spec: pixelTouchUpSpec(['img-1']) });
    expect((await studio.open()).ok).toBe(true);
    expect(studio.spec?.id).toBe('instaflow/pixel-touchup');
    expect(studio.density).toBe('focus');
    expect(studioSpec.density).toBe('pro');
  });
});

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 0));
  expect(condition()).toBe(true);
}
