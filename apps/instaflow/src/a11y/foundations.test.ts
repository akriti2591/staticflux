// @vitest-environment happy-dom
/**
 * The B11a foundation blocks under Clean Pop (FOUNDATIONS §4.5, §4.6, §4.19, §5.9): every kit block Studio and Home
 * compose — icons, the scrubbable number field, inline rename, the colour swatch — passes the full audit in each state a
 * person meets (rest, mixed, invalid, editing, refused), the way Instaflow's panels do. `chrome.test.ts` guards that
 * every B11a block it pins is mounted here under Clean Pop.
 */
import { defineIconElement } from '@staticflux/kit/icon';
import { defineIconButton } from '@staticflux/kit/icon-button';
import { trash2Icon } from '@staticflux/kit/icons/trash-2';
import { defineInlineEdit, type SfInlineEditElement } from '@staticflux/kit/inline-edit';
import { defineNumberField, type SfNumberFieldElement } from '@staticflux/kit/number-field';
import { defineSwatch } from '@staticflux/kit/swatch';
import { expectNoA11yIssues, press } from '@staticflux/testkit/a11y';
import { compileTheme, contrastRatio, themeTokens as t, themeValue } from '@staticflux/ui/theme';
import { mountTestRoot, settle } from '@staticflux/ui/testing';
import { html, render } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanPopTheme } from '../theme/clean-pop.js';
import { layerKindIcon, toolIcon } from '../theme/icons.js';

let dispose: (() => Promise<void>) | undefined;
beforeAll(() => {
  defineIconElement();
  defineIconButton();
  defineNumberField();
  defineInlineEdit();
  defineSwatch();
});
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

async function mount(template: unknown): Promise<HTMLElement> {
  const style = document.createElement('style');
  style.textContent = compileTheme(cleanPopTheme);
  document.head.append(style);
  const root = mountTestRoot({ units: [] });
  dispose = () => root.dispose();
  render(template, root.container);
  await settle(3);
  return root.container;
}

const LIGHT = { scheme: 'light', contrast: 'normal', density: 'standard', motion: 'full' } as const;

describe('B11a foundation blocks under Clean Pop', () => {
  it('icons: decorative inside named controls, labelled when alone', async () => {
    const root = await mount(
      html`<sf-icon-button label="Delete" shortcut="Backspace"><sf-icon .icon=${trash2Icon} size="18"></sf-icon></sf-icon-button>
        <span>Layers <sf-icon .icon=${layerKindIcon('text')}></sf-icon></span>
        <sf-icon .icon=${toolIcon('hand')} label="Hand" size="24"></sf-icon>`,
    );
    expect(root.querySelectorAll('sf-icon[aria-hidden="true"]')).toHaveLength(2);
    expect(root.querySelector('sf-icon[role="img"]')?.getAttribute('aria-label')).toBe('Hand');
    expectNoA11yIssues(root);
  });

  it('number fields: rest, unit, mixed and invalid', async () => {
    const root = await mount(
      html`<div>
        <sf-number-field label="X" unit="px" .value=${120}></sf-number-field>
        <sf-number-field label="Angle" unit="°" wrap="angle" .value=${-45}></sf-number-field>
        <sf-number-field label="W" unit="px" mixed></sf-number-field>
        <sf-number-field label="Opacity" label-hidden unit="%" .value=${80}></sf-number-field>
      </div>`,
    );
    expectNoA11yIssues(root);
    const field = root.querySelector('sf-number-field') as SfNumberFieldElement;
    const input = field.shadowRoot?.querySelector('input') as HTMLInputElement;
    input.value = 'twelve';
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    press(input, 'Enter');
    await settle(2);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expectNoA11yIssues(root);
  });

  it('inline rename: viewing, editing, refused, and the click trigger', async () => {
    const root = await mount(
      html`<div>
        <sf-inline-edit label="Layer name" value="Headline"></sf-inline-edit>
        <sf-inline-edit label="design title" value="Night market" trigger="click"></sf-inline-edit>
      </div>`,
    );
    expectNoA11yIssues(root);
    const edit = root.querySelector('sf-inline-edit') as SfInlineEditElement;
    edit.edit();
    await settle(2);
    expectNoA11yIssues(root);
    const input = edit.shadowRoot?.querySelector('input') as HTMLInputElement;
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    press(input, 'Enter');
    await settle(2);
    expect(edit.error).not.toBe('');
    expectNoA11yIssues(root);
  });

  it('swatches: resolved and unresolved, hidden from assistive technology', async () => {
    const root = await mount(html`<span>Fill <sf-swatch color="#FF5C39"></sf-swatch><sf-swatch unresolved></sf-swatch> #FF5C39</span>`);
    expect(root.querySelectorAll('sf-swatch[aria-hidden="true"]')).toHaveLength(2);
    expectNoA11yIssues(root);
  });

  it('keeps the colours these blocks use readable in Clean Pop (SC 1.4.3, 1.4.11)', () => {
    const v = (token: (typeof t.color)[keyof typeof t.color]): string => themeValue(cleanPopTheme, token, LIGHT);
    const ratio = (a: string, b: string): number => {
      const r = contrastRatio(a, b);
      return r.ok ? r.value : 0;
    };
    // Unit suffix and labels (textMuted) and errors (dangerText) on the white field and the mist surface.
    for (const bg of [t.color.surfaceSunken, t.color.surface1]) {
      expect(ratio(v(t.color.textMuted), v(bg)), `muted on ${bg.name}`).toBeGreaterThanOrEqual(4.5);
      expect(ratio(v(t.color.dangerText), v(bg)), `danger on ${bg.name}`).toBeGreaterThanOrEqual(4.5);
      expect(ratio(v(t.color.controlEdge), v(bg)), `field edge on ${bg.name}`).toBeGreaterThanOrEqual(3);
    }
    // The swatch ring separates a white swatch from white surfaces.
    expect(ratio(v(t.color.borderStrong), v(t.color.surface2))).toBeGreaterThanOrEqual(3);
  });
});
