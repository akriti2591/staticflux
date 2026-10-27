// @vitest-environment happy-dom
import { unwrap } from '@staticflux/core';
import { auditA11y } from '@staticflux/testkit/a11y';
import { describe, expect, it } from 'vitest';
import { CANVAS_FOCUS_RING, type FocusRingOptions, mountCanvasA11y } from './dom.js';
import { a11yMessages } from './messages.js';
import type { CanvasSnapshot } from './projection.js';

const snapshot = (focus: string | undefined, ids: readonly string[] = ['f', 'a', 'b']): CanvasSnapshot => ({
  root: 'p1',
  label: 'Canvas: Poster',
  ids,
  focus,
  region: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
  nodes: [
    {
      id: 'f',
      role: 'group',
      roleDescription: 'frame',
      label: 'Hero',
      focusable: true,
      tabIndex: focus === 'f' ? 0 : -1,
      bounds: { x: 0, y: 0, width: 400, height: 300 },
      children: ids
        .filter((id) => id !== 'f')
        .map((id) => ({ id, role: 'img', roleDescription: 'rectangle', label: id.toUpperCase(), focusable: true, tabIndex: focus === id ? 0 : -1, bounds: { x: 10, y: 10, width: 50, height: 50 } })),
    },
  ],
});

function setup(): { host: HTMLElement; outside: HTMLButtonElement; focused: string[] } {
  document.body.innerHTML = '<button id="outside">Out</button><div id="surface" tabindex="0" role="application" aria-roledescription="canvas" aria-label="Canvas surface"></div>';
  return { host: document.getElementById('surface') as HTMLElement, outside: document.getElementById('outside') as HTMLButtonElement, focused: [] };
}

describe('DOM mount of the canvas projection', () => {
  it('moves DOM focus along the focus path only while the canvas has focus', () => {
    const { host, outside } = setup();
    const reported: string[] = [];
    const mount = unwrap(mountCanvasA11y({ host, document, onFocusNode: (id) => reported.push(id) }));
    expect(mount.apply(snapshot(undefined)).ok).toBe(true);
    expect(mount.layer.root.getAttribute('aria-label')).toBe('Canvas: Poster');
    expect(mount.layer.root.getAttribute('aria-description')).toBe(a11yMessages.instructions);
    // Focus elsewhere: a selection change never steals it.
    outside.focus();
    mount.apply(snapshot('a'));
    expect(document.activeElement).toBe(outside);
    // Canvas focused: focus follows the selection (Tab → next element), and back to the surface when cleared.
    host.focus();
    mount.apply(snapshot('a'));
    expect(mount.focused).toBe('a');
    mount.apply(snapshot('b'));
    expect(mount.focused).toBe('b');
    expect(mount.layer.element('b')?.getAttribute('tabindex')).toBe('0');
    expect(mount.layer.element('a')?.getAttribute('tabindex')).toBe('-1');
    mount.apply(snapshot(undefined));
    expect(document.activeElement).toBe(host);
    // Programmatic moves are not reported back (no select → focus → select loop) …
    expect(reported).toEqual([]);
    // … but a node focused by assistive technology or the pointer is.
    (mount.layer.element('a') as HTMLElement).focus();
    expect(reported).toEqual(['a']);
    // The focused element disappears (deleted): focus returns to the surface, not to <body>.
    mount.apply(snapshot('b'));
    mount.apply(snapshot(undefined, ['f']));
    expect(document.activeElement).toBe(host);
    mount.dispose();
    expect(host.querySelector('[data-sf-a11y-layer]')).toBeNull();
    expect(mount.apply(snapshot(undefined)).ok).toBe(false);
  });

  it('leaves Enter, Space and arrows to the tool shortcuts and shows the theme focus ring', () => {
    const { host } = setup();
    const mount = unwrap(mountCanvasA11y({ host, document }));
    host.focus();
    mount.apply(snapshot('a'));
    for (const key of ['Enter', ' ', 'ArrowRight', 'Tab', 'Escape']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      mount.layer.element('a')?.dispatchEvent(event);
      expect(event.defaultPrevented, key).toBe(false);
    }
    expect(CANVAS_FOCUS_RING.outline).toBe('2px solid var(--sf-color-focus-ring)');
    expect(mount.layer.root.querySelector('style')?.textContent).toContain(`outline:${CANVAS_FOCUS_RING.outline};outline-offset:2px`);
    mount.dispose();
  });

  it('passes the accessibility audit (names, roles, no nested interactive, roving tabindex)', () => {
    const { host } = setup();
    const mount = unwrap(mountCanvasA11y({ host, document }));
    mount.apply(snapshot('a'));
    expect(auditA11y(document.body).map((i) => i.message)).toEqual([]);
    expect([...host.querySelectorAll('[tabindex="0"]')].map((el) => el.getAttribute('data-sf-a11y-id'))).toEqual(['a']);
    mount.dispose();
  });

  it('shows the focus ring on the moves a key caused, never on those a pointer press caused (#41)', () => {
    const { host } = setup();
    const mount = unwrap(mountCanvasA11y({ host, document }));
    const calls: { el: string | null; options: FocusRingOptions | undefined }[] = [];
    const focus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusRingOptions) {
      calls.push({ el: this.getAttribute('data-sf-a11y-id') ?? this.id, options });
      focus.call(this, options);
    };
    try {
      host.focus();
      calls.length = 0;
      // A pointer press selects `a`, then clears the selection: focus follows without the keyboard ring.
      host.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
      mount.apply(snapshot('a'));
      mount.apply(snapshot(undefined));
      expect(calls).toEqual([
        { el: 'a', options: { focusVisible: false } },
        { el: 'surface', options: { focusVisible: false } },
      ]);
      // A key (Tab, arrows, Escape) moves it: the ring shows.
      calls.length = 0;
      host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, composed: true }));
      mount.apply(snapshot('b'));
      expect(calls).toEqual([{ el: 'b', options: { focusVisible: true } }]);
      // A press on a node inside the canvas counts too (capture on the surface).
      calls.length = 0;
      mount.layer.element('b')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
      mount.apply(snapshot('a'));
      expect(calls).toEqual([{ el: 'a', options: { focusVisible: false } }]);
    } finally {
      HTMLElement.prototype.focus = focus;
      mount.dispose();
    }
  });

  it('needs a document (SF-SURF-004 in a worker)', () => {
    const { host } = setup();
    const result = mountCanvasA11y({ host, document: undefined });
    expect(!result.ok && result.error.code).toBe('SF-SURF-004');
  });
});
