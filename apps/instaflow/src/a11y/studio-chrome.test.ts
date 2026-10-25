// @vitest-environment happy-dom
/**
 * The Studio frame under Clean Pop with the canvas accessibility layer mounted in its canvas surface: the whole
 * composed tree (frame, placeholder panels, canvas nodes) passes the full audit, and the canvas surface stays the one
 * keyboard entry to the canvas (the layer adds one tab stop at most: the focused element).
 */
import { createShortcutRegistry } from '@staticflux/a11y';
import { unwrap } from '@staticflux/core';
import { expectNoA11yIssues } from '@staticflux/testkit/a11y';
import { compileTheme } from '@staticflux/ui/theme';
import { mountTestRoot, settle } from '@staticflux/ui/testing';
import { html, render } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { gateSpecDecide } from '../spec/index.js';
import { editorGate, studioRegistries } from '../spec/testing/fixtures.js';
import { createStudio } from '../studio/studio.js';
import { defineStudio, type IfStudioElement } from '../studio/studio-element.js';
import { cleanPopTheme } from '../theme/clean-pop.js';
import { mountCanvasA11y } from './dom.js';
import type { CanvasSnapshot } from './projection.js';

let dispose: (() => Promise<void>) | undefined;
beforeAll(() => defineStudio());
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

const snapshot: CanvasSnapshot = {
  root: 'p1',
  label: 'Canvas: Night Market Flyer',
  ids: ['f', 'h', 'r', 'a'],
  focus: 'a',
  region: { minX: 0, minY: 0, maxX: 1000, maxY: 800 },
  nodes: [
    {
      id: 'f',
      role: 'group',
      roleDescription: 'frame',
      label: 'Hero',
      focusable: true,
      tabIndex: -1,
      bounds: { x: 0, y: 0, width: 600, height: 400 },
      children: [
        { id: 'h', role: 'heading', roleDescription: 'heading', level: 1, label: 'Night market', text: 'Night market\nFridays', focusable: true, tabIndex: -1, bounds: { x: 20, y: 20, width: 300, height: 60 } },
        {
          id: 'r',
          role: 'group',
          roleDescription: 'radial repeat',
          label: 'Petals',
          description: '8 instances',
          focusable: true,
          tabIndex: -1,
          children: [{ id: 'a', role: 'img', roleDescription: 'star', label: 'Petal', description: 'instance 3 of 8', focusable: true, tabIndex: 0 }],
        },
      ],
    },
  ],
};

describe('Studio frame with the canvas accessibility layer (Clean Pop)', () => {
  it('passes the full audit and keeps one tab stop for the canvas content', async () => {
    const style = document.createElement('style');
    style.textContent = compileTheme(cleanPopTheme);
    document.head.append(style);
    const { gate } = editorGate('pro');
    const studio = createStudio({ registries: studioRegistries(), decideFor: (s) => gateSpecDecide(gate, s), reducedMotion: () => true });
    await studio.open();
    const testRoot = mountTestRoot({ units: [] });
    render(html`<if-studio .studio=${studio} .shortcuts=${createShortcutRegistry({ isMac: false })} asset-title="Night Market Flyer" project-title="Spring campaign"></if-studio>`, testRoot.container);
    dispose = async () => {
      await studio.dispose();
      await testRoot.dispose();
    };
    await settle(6);
    const element = testRoot.container.querySelector('if-studio') as IfStudioElement;
    const surface = element.shadowRoot?.querySelector('.surface') as HTMLElement;
    expect(surface.getAttribute('role')).toBe('application');
    const mount = unwrap(mountCanvasA11y({ host: surface, document }));
    expect(mount.apply(snapshot).ok).toBe(true);
    expectNoA11yIssues(element);
    expect([...surface.querySelectorAll('[tabindex="0"]')].map((el) => el.getAttribute('data-sf-a11y-id'))).toEqual(['a']);
    expect(mount.layer.element('a')?.getAttribute('aria-description')).toBe('instance 3 of 8');
    expect(mount.layer.element('h')?.textContent).toBe('Night market\nFridays');
    // The canvas region still exits by the keyboard: its description names the way out (SC 2.1.2).
    expect(mount.layer.root.getAttribute('aria-description')).toMatch(/Alt\+Enter .*Mod\+K/);
    mount.dispose();
  });
});
