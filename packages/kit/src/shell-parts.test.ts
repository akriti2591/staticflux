import { expectNoA11yIssues, press } from '@staticflux/testkit/a11y';
import { html } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defineButton, type SfButtonElement } from './button.js';
import { defineDock, type SfDockElement, type SfPanelElement } from './dock.js';
import { defineIconButton } from './icon-button.js';
import { defineInspector, nameControl, type SfInspectorGroupElement, type SfInspectorRowElement } from './inspector.js';
import { clampSize, resizeMachine, sizeFromDrag, sizeFromKey } from './internal/resize.js';
import { defineTextField, type SfTextFieldElement } from './text-field.js';
import { defineToolbar, type SfToolbarElement, toolbarItems } from './toolbar.js';
import { defineTooltip } from './tooltip.js';
import { cleanup, events, fixture, settle, shadow } from './test-helpers.js';

beforeAll(() => {
  defineButton();
  defineIconButton();
  defineTooltip();
  defineToolbar();
  defineDock();
  defineInspector();
  defineTextField();
});
afterEach(cleanup);

describe('<sf-toolbar>', () => {
  it('is a labelled toolbar with one tab stop across direct and wrapped controls', async () => {
    const { element } = await fixture<SfToolbarElement>(html`<sf-toolbar label="Formatting">
      <sf-icon-button label="Bold"></sf-icon-button>
      <sf-tooltip text="Italic"><sf-button>I</sf-button></sf-tooltip>
      <span role="separator"></span>
      <sf-text-field label="Font size" label-hidden></sf-text-field>
      <span>not a control</span>
    </sf-toolbar>`);
    await settle();
    expect(element.getAttribute('role')).toBe('toolbar');
    expect(element.getAttribute('aria-label')).toBe('Formatting');
    const items = element.items;
    expect(items.map((i) => i.localName)).toEqual(['sf-icon-button', 'sf-button', 'sf-text-field']);
    expect(items.map((i) => i.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    expectNoA11yIssues(element);
  });

  it('moves focus with arrows and Home/End, but leaves arrows to text fields', async () => {
    const { element } = await fixture<SfToolbarElement>(html`<sf-toolbar label="T"><sf-button>A</sf-button><sf-button>B</sf-button><sf-text-field label="X" label-hidden></sf-text-field></sf-toolbar>`);
    await settle();
    const [a, b, field] = element.items as [SfButtonElement, SfButtonElement, SfTextFieldElement];
    a.focus();
    press(a, 'ArrowRight');
    expect(document.activeElement).toBe(b);
    // the button keeps the roving tab stop after its own updates
    b.variant = 'primary';
    await b.updateComplete;
    expect(b.getAttribute('tabindex')).toBe('0');
    press(b, 'End');
    expect(document.activeElement).toBe(field);
    const input = shadow<HTMLInputElement>(field, 'input');
    expect(press(input, 'ArrowLeft').defaultPrevented).toBe(false);
    press(field, 'Home');
    expect(document.activeElement).toBe(a);
  });

  it('supports vertical orientation', async () => {
    const { element } = await fixture<SfToolbarElement>(html`<sf-toolbar label="Tools" orientation="vertical"><sf-button>A</sf-button><sf-button>B</sf-button></sf-toolbar>`);
    await settle();
    expect(element.getAttribute('aria-orientation')).toBe('vertical');
    const [a, b] = element.items;
    a?.focus();
    press(a as HTMLElement, 'ArrowDown');
    expect(document.activeElement).toBe(b);
    const wrapper = document.createElement('div');
    wrapper.innerHTML = '<span role="separator"></span><div><button>x</button></div><p></p>';
    expect(toolbarItems([...wrapper.children]).map((e) => e.localName)).toEqual(['button']);
  });
});

describe('resize helpers', () => {
  it('computes sizes from drags and keys for every edge and direction', () => {
    expect(sizeFromDrag(300, { x: -40, y: 0 }, 'inline-start', 'ltr')).toBe(340);
    expect(sizeFromDrag(300, { x: -40, y: 0 }, 'inline-start', 'rtl')).toBe(260);
    expect(sizeFromDrag(300, { x: 40, y: 0 }, 'inline-end', 'ltr')).toBe(340);
    expect(sizeFromDrag(200, { x: 0, y: 30 }, 'block-end', 'ltr')).toBe(230);
    const bounds = { min: 100, max: 500 };
    expect(sizeFromKey(300, 'ArrowLeft', false, 'inline-start', 'ltr', bounds)).toBe(316);
    expect(sizeFromKey(300, 'ArrowLeft', true, 'inline-start', 'rtl', bounds)).toBe(236);
    expect(sizeFromKey(300, 'ArrowRight', false, 'inline-end', 'ltr', bounds)).toBe(316);
    expect(sizeFromKey(300, 'ArrowDown', false, 'block-end', 'ltr', bounds)).toBe(316);
    expect(sizeFromKey(300, 'ArrowUp', false, 'block-end', 'ltr', bounds)).toBe(284);
    expect(sizeFromKey(300, 'ArrowLeft', false, 'block-end', 'ltr', bounds)).toBeUndefined();
    expect(sizeFromKey(300, 'Home', false, 'inline-start', 'ltr', bounds)).toBe(100);
    expect(sizeFromKey(300, 'End', false, 'inline-start', 'ltr', bounds)).toBe(500);
    expect(sizeFromKey(300, 'x', false, 'inline-start', 'ltr', bounds)).toBeUndefined();
    expect(clampSize(50, 100, 500)).toBe(100);
    expect(clampSize(900.4, 100, 500)).toBe(500);
    expect(resizeMachine.transitions.idle?.start).toBe('resizing');
  });
});

describe('<sf-dock>', () => {
  it('resizes with a window-splitter handle (keyboard and pointer) and collapses to a rail', async () => {
    const { element } = await fixture<SfDockElement>(html`<sf-dock label="Inspector" size="320" min="240" max="480"><p>Content</p><sf-icon-button slot="rail" label="Layers"></sf-icon-button></sf-dock>`);
    await settle();
    const resizes = events<{ size: number }>(element, 'sf-resize');
    const collapses = events<{ collapsed: boolean }>(element, 'sf-collapse');
    const handle = shadow(element, '[role="separator"]');
    expect(handle.getAttribute('aria-valuenow')).toBe('320');
    expect(handle.getAttribute('aria-label')).toBe('Resize Inspector');
    expectNoA11yIssues(element);
    press(handle, 'ArrowLeft'); // dock on the end side: left grows
    await element.updateComplete;
    expect(element.size).toBe(336);
    expect(shadow(element, '.body').style.inlineSize).toBe('336px');
    press(handle, 'End');
    await element.updateComplete;
    expect(element.size).toBe(480);
    handle.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 500, clientY: 0, pointerId: 1 }));
    expect(handle.hasAttribute('data-resizing')).toBe(true);
    handle.dispatchEvent(new PointerEvent('pointermove', { clientX: 600, clientY: 0, pointerId: 1 }));
    await element.updateComplete;
    expect(element.size).toBe(380);
    handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
    expect(resizes.map((e) => e.detail.size)).toEqual([336, 480, 380]);
    press(handle, 'Enter');
    await settle();
    expect(element.collapsed).toBe(true);
    expect(shadow(element, '.rail')).toBeTruthy();
    expect(element.shadowRoot?.querySelector('[role="separator"]')).toBeNull();
    (shadow(element, '.rail sf-icon-button') as HTMLElement).click();
    await settle();
    expect(element.collapsed).toBe(false);
    expect(collapses.map((e) => e.detail.collapsed)).toEqual([true, false]);
    element.resize(10);
    expect(element.size).toBe(240);
  });

  it('cancels a pointer drag and mirrors the side', async () => {
    const { element } = await fixture<SfDockElement>(html`<sf-dock side="start" label="Pages" size="300"></sf-dock>`);
    await settle();
    const handle = shadow(element, '[role="separator"]');
    handle.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 300, clientY: 0, pointerId: 1 }));
    handle.dispatchEvent(new PointerEvent('pointermove', { clientX: 340, clientY: 0, pointerId: 1 }));
    expect(element.size).toBe(340);
    handle.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }));
    expect(element.size).toBe(300);
    press(handle, 'ArrowRight'); // start side: right grows
    expect(element.size).toBe(316);
    handle.dispatchEvent(new PointerEvent('pointerdown', { button: 2, clientX: 0, clientY: 0 }));
    expect(handle.hasAttribute('data-resizing')).toBe(false);
  });
});

