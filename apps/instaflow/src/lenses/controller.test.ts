import { createShortcutRegistry, defineShortcutScope } from '@staticflux/a11y';
import { box, createScope } from '@staticflux/core';
import { press } from '@staticflux/testkit/a11y';
import { describe, expect, it } from 'vitest';
import type { LensContributionId } from '../spec/contributions.js';
import { StudioIds } from '../spec/studio-contributions.js';
import { canvasLensFeature } from './canvas-lens.js';
import { bindLensShortcuts, type CameraReason, createLensController, LensShortcuts } from './controller.js';
import { type Camera, fitCamera } from './lens-feature.js';
import { createLensFeatureRegistry } from './lens-features.js';
import { pagesLensFeature } from './pages-lens.js';
import { structureFeed } from './structure.js';
import { compositionDoc, priya, unwrap } from './test-helpers.js';

const viewport = { width: 1200, height: 900 };

async function setup(lens: LensContributionId = StudioIds.lens.pages) {
  const { doc, root } = await compositionDoc([
    { id: 'p1', name: 'Cover', canvas: [2400, 0] },
    { id: 'p2', canvas: [0, 0] },
    { id: 'p3', canvas: [1200, 0] },
  ]);
  const current = box<LensContributionId | undefined>(lens);
  const shown: [Camera, CameraReason][] = [];
  const features = unwrap(createLensFeatureRegistry([pagesLensFeature, canvasLensFeature]));
  const controller = createLensController({ features, lens: () => current.get(), structure: structureFeed(root), viewport: () => viewport, camera: { show: (c, r) => shown.push([c, r]) } });
  return { doc, root, controller, current, shown };
}

describe('createLensController', () => {
  it('arranges with the current lens and navigates in its order (Pages: story order)', async () => {
    const { controller, shown } = await setup();
    expect(controller.arrangement()?.frames.map((f) => f.page)).toEqual(['p1', 'p2', 'p3']);
    expect(controller.current()).toBeUndefined();
    expect(unwrap(controller.step(1)).page).toBe('p1');
    expect(unwrap(controller.step(1)).page).toBe('p2');
    expect(controller.current()).toBe('p2');
    expect(unwrap(controller.last()).page).toBe('p3');
    expect(unwrap(controller.first()).page).toBe('p1');
    expect(shown.every(([, reason]) => reason === 'focus')).toBe(true);
    const frame = controller.arrangement()?.frames[0];
    expect(controller.camera()).toEqual(fitCamera(frame?.rect ?? { x: 0, y: 0, w: 1, h: 1 }, viewport));
    const overview = unwrap(controller.overview());
    expect(shown.at(-1)).toEqual([overview, 'overview']);
  });

  it('switching lens re-arranges and keeps the focused page in view (Canvas: reading order)', async () => {
    const { controller, current, shown } = await setup();
    unwrap(controller.goTo('p3'));
    current.set(StudioIds.lens.canvas);
    expect(controller.arrangement()?.frames.map((f) => f.page)).toEqual(['p2', 'p3', 'p1']);
    expect(controller.current()).toBe('p3');
    expect(shown.at(-1)?.[1]).toBe('focus');
    expect(shown.at(-1)?.[0]).toMatchObject({ x: 1200 + 540, y: 675 });
    expect(unwrap(controller.step(1)).page).toBe('p1');
    current.set(StudioIds.lens.pixel); // no own feature: Canvas arrangement (D19)
    expect(controller.arrangement()?.lens).toBe(StudioIds.lens.canvas);
    current.set(undefined);
    expect(controller.arrangement()?.lens).toBe(StudioIds.lens.canvas);
  });

  it('a lens switch with nothing focused shows the overview', async () => {
    const { current, shown } = await setup();
    current.set(StudioIds.lens.canvas);
    expect(shown.map(([, r]) => r)).toEqual(['overview']);
  });

  it('follows structure edits (remote or local) and forgets a deleted current page', async () => {
    const { controller, doc } = await setup();
    unwrap(controller.goTo('p2'));
    unwrap(doc.commit({ actor: { kind: 'human', id: priya.id }, label: 'Delete' }, { root: [{ op: 'delete', node: 'p2' }] }));
    expect(controller.arrangement()?.frames.map((f) => f.page)).toEqual(['p1', 'p3']);
    expect(controller.current()).toBeUndefined();
    const unknown = controller.goTo('p2');
    expect(!unknown.ok && unknown.error.code).toBe('IF-LIB-011');
  });

  it('reports IF-LIB-010 for a part without a composition and disposes cleanly', async () => {
    const { root, doc } = await compositionDoc([]);
    unwrap(doc.commit({ actor: { kind: 'human', id: priya.id }, label: 'x' }, { root: [{ op: 'delete', node: 'comp' }] }));
    const features = unwrap(createLensFeatureRegistry([canvasLensFeature]));
    const controller = createLensController({ features, lens: () => undefined, structure: structureFeed(root), viewport: () => viewport, camera: { show: () => undefined } });
    expect(controller.arrangement()).toBeUndefined();
    expect(controller.error()?.code).toBe('IF-LIB-010');
    expect(controller.step(1).ok).toBe(false);
    const overview = controller.overview();
    expect(!overview.ok && overview.error.code).toBe('IF-LIB-010');
    expect(controller.goTo('x').ok).toBe(false);
    controller.dispose();
  });

  it('an empty composition has no frames: navigation is IF-LIB-011', async () => {
    const { root } = await compositionDoc([]);
    const features = unwrap(createLensFeatureRegistry([canvasLensFeature]));
    const controller = createLensController({ features, lens: () => undefined, structure: structureFeed(root), viewport: () => viewport, camera: { show: () => undefined } });
    const step = controller.step(1);
    expect(!step.ok && step.error.code).toBe('IF-LIB-011');
    expect(controller.last().ok).toBe(false);
  });
});

describe('bindLensShortcuts', () => {
  it('PageDown/PageUp, Mod+Home/End and Alt+0 navigate, never while typing', async () => {
    const { controller, shown } = await setup();
    const registry = createShortcutRegistry({ isMac: false });
    const shortcutScope = defineShortcutScope('test/studio');
    const scope = createScope('test');
    unwrap(bindLensShortcuts(registry, controller, { scope, shortcutScope }));
    registry.activate(shortcutScope, scope);
    registry.attach(document, scope);
    press(document.body, 'PageDown');
    press(document.body, 'PageDown');
    expect(controller.current()).toBe('p2');
    press(document.body, 'PageUp');
    expect(controller.current()).toBe('p1');
    press(document.body, 'End', { ctrl: true });
    expect(controller.current()).toBe('p3');
    press(document.body, 'Home', { ctrl: true });
    expect(controller.current()).toBe('p1');
    const before = shown.length;
    press(document.body, '0', { alt: true });
    expect(shown.at(-1)?.[1]).toBe('overview');
    expect(shown.length).toBe(before + 1);
    const input = document.createElement('input');
    document.body.append(input);
    press(input, 'PageDown');
    expect(controller.current()).toBe('p1');
    expect(registry.list().filter((s) => s.scope === shortcutScope.id).map((s) => s.id).sort()).toEqual(Object.values(LensShortcuts).map((s) => s.id).sort());
    expect(bindLensShortcuts(registry, controller, { scope, shortcutScope }).ok).toBe(false); // already registered
    await scope.dispose();
    expect(shown.length).toBeGreaterThan(4);
    input.remove();
  });
});
