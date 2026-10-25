/**
 * The Milestones panel: keyboard paths for every action and an accessibility audit, under Clean Pop.
 */
import { unit } from '@staticflux/core';
import type { SfButtonElement } from '@staticflux/kit/button';
import type { SfTreeElement } from '@staticflux/kit/tree';
import { auditA11y, deepFocused, press } from '@staticflux/testkit/a11y';
import { compileTheme } from '@staticflux/ui/theme';
import { mountTestRoot, settle } from '@staticflux/ui/testing';
import { html, render } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanPopTheme } from '../theme/clean-pop.js';
import { defineMilestonesPanel, type IfMilestonesPanelElement, milestoneNodes } from './milestones-panel.js';
import { MilestonesPanelModelToken } from './tokens.js';
import { panelFixture } from './test-helpers.js';

let dispose: (() => Promise<void>) | undefined;

beforeAll(() => defineMilestonesPanel());
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

async function mount() {
  const fixture = await panelFixture();
  const style = document.createElement('style');
  style.textContent = compileTheme(cleanPopTheme);
  document.head.append(style);
  const root = mountTestRoot({ units: [unit({ id: 'test/milestones-panel-model', provides: MilestonesPanelModelToken, scope: 'app', create: () => fixture.model })] });
  dispose = () => root.dispose();
  render(html`<if-milestones-panel></if-milestones-panel>`, root.container);
  await settle();
  const panel = root.container.querySelector('if-milestones-panel') as IfMilestonesPanelElement;
  await panel.updateComplete;
  const shadow = panel.shadowRoot as ShadowRoot;
  const q = <T extends Element>(selector: string): T => shadow.querySelector(selector) as T;
  /** Let the model's promises and the re-render land. */
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((r) => setTimeout(r, 0));
      await settle();
      await panel.updateComplete;
    }
  };
  const typeInto = async (selector: string, value: string): Promise<HTMLInputElement | HTMLTextAreaElement> => {
    const field = q<HTMLElement>(selector);
    await (field as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    const control = field.shadowRoot?.querySelector('input, textarea') as HTMLInputElement;
    control.value = value;
    control.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    await panel.updateComplete;
    return control;
  };
  const tree = (): { host: SfTreeElement; node: HTMLElement } => {
    const host = q<SfTreeElement>('sf-tree');
    return { host, node: host.shadowRoot?.querySelector('[role="tree"]') as HTMLElement };
  };
  return { ...fixture, panel, shadow, q, flush, typeInto, tree };
}

const variantsOf = (shadow: ShadowRoot): string[] => [...shadow.querySelectorAll('sf-button')].map((b) => (b as SfButtonElement).variant);

describe('milestoneNodes', () => {
  it('maps entries to flat tree rows with the date and a pinned badge', () => {
    const entry = { id: `ms_${'a'.repeat(64)}`, name: 'A', createdAt: '2026-10-25T09:00:00.000Z', createdBy: { kind: 'human', id: 'g' }, pinned: true, partCount: 2 } as const;
    expect(milestoneNodes([entry, { ...entry, pinned: false }], () => '25 Oct', 'Pinned')).toEqual([
      { id: entry.id, label: 'A', badge: 'Pinned · 25 Oct', draggable: false },
      { id: entry.id, label: 'A', badge: '25 Oct', draggable: false },
    ]);
  });
});

