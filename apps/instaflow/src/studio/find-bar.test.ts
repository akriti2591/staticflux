/** B11c slice 3: the find bar (STUDIO §9.1) over a fake port: search, step, replace one and all, kinds, memory, a11y. */
import { auditA11y, press } from '@staticflux/testkit/a11y';
import { compileTheme } from '@staticflux/ui/theme';
import { mountTestRoot, settle } from '@staticflux/ui/testing';
import { html, render } from 'lit';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FindMatch, FindQuery } from '../app/find-replace.js';
import { cleanPopTheme } from '../theme/clean-pop.js';
import { defineFindBar, FIND_MEMORY_KEY, type FindBarPort, type IfFindBarElement, readFindMemory } from './find-bar.js';

const match = (node: string, i: number, extra: Partial<FindMatch> = {}): FindMatch => ({ id: `${node}:text:${i}`, node, page: 'p1', pageName: 'Page 1', label: `Text ${node}`, where: 'text', from: i, to: i + 4, locked: false, hidden: false, ...extra });

describe('<if-find-bar>', () => {
  let dispose: (() => Promise<void>) | undefined;
  beforeAll(() => defineFindBar());
  beforeEach(() => localStorage.clear());
  afterEach(async () => {
    await dispose?.();
    dispose = undefined;
    document.head.innerHTML = '';
  });

  async function mount(matches: FindMatch[] = [match('a', 0), match('b', 0), match('c', 3, { page: 'p2', pageName: 'Back' })]) {
    const style = document.createElement('style');
    style.textContent = compileTheme(cleanPopTheme);
    document.head.append(style);
    const root = mountTestRoot({ units: [] });
    dispose = () => root.dispose();
    const calls: string[] = [];
    const announced: string[] = [];
    let list = matches;
    const port: FindBarPort = {
      find: async (q: FindQuery) => {
        calls.push(`find ${q.kind}:${q.query}:${q.scope}${q.matchCase === true ? ':Aa' : ''}${q.nodes === undefined ? '' : `:${q.nodes.join(',')}`}`);
        return { matches: q.query === 'none' ? [] : list, pages: 2 };
      },
      replace: async (q, replacement, o) => {
        calls.push(`replace ${q.query}→${replacement}${o.only === undefined ? ' all' : ` ${o.only.join(',')}`}${o.font === undefined ? '' : ' font'}`);
        list = o.only === undefined ? [] : list.filter((x) => !o.only?.includes(x.id));
        return { ops: 1, replaced: o.only === undefined ? 3 : 1, skipped: o.only === undefined ? 1 : 0, label: 'Replace' };
      },
      reveal: (m) => void calls.push(`reveal ${m.node}`),
    };
    render(
      html`<if-find-bar
        .port=${port}
        .selection=${['a']}
        .fonts=${[{ label: 'Inter', value: { font: 'sha256:inter', family: 'Inter' } }]}
        @if-announce=${(e: CustomEvent<{ message: string }>) => announced.push(e.detail.message)}
        @if-find-close=${() => calls.push('close')}
      ></if-find-bar>`,
      root.container,
    );
    await settle(4);
    const bar = root.container.querySelector('if-find-bar') as IfFindBarElement;
    await bar.updateComplete;
    const shadow = bar.shadowRoot as ShadowRoot;
    const type = async (text: string) => {
      const input = shadow.querySelector('sf-text-field.query')?.shadowRoot?.querySelector('input') as HTMLInputElement;
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      await bar.search();
      await bar.updateComplete;
    };
    return { bar, shadow, calls, announced, root, type };
  }

  it('searches as you type; the count, ↑ ↓, Enter and Mod+G step and announce; Escape closes', async () => {
    const { bar, shadow, calls, announced, root, type } = await mount();
    expect(shadow.querySelector('[role="search"]')?.getAttribute('aria-label')).toBe('Find');
    await type('sale');
    expect(calls).toEqual(['find text:sale:all']);
    expect(shadow.querySelector('.count')?.textContent).toBe('0 of 3');
    expect(auditA11y(root.container)).toEqual([]);
    (shadow.querySelector('sf-icon-button.next') as HTMLElement).click();
    await bar.updateComplete;
    expect(shadow.querySelector('.count')?.textContent).toBe('1 of 3');
    const input = shadow.querySelector('sf-text-field.query')?.shadowRoot?.querySelector('input') as HTMLInputElement;
    press(input, 'Enter');
    press(input, 'g', { ctrl: true });
    press(input, 'Enter', { shift: true });
    (shadow.querySelector('sf-icon-button.previous') as HTMLElement).click();
    await bar.updateComplete;
    expect(calls.filter((c) => c.startsWith('reveal'))).toEqual(['reveal a', 'reveal b', 'reveal c', 'reveal b', 'reveal a']);
    expect(announced.at(2)).toBe('Match 3 of 3: Text c on Back');
    press(input, 'Escape');
    expect(calls.at(-1)).toBe('close');
  });

  it('says when nothing matches; Aa and the scope reach the query and are remembered', async () => {
    const { bar, shadow, calls, type } = await mount();
    await type('none');
    expect(shadow.querySelector('.note')?.textContent).toBe("No matches for 'none' in 2 pages");
    (shadow.querySelector('sf-icon-button.match-case') as HTMLElement).click();
    await bar.updateComplete;
    await bar.search();
    (shadow.querySelector('sf-menu.scope') as HTMLElement).dispatchEvent(new CustomEvent('sf-select', { detail: { value: 'selection' } }));
    await bar.updateComplete;
    await bar.search();
    // Changing Aa or the scope searches again by itself.
    expect(calls).toContain('find text:none:all:Aa');
    expect(calls.at(-1)).toBe('find text:none:selection:Aa:a');
    expect(readFindMemory(localStorage)).toEqual({ kind: 'text', scope: 'selection' });
    expect(JSON.parse(localStorage.getItem(FIND_MEMORY_KEY) ?? '{}').scope).toBe('selection');
  });

  it('Replace ▾ adds the row: Replace does the current match and moves on, Replace all does all and says what was skipped', async () => {
    const { bar, shadow, calls, root, type } = await mount();
    await type('sale');
    (shadow.querySelector('sf-button.replace-toggle') as HTMLElement).click();
    await bar.updateComplete;
    expect(bar.replacing).toBe(true);
    const field = shadow.querySelector('sf-text-field.replacement')?.shadowRoot?.querySelector('input') as HTMLInputElement;
    field.value = 'deal';
    field.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    await bar.updateComplete;
    expect(auditA11y(root.container)).toEqual([]);
    bar.step(1);
    await bar.replace(false);
    await bar.updateComplete;
    expect(calls).toContain('replace sale→deal a:text:0');
    expect(calls.at(-1)).toBe('reveal b'); // the next match
    await bar.replace(true);
    await bar.updateComplete;
    expect(calls).toContain('replace sale→deal all');
    expect(shadow.querySelector('.note')?.textContent).toBe('1 locked, skipped');
  });

  it('Font: the replacement is a font from the document’s fonts; Colour shows a swatch', async () => {
    const { bar, shadow, calls, type } = await mount();
    (shadow.querySelector('sf-menu.kind') as HTMLElement).dispatchEvent(new CustomEvent('sf-select', { detail: { value: 'font' } }));
    await bar.updateComplete;
    await type('Noto Sans');
    bar.replacing = true;
    await bar.updateComplete;
    expect((shadow.querySelector('sf-button.replace-all') as HTMLElement & { disabled: boolean }).disabled).toBe(true);
    (shadow.querySelector('sf-menu.font-menu') as HTMLElement).dispatchEvent(new CustomEvent('sf-select', { detail: { value: '0' } }));
    await bar.updateComplete;
    await bar.replace(true);
    expect(calls.at(-2)).toBe('replace Noto Sans→Inter all font');
    (shadow.querySelector('sf-menu.kind') as HTMLElement).dispatchEvent(new CustomEvent('sf-select', { detail: { value: 'colour' } }));
    await bar.updateComplete;
    await type('#ff5c39');
    expect(shadow.querySelector('.swatch')).not.toBeNull();
    expect(readFindMemory(localStorage).kind).toBe('colour');
  });
});