describe('<sf-panel>', () => {
  it('is a disclosure with a labelled region and an optional block resize handle', async () => {
    const { element } = await fixture<SfPanelElement>(html`<sf-panel label="Layers" resizable size="200"><p>Rows</p><sf-icon-button slot="actions" label="Add layer"></sf-icon-button></sf-panel>`);
    await settle();
    const toggle = shadow(element, '.toggle');
    const body = shadow(element, '.body');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBe(body.id);
    expect(body.getAttribute('aria-labelledby')).toBe(toggle.id);
    expect(element.style.blockSize).toBe('200px');
    expectNoA11yIssues(element);
    const resizes = events<{ size: number }>(element, 'sf-resize');
    press(shadow(element, '[role="separator"]'), 'ArrowDown');
    await element.updateComplete;
    expect(resizes[0]?.detail.size).toBe(216);
    const toggles = events<{ open: boolean }>(element, 'sf-toggle');
    toggle.click();
    await element.updateComplete;
    expect(element.collapsed).toBe(true);
    expect(body.hidden).toBe(true);
    expect(element.style.blockSize).toBe('');
    expect(toggles[0]?.detail.open).toBe(false);
  });
});

describe('inspector', () => {
  it('groups rows in a collapsible region and names slotted controls', async () => {
    const { element } = await fixture<SfInspectorGroupElement>(html`<sf-inspector-group label="Layout">
      <sf-inspector-row label="Width" hint="Inherited from frame"><sf-text-field></sf-text-field></sf-inspector-row>
      <sf-inspector-row label="Lock"><input type="checkbox" /></sf-inspector-row>
      <sf-inspector-row label="Ignored"><button aria-label="Named">x</button></sf-inspector-row>
    </sf-inspector-group>`);
    await settle();
    const [width, lock, named] = [...element.querySelectorAll('sf-inspector-row')] as SfInspectorRowElement[];
    const field = width?.querySelector('sf-text-field') as SfTextFieldElement;
    expect(field.label).toBe('Width');
    expect(field.labelHidden).toBe(true);
    expect(lock?.querySelector('input')?.getAttribute('aria-label')).toBe('Lock');
    expect(named?.querySelector('button')?.getAttribute('aria-label')).toBe('Named');
    expect(shadow(width as Element, '.hint').textContent).toBe('Inherited from frame');
    expect(shadow(width as Element, '.label').getAttribute('aria-hidden')).toBe('true');
    expectNoA11yIssues(element);
    const toggles = events<{ open: boolean }>(element, 'sf-toggle');
    shadow(element, '.toggle').click();
    await element.updateComplete;
    expect(element.collapsed).toBe(true);
    expect(shadow(element, '.body').hidden).toBe(true);
    expect(toggles[0]?.detail.open).toBe(false);
  });

  it('never overwrites an existing name', () => {
    const field = Object.assign(document.createElement('div'), { label: 'Own', labelHidden: false });
    nameControl(field, 'Row');
    expect(field.label).toBe('Own');
    const plain = document.createElement('input');
    nameControl(plain, '');
    expect(plain.hasAttribute('aria-label')).toBe(false);
    // Plain text is never named (a name is prohibited on generic and paragraph roles); controls and custom elements are.
    const text = document.createElement('span');
    nameControl(text, 'Row');
    expect(text.hasAttribute('aria-label')).toBe(false);
    const para = document.createElement('div');
    para.setAttribute('role', 'paragraph');
    nameControl(para, 'Row');
    expect(para.hasAttribute('aria-label')).toBe(false);
    const slider = document.createElement('div');
    slider.setAttribute('role', 'slider');
    nameControl(slider, 'Row');
    expect(slider.getAttribute('aria-label')).toBe('Row');
    const custom = document.createElement('x-thing');
    nameControl(custom, 'Row');
    expect(custom.getAttribute('aria-label')).toBe('Row');
    nameControl(plain, 'Row');
    expect(plain.getAttribute('aria-label')).toBe('Row');
  });
});
