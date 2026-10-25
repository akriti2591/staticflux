import { type DepHandle } from '@staticflux/core';
import { catalogLoader, createI18n, defineTranslations, type I18n } from '@staticflux/i18n';
import { html, LitElement } from 'lit';
import { afterEach, describe, expect, it } from 'vitest';
import { defineKit, kitMessages, kitText } from './index.js';
import { composedParentOf, directionOf } from './internal/direction.js';
import { emit } from './internal/events.js';
import { firstFocusableComposed } from './internal/focus.js';
import { uniqueId } from './internal/ids.js';
import { ConnectedListeners } from './internal/listeners.js';

afterEach(() => {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('dir');
});

describe('kitText', () => {
  it('falls back to the source text with parameters when no I18n is bound', () => {
    expect(kitText(undefined, kitMessages.close)).toBe('Close');
    expect(kitText(undefined, kitMessages.resizePanel, { label: 'Layers' })).toBe('Resize Layers');
    const unresolved = { value: undefined } as DepHandle<I18n>;
    expect(kitText(unresolved, kitMessages.expandPanel, { label: 'Dock' })).toBe('Expand Dock');
  });

  it('formats through the I18n service when it is ready', async () => {
    const fr = defineTranslations(kitMessages, 'fr', { close: 'Fermer', resizePanel: 'Redimensionner {label}' });
    const i18n = createI18n({ defaultLocale: 'en', available: ['en', 'fr'], requested: ['fr'], loaders: [catalogLoader(kitMessages, { fr: async () => fr })] });
    await i18n.load(kitMessages);
    await i18n.setLocale('fr');
    const handle = { value: i18n } as DepHandle<I18n>;
    expect(kitText(handle, kitMessages.close)).toBe('Fermer');
    expect(kitText(handle, kitMessages.resizePanel, { label: 'Calques' })).toBe('Redimensionner Calques');
  });
});

describe('dom helpers', () => {
  it('resolves direction through shadow roots and slots', () => {
    const host = document.createElement('div');
    host.setAttribute('dir', 'rtl');
    const inner = document.createElement('span');
    host.attachShadow({ mode: 'open' }).append(inner);
    document.body.append(host);
    expect(composedParentOf(inner)).toBe(host);
    expect(directionOf(inner)).toBe('rtl');
    const loose = document.createElement('p');
    document.body.append(loose);
    expect(directionOf(loose)).toBe('ltr');
    document.documentElement.setAttribute('dir', 'rtl');
    expect(directionOf(loose)).toBe('rtl');
  });

  it('emits composed events, makes unique ids', () => {
    const target = document.createElement('div');
    document.body.append(target);
    let detail: unknown;
    document.body.addEventListener('x-test', (e) => (detail = (e as CustomEvent).detail), { once: true, signal: new AbortController().signal });
    expect(emit(target, 'x-test', { a: 1 })).toBe(true);
    expect(detail).toEqual({ a: 1 });
    target.addEventListener('x-cancel', (e) => e.preventDefault(), { signal: new AbortController().signal });
    expect(emit(target, 'x-cancel', {}, { cancelable: true })).toBe(false);
    expect(uniqueId('a')).not.toBe(uniqueId('a'));
  });

  it('finds the first focusable element in the composed tree, preferring autofocus', () => {
    const container = document.createElement('div');
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<span aria-hidden="true"><button>hidden</button></span><slot></slot><button class="inner">inner</button>';
    host.innerHTML = '<a>no href</a><input type="hidden"><button class="slotted">slotted</button>';
    container.append(host);
    document.body.append(container);
    expect(firstFocusableComposed(container)?.className).toBe('slotted');
    const auto = document.createElement('input');
    auto.setAttribute('autofocus', '');
    container.append(auto);
    expect(firstFocusableComposed(container)).toBe(auto);
    const empty = document.createElement('div');
    empty.innerHTML = '<div tabindex="-1"></div><button disabled></button><a href="#" hidden>x</a>';
    expect(firstFocusableComposed(empty)).toBeUndefined();
  });

  it('binds listeners to the connection', async () => {
    let installs = 0;
    class Host extends LitElement {
      readonly listeners = new ConnectedListeners(this, (signal) => {
        installs += 1;
        this.addEventListener('ping', () => undefined, { signal });
      });
      override render(): unknown {
        return html``;
      }
    }
    customElements.define('x-connected-listeners', Host);
    const host = document.createElement('x-connected-listeners') as Host;
    document.body.append(host);
    expect(installs).toBe(1);
    const signal = host.listeners.signal;
    host.remove();
    expect(signal?.aborted).toBe(true);
    expect(host.listeners.signal).toBeUndefined();
    document.body.append(host);
    expect(installs).toBe(2);
  });
});

describe('defineKit', () => {
  it('registers every element once', () => {
    defineKit();
    defineKit();
    for (const tag of [
      'sf-button', 'sf-icon-button', 'sf-segmented', 'sf-text-field', 'sf-slider', 'sf-color-field', 'sf-popover', 'sf-tooltip',
      'sf-menu', 'sf-menu-item', 'sf-tabs', 'sf-tab', 'sf-tab-panel', 'sf-surface-layer', 'sf-dialog', 'sf-toast', 'sf-toolbar',
      'sf-dock', 'sf-panel', 'sf-inspector-group', 'sf-inspector-row', 'sf-tree', 'sf-capability-palette',
    ]) {
      expect(customElements.get(tag), tag).toBeDefined();
    }
  });
});
