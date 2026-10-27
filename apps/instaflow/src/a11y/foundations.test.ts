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
import { defineAlignPopover } from '@staticflux/kit/align-popover';
import { defineButton } from '@staticflux/kit/button';
import { defineColorPopover } from '@staticflux/kit/color-popover';
import { defineConfirmRow } from '@staticflux/kit/confirm-row';
import { defineCopyField } from '@staticflux/kit/copy-field';
import { defineDisclosure } from '@staticflux/kit/disclosure';
import { defineFeedback } from '@staticflux/kit/feedback';
import { defineFontPicker } from '@staticflux/kit/font-picker';
import { defineHint } from '@staticflux/kit/hint';
import { defineMenu, type SfMenuElement } from '@staticflux/kit/menu';
import { definePopover, type SfPopoverElement } from '@staticflux/kit/popover';
import { defineShortcutSheet } from '@staticflux/kit/shortcut-sheet';
import { defineCard } from '@staticflux/kit/card';
import { defineSizeField } from '@staticflux/kit/size-field';
import { defineSurfaces, type SfDialogElement } from '@staticflux/kit/surfaces';
import { defineTooltip } from '@staticflux/kit/tooltip';
import { CLEAN_POP_COLOR_PALETTE } from '../theme/palette.js';
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
  defineButton();
  defineMenu();
  definePopover();
  defineTooltip();
  defineColorPopover();
  defineFontPicker();
  defineAlignPopover();
  defineFeedback();
  defineConfirmRow();
  defineCopyField();
  defineDisclosure();
  defineHint();
  defineSurfaces();
  defineShortcutSheet();
  defineSizeField();
  defineCard();
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

  it('B11a2 overlays: menu with icons, groups and a submenu; popover; tooltip', async () => {
    const root = await mount(
      html`<div>
        <sf-menu label="More">
          <sf-button slot="trigger">More</sf-button>
          <sf-menu-group label="Edit"><sf-menu-item value="copy" .icon=${trash2Icon} shortcut="Mod+C">Copy</sf-menu-item><sf-menu-item type="checkbox" value="snap" checked>Snap</sf-menu-item></sf-menu-group>
          <sf-menu-item value="arrange">Arrange</sf-menu-item>
          <sf-menu slot="submenu" label="Arrange"><sf-menu-item value="front">Bring to front</sf-menu-item></sf-menu>
        </sf-menu>
        <sf-popover label="Fill colour" outside="pass"><sf-button slot="trigger">Fill</sf-button><sf-color-popover label="Fill" value="#FF5C39" .palette=${CLEAN_POP_COLOR_PALETTE} .documentColors=${[{ hex: '#FFF4E0', uses: 3 }]} .brand=${[{ name: 'cream', hex: '#FFF4E0' }]} .recent=${['#16151A']}></sf-color-popover></sf-popover>
        <sf-tooltip text="Export" reason="Choose at least one page"><sf-button aria-disabled="true">Export</sf-button></sf-tooltip>
      </div>`,
    );
    expectNoA11yIssues(root);
    const menu = root.querySelector('sf-menu') as SfMenuElement;
    menu.show();
    await settle(2);
    (menu.querySelector('sf-menu[slot="submenu"]') as SfMenuElement).show();
    await settle(2);
    expectNoA11yIssues(root);
    menu.hide();
    (root.querySelector('sf-popover') as SfPopoverElement).show();
    await settle(2);
    expectNoA11yIssues(root);
  });

  it('B11a2 pickers: font picker and alignment popover', async () => {
    const root = await mount(
      html`<div>
        <sf-font-picker value="Geist" .fonts=${[{ family: 'Geist', cached: true }, { family: 'Fraunces', token: 'display', cached: false }]} .recent=${['Fraunces']} .inDesign=${['Geist']}></sf-font-picker>
        <sf-align-popover .count=${3}></sf-align-popover>
      </div>`,
    );
    expectNoA11yIssues(root);
  });

  it('B11a2 feedback: banner, progress row, confirm row, copy field, disclosure, hint, toast and dialog frames', async () => {
    const root = await mount(
      html`<div>
        <sf-banner tone="warning" message="You're offline. Fonts need a connection; editing works."></sf-banner>
        <sf-banner tone="danger" message="Storage is full. Nothing is lost until the tab closes." action-label="Open Storage settings"></sf-banner>
        <sf-progress-row label="Rendering page 2 of 5" .value=${2} .max=${5}></sf-progress-row>
        <sf-confirm-row message="Delete 'Client v1'?" confirm-label="Delete"></sf-confirm-row>
        <sf-copy-field label="Link" value="https://instaflow.app/s/abc"></sf-copy-field>
        <sf-disclosure heading="Effects" summary="Shadow"><p>rows</p></sf-disclosure>
        <sf-disclosure variant="more" .count=${2}><p>skew</p></sf-disclosure>
        <div role="dialog" aria-label="Hint"><sf-hint text="Drag to draw a frame. Frames hold other things and clip them."></sf-hint></div>
        <div role="status"><sf-toast tone="success" .count=${3} .dismissible=${false}>Copied</sf-toast></div>
        <div role="dialog" aria-label="Share"><sf-dialog heading="Link settings" size="wizard" .step=${2} .steps=${3} dirty><p>Fields</p></sf-dialog></div>
        <div role="dialog" aria-label="Milestone"><sf-takeover heading="Milestone 'Client v1'" meta="today 14:02 · Read-only"><p>canvas</p></sf-takeover></div>
        <div role="alertdialog" aria-label="The editor can't start"><sf-blocking-error heading="The editor can't start" message="Reload to try again." fix-label="Back up workspace"></sf-blocking-error></div>
      </div>`,
    );
    expectNoA11yIssues(root);
    // The held-changes row and the copy failure are states people meet too.
    const dialog = root.querySelector('sf-dialog') as SfDialogElement;
    dialog.allowDismiss('escape');
    await settle(2);
    expect(dialog.discarding).toBe(true);
    expectNoA11yIssues(root);
  });

  it('B11b keyboard cheat sheet: cards, kbd pills, the search and the platform switch', async () => {
    const groups = [
      { heading: 'Edit', rows: [{ id: 'a', label: 'Undo', keys: ['Mod+Z'] }, { id: 'b', label: 'Paste in place', keys: ['Mod+Shift+V'] }] },
      { heading: 'View', rows: [{ id: 'c', label: 'Zoom in', keys: ['Mod+='] }] },
    ];
    const root = await mount(html`<sf-shortcut-sheet .groups=${groups}></sf-shortcut-sheet>`);
    expectNoA11yIssues(root);
  });

  it('B11c size field pair (rest, units, the inline error) and the card with actions, a selection check and states', async () => {
    const root = await mount(
      html`<sf-size-field label="Size" .width=${1080} .height=${1350} unit="mm"></sf-size-field>
        <sf-card href="/s/as_1" selected drop-target
          ><span>Flyer</span><input slot="leading" type="checkbox" aria-label="Select Flyer" checked /><sf-icon-button slot="actions" label="More for Flyer"><sf-icon .icon=${trash2Icon}></sf-icon></sf-icon-button
        ></sf-card>`,
    );
    expectNoA11yIssues(root);
    const field = root.querySelector('sf-size-field') as HTMLElement & { shadowRoot: ShadowRoot };
    const width = field.shadowRoot.querySelector('sf-number-field[data-side="width"]') as HTMLElement;
    width.dispatchEvent(new CustomEvent('sf-change', { detail: { value: 99_999, delta: 0, source: 'type' }, bubbles: true, composed: true }));
    await settle(2);
    expect(field.shadowRoot.querySelector('[role="alert"]')?.textContent).toContain('Too large');
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
    // B11a2: banner text on its three tints, tooltip text, toast and menu muted text on raised surfaces.
    for (const bg of [t.color.infoSubtle, t.color.warningSubtle, t.color.dangerSubtle]) {
      expect(ratio(v(t.color.text), v(bg)), `text on ${bg.name}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(ratio(v(t.color.neutral1), v(t.color.neutral12)), 'tooltip').toBeGreaterThanOrEqual(4.5);
    expect(ratio(v(t.color.textMuted), v(t.color.surface2)), 'muted on raised').toBeGreaterThanOrEqual(4.5);
    expect(ratio(v(t.color.accentText), v(t.color.surface2)), 'links in popovers').toBeGreaterThanOrEqual(4.5);
    // The swatch ring separates a white swatch from white surfaces.
    expect(ratio(v(t.color.borderStrong), v(t.color.surface2))).toBeGreaterThanOrEqual(3);
  });
});
