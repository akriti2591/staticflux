import { afterEach, describe, expect, it } from 'vitest';
import { accessibleName, allElements, auditA11y, composedParent, deepFocused, expectNoA11yIssues, flatText, press, roleOf } from './a11y.js';

afterEach(() => {
  document.body.innerHTML = '';
});

function mount(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

let tagCounter = 0;
function shadowHost(inner: string, light = ''): HTMLElement {
  tagCounter += 1;
  const tag = `x-a11y-${tagCounter}`;
  customElements.define(
    tag,
    class extends HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: 'open' }).innerHTML = inner;
      }
    },
  );
  const el = document.createElement(tag);
  el.innerHTML = light;
  document.body.append(el);
  return el;
}

describe('roles and names', () => {
  it('derives implicit roles', () => {
    const root = mount('<button></button><a href="#">x</a><a>y</a><input type="range"><input type="checkbox"><input><textarea></textarea><select></select><dialog></dialog><input type="hidden">');
    expect([...root.children].map(roleOf)).toEqual(['button', 'link', undefined, 'slider', 'checkbox', 'textbox', 'textbox', 'combobox', 'dialog', undefined]);
    expect(roleOf(mount('<div role="tab menuitem"></div>').firstElementChild as Element)).toBe('tab');
  });

  it('computes names from labelledby, aria-label, labels, content and title', () => {
    const root = mount(`
      <span id="l1">First</span><span id="l2">Second</span>
      <button id="a" aria-labelledby="l1 l2">ignored</button>
      <button id="b" aria-label="  Close  ">×</button>
      <label for="c">Email</label><input id="c">
      <label>Wrapped <input id="d"></label>
      <button id="e">Save <span aria-hidden="true">✓</span></button>
      <div id="f" role="button" title="Tip"></div>
      <input id="g" type="submit" value="Go">
    `);
    const name = (id: string): string => accessibleName(root.querySelector(`#${id}`) as Element);
    expect(name('a')).toBe('First Second');
    expect(name('b')).toBe('Close');
    expect(name('c')).toBe('Email');
    expect(name('d')).toBe('Wrapped');
    expect(name('e')).toBe('Save');
    expect(name('f')).toBe('Tip');
    expect(name('g')).toBe('Go');
  });

  it('reads the flattened tree through shadow roots and slots', () => {
    const host = shadowHost('<span>Hello </span><slot></slot><slot name="x">fallback</slot>', 'World');
    expect(flatText(host)).toBe('Hello Worldfallback');
    host.setAttribute('role', 'button');
    expect(accessibleName(host)).toBe('Hello Worldfallback');
    const slotted = host.firstChild as Text;
    expect(slotted.textContent).toBe('World');
    const inner = host.shadowRoot?.querySelector('span') as Element;
    expect(composedParent(inner)).toBe(host);
    expect(allElements(host).length).toBe(4);
  });
});

describe('audit', () => {
  it('passes a well-formed widget', () => {
    const root = mount(`
      <div role="tablist" aria-label="Views"><div role="tab" aria-selected="true" aria-controls="p1" tabindex="0">One</div></div>
      <div role="tabpanel" id="p1" aria-label="One">…</div>
      <button>OK</button>
    `);
    expect(auditA11y(root)).toEqual([]);
    expect(() => expectNoA11yIssues(root)).not.toThrow();
  });

  it('reports missing names, broken refs, required attrs/parents, bad roles and tabindex', () => {
    const root = mount(`
      <button></button>
      <div role="tab" aria-controls="missing">Orphan</div>
      <div role="bogus"></div>
      <span tabindex="3">x</span>
      <div role="slider" aria-label="Volume"></div>
    `);
    const rules = auditA11y(root).map((i) => i.rule);
    expect(rules).toEqual(['name', 'aria-ref', 'required-attr', 'required-parent', 'valid-role', 'positive-tabindex', 'required-attr']);
    expect(() => expectNoA11yIssues(root)).toThrow(/Accessibility issues \(7\)/);
    expect(auditA11y(root, { rules: ['valid-role'] })).toHaveLength(1);
  });

  it('flags ids referenced across a shadow boundary', () => {
    mount('<span id="outside">Label</span>');
    const host = shadowHost('<button aria-labelledby="outside"></button>');
    const issues = auditA11y(host);
    expect(issues.map((i) => i.rule)).toEqual(['aria-ref', 'name']);
    expect(issues[0]?.message).toMatch(/never cross a shadow boundary/);
  });

  it('flags focusable content under aria-hidden and nested controls, but not inert content', () => {
    const root = mount(`
      <div aria-hidden="true"><button>Hidden</button></div>
      <div aria-hidden="true" inert><button>Inert</button></div>
      <div role="button" tabindex="0" aria-label="Outer"><button>Inner</button></div>
    `);
    expect(auditA11y(root).map((i) => i.rule)).toEqual(['hidden-focusable', 'nested-interactive']);
  });

  it('flags unsupported ARIA states, prohibited names and duplicate ids (R15.6)', () => {
    const root = mount(`
      <div role="group" aria-label="Card" aria-selected="true"></div>
      <div role="img" aria-label="Logo" aria-pressed="false"></div>
      <span aria-label="Fill 1">Linear gradient</span>
      <p role="paragraph" aria-label="Body">Text</p>
      <div id="twice" role="heading" aria-level="2">A</div>
      <div id="twice" role="tab" aria-selected="true" aria-label="Tab">B</div>
      <button aria-pressed="true">Bold</button>
      <input type="checkbox" aria-checked="true" aria-label="Native">
    `);
    const issues = auditA11y(root);
    expect(issues.map((i) => i.rule)).toEqual(['allowed-attr', 'allowed-attr', 'prohibited-name', 'prohibited-name', 'duplicate-id', 'required-parent']);
    expect(issues[0]?.message).toContain('aria-selected is not supported on role "group"');
    expect(issues[2]?.message).toContain('<span aria-label="Fill 1">');
    // The same id in two different trees (document and a shadow root) is fine.
    mount('<span id="shared">A</span>');
    expect(auditA11y(shadowHost('<span id="shared">B</span>'), { rules: ['duplicate-id'] })).toEqual([]);
  });

  it('checks required parents through slots', () => {
    const host = shadowHost('<div role="listbox" aria-label="Choices"><slot></slot></div>', '<div role="option" aria-selected="false">A</div>');
    expect(auditA11y(host)).toEqual([]);
  });
});

describe('keyboard helpers', () => {
  it('dispatches composed keyboard events and finds the deep focus', () => {
    const host = shadowHost('<input>');
    const input = host.shadowRoot?.querySelector('input') as HTMLInputElement;
    input.focus();
    expect(deepFocused()).toBe(input);
    const seen: string[] = [];
    document.addEventListener('keydown', (e) => seen.push(`${e.key}:${String(e.shiftKey)}`), { once: true });
    const event = press(input, 'Tab', { shift: true });
    expect(seen).toEqual(['Tab:true']);
    expect(event.cancelable).toBe(true);
    expect(press(input, 'a', { type: 'keyup', ctrl: true, alt: true, meta: true }).type).toBe('keyup');
  });
});