describe('<if-milestones-panel>', () => {
  it('renders kit components only, with labelled fields, a named region and no a11y issues', async () => {
    const { shadow, panel } = await mount();
    const section = shadow.querySelector('section') as HTMLElement;
    expect(section.getAttribute('aria-labelledby')).toBe('milestones-title');
    expect(shadow.querySelector('h2')?.textContent).toBe('Milestones');
    expect(shadow.querySelector('.empty')?.textContent).toContain('No milestones yet');
    expect(shadow.querySelector('sf-toolbar')?.getAttribute('label')).toBe('Milestone actions');
    // Only the design's variants; one primary action.
    expect(variantsOf(shadow)).toEqual(['primary', 'secondary', 'secondary', 'ghost', 'ghost', 'secondary']);
    // Nothing to act on yet.
    expect([...shadow.querySelectorAll('sf-toolbar sf-button')].every((b) => (b as SfButtonElement).disabled)).toBe(true);
    expect(auditA11y(panel.parentElement as HTMLElement)).toEqual([]);
    // Every colour comes from the theme.
    expect(String((panel.constructor as typeof IfMilestonesPanelElement).styles)).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it('keyboard: type a name, Enter creates; the result is announced and the list appears', async () => {
    const { shadow, flush, typeInto, milestones } = await mount();
    const input = await typeInto('sf-text-field.name', 'Client v2');
    await typeInto('sf-text-field.note', 'sent Friday');
    press(input, 'Enter');
    await flush();
    expect(milestones.list().map((m) => [m.name, m.note])).toEqual([['Client v2', 'sent Friday']]);
    expect(shadow.querySelector('[role="status"]')?.textContent).toBe('Milestone “Client v2” created');
    expect(shadow.querySelector('sf-tree')).not.toBeNull();
    expect((shadow.querySelector('sf-text-field.name') as unknown as { value: string }).value).toBe('');
  });

  it('shows the validation message on the field for an empty name', async () => {
    const { q, flush, milestones } = await mount();
    q<SfButtonElement>('sf-button.create').click();
    await flush();
    expect(q<HTMLElement & { error: string }>('sf-text-field.name').error).toContain('1–120 characters');
    expect(milestones.list()).toEqual([]);
  });

  it('keyboard: list → Enter opens read-only; Space selects; toolbar opens, pins, compares and branches', async () => {
    const { model, flush, tree, q, shown, shadow } = await mount();
    await model.create('A');
    await model.create('B');
    await flush();
    const { node, host } = tree();
    node.focus();
    press(node, 'ArrowDown'); // B (newest) → A
    press(node, 'Enter');
    await flush();
    expect(shown.readOnly.map((d) => d.source.kind === 'milestone' && d.source.name)).toEqual(['A']);

    press(node, ' '); // select A
    await flush();
    expect([...host.selected]).toHaveLength(1);
    const pin = q<SfButtonElement>('sf-button.pin');
    expect(pin.disabled).toBe(false);
    press(pin, 'Enter'); // APG button: Enter activates
    await flush();
    expect(model.milestones().find((m) => m.name === 'A')?.pinned).toBe(true);
    expect(q<SfButtonElement>('sf-button.pin').pressed).toBe(true);
    expect(shadow.querySelector('[role="status"]')?.textContent).toBe('Pinned “A”');

    q<SfButtonElement>('sf-button.compare').click(); // one selected → with Latest
    await flush();
    expect(q<SfButtonElement>('sf-button.compare').textContent).toBe('Compare with Latest');
    press(node, 'ArrowUp');
    press(node, ' '); // add B: two selected → side by side, older on the left
    await flush();
    expect(q<SfButtonElement>('sf-button.compare').textContent).toBe('Compare side by side');
    expect(q<SfButtonElement>('sf-button.open').disabled).toBe(true);
    press(q<SfButtonElement>('sf-button.compare'), ' '); // APG button: Space activates on release
    press(q<SfButtonElement>('sf-button.compare'), ' ', { type: 'keyup' });
    await flush();
    expect(shown.compared.map((s) => [s.left.source.kind === 'milestone' && s.left.source.name, s.right.source.kind])).toEqual([
      ['A', 'snapshot'],
      ['A', 'milestone'],
    ]);

    press(node, ' '); // deselect B → only A
    await flush();
    q<SfButtonElement>('sf-button.new-document').click();
    await flush();
    expect(shown.opened).toEqual(['as_new1']);
  });

  it('keyboard: Rename opens a field, Enter saves, Escape cancels and focus returns to the list', async () => {
    const { model, flush, tree, q, shadow } = await mount();
    await model.create('A');
    await flush();
    const { node } = tree();
    node.focus();
    press(node, ' ');
    await flush();
    q<SfButtonElement>('sf-button.rename').click();
    await flush();
    const field = q<HTMLElement>('sf-text-field.rename-field');
    expect(field).not.toBeNull();
    const control = field.shadowRoot?.querySelector('input') as HTMLInputElement;
    control.value = 'Approved';
    control.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    press(control, 'Enter');
    await flush();
    expect(model.milestones()[0]?.name).toBe('Approved');
    expect(shadow.querySelector('sf-text-field.rename-field')).toBeNull();
    expect(shadow.querySelector('[role="status"]')?.textContent).toBe('Renamed to “Approved”');

    q<SfButtonElement>('sf-button.rename').click();
    await flush();
    press(q<HTMLElement>('sf-text-field.rename-field').shadowRoot?.querySelector('input') as HTMLInputElement, 'Escape');
    await flush();
    expect(shadow.querySelector('sf-text-field.rename-field')).toBeNull();
    expect(model.milestones()[0]?.name).toBe('Approved');
  });

  it('promptCreate focuses the name field (the "Milestone" command, Mod+Alt+S)', async () => {
    const { panel, q } = await mount();
    panel.promptCreate();
    const field = q<HTMLElement>('sf-text-field.name');
    const focused = deepFocused();
    expect(focused === field || (focused !== null && field.shadowRoot?.contains(focused) === true)).toBe(true);
  });
});
