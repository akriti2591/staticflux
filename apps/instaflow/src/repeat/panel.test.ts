/**
 * The Repeat panel under Clean Pop (happy-dom): it renders every generator's controls from the kit, passes the a11y
 * audit, and turns control events into `RepeatEdit`s.
 */
import { expectNoA11yIssues } from '@staticflux/testkit/a11y';
import { compileTheme } from '@staticflux/ui/theme';
import { mountTestRoot, settle } from '@staticflux/ui/testing';
import { html, render } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanPopTheme } from '../theme/clean-pop.js';
import { REPEAT_KIND_PARAMS, REPEAT_KINDS } from './components.js';
import type { RepeatEdit, RepeatModel } from './inspector.js';
import { defaultParams, REPEAT_LIMITS, type RepeatParams } from './params.js';
import { bindRepeatInspector, defineRepeatInspector, type IfRepeatInspectorElement, REPEAT_EDIT_EVENT } from './panel.js';

const modelOf = (params: RepeatParams, instances: number): RepeatModel => ({ node: 'r', params, instances, fields: REPEAT_KIND_PARAMS[params.kind], kinds: REPEAT_KINDS, limits: REPEAT_LIMITS });

let dispose: (() => Promise<void>) | undefined;

beforeAll(() => defineRepeatInspector());

async function unmount(): Promise<void> {
  const d = dispose;
  dispose = undefined;
  await d?.();
}

afterEach(async () => {
  await unmount();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

async function mount(m: RepeatModel | undefined): Promise<{ panel: IfRepeatInspectorElement; edits: RepeatEdit[]; root: ShadowRoot }> {
  const style = document.createElement('style');
  style.textContent = compileTheme(cleanPopTheme);
  document.head.append(style);
  const test = mountTestRoot({ units: [] });
  dispose = () => test.dispose();
  render(html`<if-repeat-inspector .model=${m}></if-repeat-inspector>`, test.container);
  await settle();
  const panel = test.container.querySelector('if-repeat-inspector') as IfRepeatInspectorElement;
  const edits: RepeatEdit[] = [];
  panel.addEventListener(REPEAT_EDIT_EVENT, (e) => edits.push((e as CustomEvent<RepeatEdit>).detail));
  await settle();
  return { panel, edits, root: panel.shadowRoot as ShadowRoot };
}

const byLabel = (root: ShadowRoot, selector: string, label: string): HTMLElement => {
  const found = [...root.querySelectorAll(selector)].find((el) => (el as unknown as { label: string }).label === label);
  if (found === undefined) throw new Error(`no ${selector} "${label}"`);
  return found as HTMLElement;
};

describe('<if-repeat-inspector>', () => {
  it('renders the radial controls from kit components, accessibly', async () => {
    const { root } = await mount(modelOf(defaultParams('radial'), 6));
    expect(root.querySelector('sf-inspector-group')).not.toBeNull();
    expect(root.querySelectorAll('sf-text-field')).toHaveLength(3); // count, radius, start angle
    expect(root.querySelectorAll('sf-slider')).toHaveLength(1); // sweep
    expect(root.querySelectorAll('sf-segmented')).toHaveLength(2); // type, rotate
    expect(root.textContent).toContain('6 instances');
    expectNoA11yIssues(root);
  });

  it('shows the grid and mirror parameters (the axis angle only for an angled axis)', async () => {
    const grid = await mount(modelOf(defaultParams('grid'), 9));
    expect(grid.root.querySelectorAll('sf-text-field')).toHaveLength(7);
    expectNoA11yIssues(grid.root);
    await unmount();
    const mirror = await mount(modelOf(defaultParams('mirror'), 2));
    expect(() => byLabel(mirror.root, 'sf-text-field', 'Axis angle')).toThrow();
    await unmount();
    const angled = await mount(modelOf({ kind: 'mirror', axis: 'angle', angle: 30, offset: 0 }, 2));
    expect(byLabel(angled.root, 'sf-text-field', 'Axis angle')).toBeDefined();
  });

  it('turns control events into repeat edits', async () => {
    const { root, edits } = await mount(modelOf(defaultParams('radial'), 6));
    byLabel(root, 'sf-segmented', 'Repeat type').dispatchEvent(new CustomEvent('sf-change', { detail: { value: 'grid' } }));
    byLabel(root, 'sf-text-field', 'Count').dispatchEvent(new CustomEvent('sf-change', { detail: { value: '8.4' } }));
    byLabel(root, 'sf-text-field', 'Radius').dispatchEvent(new CustomEvent('sf-change', { detail: { value: '90px' } }));
    byLabel(root, 'sf-text-field', 'Radius').dispatchEvent(new CustomEvent('sf-change', { detail: { value: 'wide' } })); // ignored
    byLabel(root, 'sf-slider', 'Sweep').dispatchEvent(new CustomEvent('sf-change', { detail: { value: 180 } }));
    byLabel(root, 'sf-segmented', 'Copies').dispatchEvent(new CustomEvent('sf-change', { detail: { value: 'off' } }));
    const buttons = [...root.querySelectorAll('sf-button')] as HTMLElement[];
    buttons.find((b) => b.textContent?.includes('Expand'))?.click();
    buttons.find((b) => b.textContent?.includes('Release'))?.click();
    expect(edits).toEqual([
      { op: 'set', patch: { kind: 'grid' } },
      { op: 'set', patch: { count: 8 } },
      { op: 'set', patch: { radius: 90 } },
      { op: 'set', patch: { sweep: 180 } },
      { op: 'set', patch: { rotate: false } },
      { op: 'expand' },
      { op: 'release' },
    ]);
  });

  it('edits percentages and choices, shows a hint without a repeat, and binds to a source', async () => {
    const grid = await mount(modelOf(defaultParams('grid'), 9));
    byLabel(grid.root, 'sf-text-field', 'Brick shift').dispatchEvent(new CustomEvent('sf-change', { detail: { value: '25%' } }));
    byLabel(grid.root, 'sf-segmented', 'Brick').dispatchEvent(new CustomEvent('sf-change', { detail: { value: 'rows' } }));
    expect(grid.edits).toEqual([
      { op: 'set', patch: { brickShift: 0.25 } },
      { op: 'set', patch: { brick: 'rows' } },
    ]);
    await unmount();
    const { panel, root } = await mount(undefined);
    expect(root.textContent).toContain('Select a repeat');
    let listener = (): void => undefined;
    const applied: RepeatEdit[] = [];
    const model = modelOf(defaultParams('mirror'), 2);
    let current: RepeatModel | undefined = model;
    const stop = bindRepeatInspector(panel, {
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
    panel.dispatchEvent(new CustomEvent(REPEAT_EDIT_EVENT, { detail: { op: 'release' } }));
    expect(applied).toHaveLength(1);
    stop();
    panel.dispatchEvent(new CustomEvent(REPEAT_EDIT_EVENT, { detail: { op: 'release' } }));
    expect(applied).toHaveLength(1);
  });
});
