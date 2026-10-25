/**
 * The numeric transform bar under Clean Pop (happy-dom): kit controls only, the a11y audit, edits from typed values and
 * arrow keys, the linked W/H toggle, flips, and Apply / Cancel while a transform session is active.
 */
import { expectNoA11yIssues } from '@staticflux/testkit/a11y';
import { compileTheme } from '@staticflux/ui/theme';
import { mountTestRoot, settle } from '@staticflux/ui/testing';
import { html, render } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanPopTheme } from '../theme/clean-pop.js';
import type { TransformBarModel } from '../workers/mirrors.js';
import type { TransformEdit } from './free-transform.js';
import {
  bindTransformBar,
  defineTransformBar,
  formatNumber,
  type IfTransformBarElement,
  parseNumber,
  TRANSFORM_BAR_FIELDS,
  TRANSFORM_EDIT_EVENT,
  TRANSFORM_SESSION_EVENT,
  transformBarPanel,
  type TransformSessionAction,
} from './transform-bar.js';

const model = (extra: Partial<TransformBarModel> = {}): TransformBarModel => ({ nodes: ['a'], x: 10, y: 20, w: 100, h: 50, rotation: 30, skew: 0, flipX: false, flipY: false, locked: 0, transforming: false, ...extra });

let dispose: (() => Promise<void>) | undefined;

beforeAll(() => defineTransformBar());

afterEach(async () => {
  const d = dispose;
  dispose = undefined;
  await d?.();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

async function mount(m: TransformBarModel | undefined): Promise<{ bar: IfTransformBarElement; edits: TransformEdit[]; sessions: TransformSessionAction[]; root: ShadowRoot }> {
  const style = document.createElement('style');
  style.textContent = compileTheme(cleanPopTheme);
  document.head.append(style);
  const test = mountTestRoot({ units: [] });
  dispose = () => test.dispose();
  render(html`<if-transform-bar .model=${m}></if-transform-bar>`, test.container);
  await settle();
  const bar = test.container.querySelector('if-transform-bar') as IfTransformBarElement;
  const edits: TransformEdit[] = [];
  const sessions: TransformSessionAction[] = [];
  bar.addEventListener(TRANSFORM_EDIT_EVENT, (e) => edits.push((e as CustomEvent<TransformEdit>).detail));
  bar.addEventListener(TRANSFORM_SESSION_EVENT, (e) => sessions.push((e as CustomEvent<TransformSessionAction>).detail));
  await settle();
  return { bar, edits, sessions, root: bar.shadowRoot as ShadowRoot };
}

const field = (root: ShadowRoot, name: string): HTMLElement => {
  const found = [...root.querySelectorAll('sf-text-field')].find((el) => (el as unknown as { label: string }).label === name);
  if (found === undefined) throw new Error(`no field "${name}"`);
  return found as HTMLElement;
};
const button = (root: ShadowRoot, text: string): HTMLElement => {
  const found = [...root.querySelectorAll('sf-button, sf-icon-button')].find((el) => el.textContent?.trim() === text || el.getAttribute('label') === text);
  if (found === undefined) throw new Error(`no button "${text}"`);
  return found as HTMLElement;
};

describe('<if-transform-bar>', () => {
  it('renders X, Y, W, H, angle and skew from kit components, accessibly', async () => {
    const { root } = await mount(model());
    expect(root.querySelector('sf-inspector-group')).not.toBeNull();
    expect(root.querySelectorAll('sf-text-field')).toHaveLength(TRANSFORM_BAR_FIELDS.length);
    expect((field(root, 'Width') as unknown as { value: string }).value).toBe('100');
    expect((field(root, 'Angle') as unknown as { value: string }).value).toBe('30°');
    expect(root.textContent).toContain('1 element');
    expect(root.textContent).not.toContain('Apply');
    expectNoA11yIssues(root);
  });

  it('says what to do with nothing selected, and shows Apply / Cancel in a transform session', async () => {
    const empty = await mount(undefined);
    expect(empty.root.textContent).toContain('Select an element');
    expectNoA11yIssues(empty.root);
    await dispose?.();
    dispose = undefined;
    const { root, sessions } = await mount(model({ transforming: true, nodes: ['a', 'b'], locked: 1 }));
    expect(root.textContent).toContain('2 elements · 1 locked');
    button(root, 'Apply').click();
    button(root, 'Cancel').click();
    expect(sessions).toEqual(['commit', 'cancel']);
    expectNoA11yIssues(root);
  });

  it('turns typed values, arrow keys, the link toggle and flips into edits', async () => {
    const { bar, root, edits } = await mount(model());
    field(root, 'Width').dispatchEvent(new CustomEvent('sf-change', { detail: { value: '120px' } }));
    field(root, 'Skew').dispatchEvent(new CustomEvent('sf-change', { detail: { value: 'abc' } })); // not a number: ignored
    field(root, 'X position').dispatchEvent(new CustomEvent('sf-change', { detail: { value: '10' } })); // unchanged: ignored
    field(root, 'Y position').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    field(root, 'Angle').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }));
    field(root, 'Angle').dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    button(root, 'Link width and height').click();
    await settle();
    expect(bar.linked).toBe(true);
    field(root, 'Height').dispatchEvent(new CustomEvent('sf-change', { detail: { value: '25' } }));
    button(root, 'Flip horizontal').click();
    button(root, 'Flip vertical').click();
    expect(edits).toEqual([
      { field: 'w', value: 120 },
      { field: 'y', value: 21 },
      { field: 'rotation', value: 20 },
      { field: 'h', value: 25, linked: true },
      { flip: 'horizontal' },
      { flip: 'vertical' },
    ]);
  });

  it('binds to a source: model in, edits and session actions out, unbinds', async () => {
    const { bar } = await mount(undefined);
    let current: TransformBarModel | undefined = model();
    const listeners = new Set<() => void>();
    const applied: TransformEdit[] = [];
    const actions: TransformSessionAction[] = [];
    const subscribe = (l: () => void): (() => void) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    };
    const unbind = bindTransformBar(bar, { model: () => current, subscribe, apply: (e) => void applied.push(e), session: (a) => void actions.push(a) });
    expect(bar.model?.w).toBe(100);
    current = model({ w: 7 });
    for (const l of listeners) l();
    expect(bar.model?.w).toBe(7);
    bar.dispatchEvent(new CustomEvent(TRANSFORM_EDIT_EVENT, { detail: { flip: 'vertical' } }));
    bar.dispatchEvent(new CustomEvent(TRANSFORM_SESSION_EVENT, { detail: 'commit' }));
    unbind();
    bar.dispatchEvent(new CustomEvent(TRANSFORM_EDIT_EVENT, { detail: { flip: 'horizontal' } }));
    expect(applied).toEqual([{ flip: 'vertical' }]);
    expect(actions).toEqual(['commit']);
    expect(listeners.size).toBe(0);
  });

  it('parses and formats numbers; the panel contribution sits in the inspector on a selection', () => {
    expect(parseNumber(' 12.5px ')).toBe(12.5);
    expect(parseNumber('-30°')).toBe(-30);
    expect(parseNumber('')).toBeUndefined();
    expect(parseNumber('1e999')).toBeUndefined();
    expect(formatNumber(1 / 3, '°')).toBe('0.33°');
    expect(transformBarPanel).toMatchObject({ id: 'instaflow/transform', placements: ['inspector'], scopes: ['selection'] });
  });
});
