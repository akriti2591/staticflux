/**
 * The Fill / Stroke / Effects panel under Clean Pop (happy-dom): it renders every stack and control from the kit,
 * passes the a11y audit (names, roles, no duplicate ids), and turns control events into `AppearanceEdit`s.
 */
import { expectNoA11yIssues } from '@staticflux/testkit/a11y';
import { compileTheme } from '@staticflux/ui/theme';
import { mountTestRoot, settle } from '@staticflux/ui/testing';
import { html, render } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanPopTheme } from '../theme/clean-pop.js';
import type { AppearanceEdit, AppearanceModel } from './inspector.js';
import { APPEARANCE_EDIT_EVENT, bindPaintInspector, definePaintInspector, type IfPaintInspectorElement } from './panel.js';

const model: AppearanceModel = {
  node: 'a',
  fills: [{ paint: '#ff5c39' }, { paint: '@primary', opacity: 0.5, blend: 'multiply' }, { paint: { kind: 'linear', from: [0, 0], to: [1, 0], stops: [{ offset: 0, color: '#fff' }] }, visible: false }],
  strokes: [{ paint: '#16151a', width: 2, align: 'inside', dash: [4, 2] }],
  effects: [
    { kind: 'drop-shadow', x: 0, y: 4, blur: 12, color: '#16151a33' },
    { kind: 'outer-glow', blur: 8, color: '#ff5c39' },
    { kind: 'background-blur', radius: 20 },
    '@shadow-md',
  ],
  opacity: 1,
  blend: 'normal',
  radius: 8,
  corners: [null, null, null, null],
  cornersLinked: false,
  smoothing: 0.6,
  sources: { fills: { arc: 'inherit' }, strokes: { arc: 'local' }, effects: { arc: 'local' }, radius: { arc: 'local' } },
  tokens: { colors: ['@primary'], sizes: ['@radius-md'], effects: ['@shadow-md'] },
};

let dispose: (() => Promise<void>) | undefined;

beforeAll(() => definePaintInspector());

afterEach(async () => {
  await dispose?.();
  dispose = undefined;
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

async function mount(m: AppearanceModel | undefined): Promise<{ panel: IfPaintInspectorElement; edits: AppearanceEdit[] }> {
  const style = document.createElement('style');
  style.textContent = compileTheme(cleanPopTheme);
  document.head.append(style);
  const root = mountTestRoot({ units: [] });
  dispose = () => root.dispose();
  render(html`<if-paint-inspector .model=${m}></if-paint-inspector>`, root.container);
  await settle();
  const panel = root.container.querySelector('if-paint-inspector') as IfPaintInspectorElement;
  const edits: AppearanceEdit[] = [];
  panel.addEventListener(APPEARANCE_EDIT_EVENT, (e) => edits.push((e as CustomEvent<AppearanceEdit>).detail));
  await settle();
  return { panel, edits };
}

const shadow = (panel: IfPaintInspectorElement): ShadowRoot => panel.shadowRoot as ShadowRoot;

describe('<if-paint-inspector>', () => {
  it('renders layer, fill, stroke, effect and corner groups from kit components, accessibly', async () => {
    const { panel } = await mount(model);
    const root = shadow(panel);
    expect([...root.querySelectorAll('sf-inspector-group')].map((g) => g.getAttribute('label') ?? (g as unknown as { label: string }).label)).toEqual(['Layer', 'Fill', 'Stroke', 'Effects', 'Corners']);
    expect(root.querySelectorAll('sf-color-field').length).toBeGreaterThanOrEqual(3);
    expect(root.querySelector('sf-segmented')).not.toBeNull();
    expect(root.querySelectorAll('sf-slider')).toHaveLength(2);
    expect(root.textContent).toContain('Linear gradient');
    expect(root.textContent).toContain('@shadow-md');
    expectNoA11yIssues(root);
  });

  it('turns control events into appearance edits (stack actions, values, link toggle, smoothing)', async () => {
    const { panel, edits } = await mount(model);
    const root = shadow(panel);
    const button = (label: string): HTMLElement => {
      const found = [...root.querySelectorAll('sf-icon-button')].find((b) => (b as unknown as { label: string }).label === label);
      if (found === undefined) throw new Error(`no button "${label}"`);
      return found as HTMLElement;
    };
    button('Hide fill 3').click();
    button('Move fill 1 down').click();
    button('Remove stroke 1').click();
    button('Link corners').click();
    const fillColor = root.querySelector('sf-color-field') as HTMLElement;
    fillColor.dispatchEvent(new CustomEvent('sf-change', { detail: { value: '#000000' } }));
    const width = [...root.querySelectorAll('sf-text-field')].find((f) => (f as unknown as { label: string }).label === 'stroke 1 width') as HTMLElement;
    width.dispatchEvent(new CustomEvent('sf-change', { detail: { value: '@radius-md' } }));
    const smoothing = [...root.querySelectorAll('sf-slider')].find((f) => (f as unknown as { label: string }).label === 'Corner smoothing') as HTMLElement;
    smoothing.dispatchEvent(new CustomEvent('sf-change', { detail: { value: 40 } }));
    expect(edits).toEqual([
      { op: 'toggle', stack: 'fills', index: 0 },
      { op: 'move', stack: 'fills', from: 2, to: 1 },
      { op: 'remove', stack: 'strokes', index: 0 },
      { op: 'link-corners', linked: true },
      { op: 'update', stack: 'fills', index: 1, patch: { paint: '#000000' } }, // the top fill is a gradient: the first colour field is fill 2
      { op: 'update', stack: 'strokes', index: 0, patch: { width: '@radius-md' } },
      { op: 'set', path: 'style.smoothing', value: 0.4 },
    ]);
  });

  it('shows a hint without a selection and binds to a source', async () => {
    const { panel } = await mount(undefined);
    expect(shadow(panel).textContent).toContain('Select an element');
    let listener = (): void => undefined;
    const applied: AppearanceEdit[] = [];
    let current: AppearanceModel | undefined = model;
    const stop = bindPaintInspector(panel, {
      model: () => current,
      subscribe: (l) => {
        listener = l;
        return () => undefined;
      },
      apply: (e) => applied.push(e),
    });
    expect(panel.model).toBe(model);
    current = undefined;
    listener();
    expect(panel.model).toBeUndefined();
    panel.dispatchEvent(new CustomEvent(APPEARANCE_EDIT_EVENT, { detail: { op: 'set', path: 'spatial.opacity', value: 1 } }));
    expect(applied).toHaveLength(1);
    stop();
    panel.dispatchEvent(new CustomEvent(APPEARANCE_EDIT_EVENT, { detail: { op: 'set', path: 'spatial.opacity', value: 1 } }));
    expect(applied).toHaveLength(1);
  });
});
