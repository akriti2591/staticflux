/**
 * The Studio frame before the session (#62) in happy-dom: the same `<if-studio>` laid out from the Studio spec at the
 * device's density, inert, with placeholders for the canvas, the panels and the save state, and nothing wired that
 * could act on the missing engine (no chrome port, no shortcut registry, no selection pill).
 */
import { press } from '@staticflux/testkit/a11y';
import { compileTheme } from '@staticflux/ui/theme';
import { settle } from '@staticflux/ui/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeviceSettings } from '../settings/device-settings.js';
import { StudioIds } from '../spec/studio-ids.js';
import { cleanPopTheme } from '../theme/clean-pop.js';
import { CANVAS_PLACEHOLDER_ATTR, mountStudioFrame, placeholderCanvas, type StudioFrame } from './studio-frame.js';

let container: HTMLElement;
let frame: StudioFrame | undefined;

beforeEach(() => {
  const style = document.createElement('style');
  style.textContent = compileTheme(cleanPopTheme);
  document.head.append(style);
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(async () => {
  await frame?.dispose();
  frame = undefined;
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

const settings = (density: 'focus' | 'standard' | 'pro' = 'standard') => {
  const s = createDeviceSettings({ storage: null, window: null });
  s.set({ density });
  return s;
};

async function mounted(density: 'focus' | 'standard' | 'pro' = 'standard'): Promise<{ frame: StudioFrame; root: ShadowRoot }> {
  const made = mountStudioFrame(container, { settings: settings(density), homeHref: '/files' });
  if (!made.ok) throw new Error(made.error.message);
  frame = made.value;
  const opened = await frame.opened;
  expect(opened.ok).toBe(true);
  await frame.element.updateComplete;
  await settle();
  return { frame, root: frame.element.shadowRoot as ShadowRoot };
}

describe('mountStudioFrame', () => {
  it('renders the frame at once: top bar, tool picker, dock with Layers first, inspector, zoom', async () => {
    const made = mountStudioFrame(container, { settings: settings() });
    if (!made.ok) throw new Error(made.error.message);
    frame = made.value;
    // Synchronously in the container, before any session exists.
    expect(container.querySelector('if-studio')).toBe(frame.element);
    expect(container.getAttribute('aria-busy')).toBe('true');
    await frame.opened;
    await frame.element.updateComplete;
    await settle();
    const root = frame.element.shadowRoot as ShadowRoot;
    expect(root.querySelector('header')).not.toBeNull();
    expect(root.querySelector('header a.home')?.getAttribute('href')).toBe('/');
    expect(root.querySelector('[role="toolbar"].tools')).not.toBeNull();
    expect(root.querySelector('[data-region="dock"]')).not.toBeNull();
    expect(root.querySelector('[data-region="inspector"]')).not.toBeNull();
    expect(root.querySelector('.zoom')).not.toBeNull();
    const tabs = [...root.querySelectorAll('[data-region="dock"] sf-tab')].map((t) => t.textContent?.trim());
    expect(tabs[0]).toBe('Layers');
  });

  it('shows placeholders where the engine and the document go', async () => {
    const { root } = await mounted();
    const surface = root.querySelector('.surface') as HTMLElement;
    expect(surface.querySelector(`[${CANVAS_PLACEHOLDER_ATTR}]`)).not.toBeNull();
    expect(surface.querySelector('canvas')).toBeNull();
    // No page card or label yet (the editor's mirrors draw it), panels are skeletons, the save state is a skeleton.
    expect(root.querySelector('.page-card')).toBeNull();
    expect(root.querySelector('if-layers-panel')).toBeNull();
    expect(root.querySelector('if-inspector')).toBeNull();
    expect(root.querySelector('[data-region="dock"] sf-skeleton')).not.toBeNull();
    expect(root.querySelector('[data-region="inspector"] sf-skeleton')).not.toBeNull();
    expect(root.querySelector('.saved sf-skeleton')).not.toBeNull();
    expect(root.querySelector('.saved')?.textContent).not.toContain('Saved');
  });

  it('gates every engine-only control: inert, no chrome port, no shortcuts, no selection pill, no Export', async () => {
    const { frame: f, root } = await mounted();
    expect(f.element.hasAttribute('inert')).toBe(true);
    expect(f.element.port).toBeUndefined();
    expect(f.element.shortcuts).toBeUndefined();
    expect(root.querySelector('if-hud')).toBeNull();
    expect([...root.querySelectorAll('sf-button')].some((b) => b.textContent?.includes('Export'))).toBe(false);
    // Keys that need the engine do nothing and throw nothing (no registry is attached).
    const tool = f.studio.activeTool;
    const surface = root.querySelector('.surface') as HTMLElement;
    for (const key of ['r', 't', 'Delete', 'Backspace', 'k', 'z', 'a']) {
      expect(() => press(surface, key)).not.toThrow();
      expect(() => press(surface, key, { ctrl: true })).not.toThrow();
    }
    await settle();
    expect(f.studio.activeTool).toBe(tool);
    expect(f.studio.lens?.id).toBe(StudioIds.lens.canvas);
  });

  it('lays out at the device density (the app opens at the same one: no layout shift)', async () => {
    const { frame: f, root } = await mounted('pro');
    expect(f.studio.density).toBe('pro');
    expect(root.querySelector('header')?.getAttribute('data-density')).toBe('pro');
    expect(document.documentElement.getAttribute('data-sf-density')).toBe('pro');
  });

  it('dispose removes the frame and its placeholder and clears aria-busy', async () => {
    const { frame: f } = await mounted();
    const element = f.element;
    await f.dispose();
    frame = undefined;
    expect(element.isConnected).toBe(false);
    expect(container.childElementCount).toBe(0);
    expect(container.hasAttribute('aria-busy')).toBe(false);
    expect(element.shadowRoot?.querySelector(`[${CANVAS_PLACEHOLDER_ATTR}]`) ?? null).toBeNull();
  });
});

describe('placeholderCanvas', () => {
  it('puts a page-shaped skeleton in the surface, forwards nothing, and removes it on stop', async () => {
    const surface = document.createElement('div');
    document.body.append(surface);
    const started = await placeholderCanvas().start(surface as never, new AbortController().signal);
    if (!started.ok) throw new Error(started.error.message);
    const card = surface.querySelector(`[${CANVAS_PLACEHOLDER_ATTR}]`);
    expect(card?.getAttribute('aria-hidden')).toBe('true');
    expect(card?.querySelector('sf-skeleton')).not.toBeNull();
    expect(started.value.forwarded).toBe(0);
    await started.value.stop();
    expect(surface.childElementCount).toBe(0);
  });
});
