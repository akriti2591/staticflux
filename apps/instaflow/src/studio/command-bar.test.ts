/**
 * `<if-command-bar>` (B11b, STUDIO-UX-SPEC §4.4): lists only what can run now (the selection's applicable capabilities,
 * the no-selection commands, tools, the camera), recent commands first and once, runs a row by firing `if-command`,
 * and passes the a11y audit under Clean Pop.
 */
import { expectNoA11yIssues } from '@staticflux/testkit/a11y';
import { compileTheme } from '@staticflux/ui/theme';
import { mountTestRoot, settle } from '@staticflux/ui/testing';
import { html, render } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_SELECTION, type SelectionSummary } from '../app/scene-summary.js';
import { cleanPopTheme } from '../theme/clean-pop.js';
import { type CommandSources, commandEntries, defineCommandBar, type IfCommandBarElement, pushRecent, RECENT_LIMIT } from './command-bar.js';

const actions = new Map(
  ['instaflow/delete', 'instaflow/duplicate', 'instaflow/rename', 'instaflow/undo', 'instaflow/redo'].map((id) => [id, { id, title: id.slice('instaflow/'.length), ...(id === 'instaflow/delete' ? { shortcut: 'Delete' } : {}) }]),
);
const shape: SelectionSummary = { ...EMPTY_SELECTION, kind: 'shape', nodes: ['a'], label: 'Rectangle', typeLabel: 'Rectangle', actions: ['instaflow/delete', 'instaflow/duplicate', 'instaflow/rename', 'instaflow/unknown'] };
const sources = (extra: Partial<CommandSources> = {}): CommandSources => ({
  selection: shape,
  actions,
  globalActions: ['instaflow/undo', 'instaflow/redo'],
  tools: [{ value: 'tool:instaflow/tool-text', title: 'Text', shortcut: 'T' }],
  camera: [{ value: 'camera:fit-page', title: 'Zoom to fit' }],
  recent: [],
  ...extra,
});
const flat = (s: CommandSources): readonly [string, readonly string[]][] => commandEntries(s).map(([g, list]) => [g, list.map((e) => e.value)]);

describe('commandEntries', () => {
  it('the selection’s applicable capabilities (minus form-only ones and unknown ids), then edit, tools, view', () => {
    expect(flat(sources())).toEqual([
      ['selection', ['cap:instaflow/delete', 'cap:instaflow/duplicate']],
      ['edit', ['cap:instaflow/undo', 'cap:instaflow/redo']],
      ['tools', ['tool:instaflow/tool-text']],
      ['view', ['camera:fit-page']],
    ]);
  });

  it('nothing selected: no selection group', () => {
    expect(flat(sources({ selection: EMPTY_SELECTION })).map(([g]) => g)).toEqual(['edit', 'tools', 'view']);
  });

  it('recent first, each once, and only while still runnable', () => {
    const groups = flat(sources({ recent: ['cap:instaflow/duplicate', 'cap:instaflow/gone', 'camera:fit-page'] }));
    expect(groups[0]).toEqual(['recent', ['cap:instaflow/duplicate', 'camera:fit-page']]);
    expect(groups.find(([g]) => g === 'selection')?.[1]).toEqual(['cap:instaflow/delete']);
    expect(groups.find(([g]) => g === 'view')).toBeUndefined();
  });

  it('pushRecent: newest first, deduplicated, capped', () => {
    let list: readonly string[] = [];
    for (let i = 0; i < RECENT_LIMIT + 2; i++) list = pushRecent(list, `v${i}`);
    expect(list).toHaveLength(RECENT_LIMIT);
    expect(pushRecent(list, 'v3')[0]).toBe('v3');
    expect(pushRecent(list, 'v3').filter((v) => v === 'v3')).toHaveLength(1);
  });
});

let dispose: (() => Promise<void>) | undefined;
beforeAll(() => defineCommandBar());
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  try {
    localStorage.clear();
  } catch {
    // no storage
  }
});

describe('<if-command-bar>', () => {
  it('opens on the filter, runs a row through if-command, remembers it, and passes the audit', async () => {
    const style = document.createElement('style');
    style.textContent = compileTheme(cleanPopTheme);
    document.head.append(style);
    const root = mountTestRoot({ units: [] });
    dispose = () => root.dispose();
    const ran: string[] = [];
    render(html`<if-command-bar .sources=${sources()} @if-command=${(e: CustomEvent<{ value: string }>) => ran.push(e.detail.value)}></if-command-bar>`, root.container);
    await settle(6);
    const bar = root.container.querySelector('if-command-bar') as IfCommandBarElement;
    const shadow = bar.shadowRoot as ShadowRoot;
    expect(shadow.querySelector('.trigger')?.textContent).toContain('Type a command');
    expectNoA11yIssues(bar);
    bar.open();
    await settle(4);
    expect(shadow.querySelector('sf-menu')?.hasAttribute('open') || (shadow.querySelector('sf-menu') as unknown as { open?: boolean }).open).toBeTruthy();
    expect([...shadow.querySelectorAll('sf-menu-item')].map((i) => i.getAttribute('value'))).toContain('cap:instaflow/delete');
    shadow.querySelector('sf-menu')?.dispatchEvent(new CustomEvent('sf-select', { detail: { value: 'cap:instaflow/duplicate' } }));
    await settle(2);
    expect(ran).toEqual(['cap:instaflow/duplicate']);
    expect(shadow.querySelector('sf-menu-group')?.getAttribute('label')).toBe('Recent');
  });
});
