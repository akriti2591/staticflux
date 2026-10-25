import { afterEach, describe, expect, it } from 'vitest';
import {
  type BaselineVerdict,
  DEFAULT_UNSUPPORTED_COPY,
  mountUnsupportedScreen,
  UNSUPPORTED_SCREEN_ID,
  unsupportedScreenModel,
} from './index.js';

const verdict: BaselineVerdict = {
  baseline: 'app',
  status: 'unsupported',
  missing: [
    { id: 'fact:platform/webgpu-adapter', label: 'WebGPU with a usable graphics adapter', code: 'APP-PLAT-002', fix: 'Turn on hardware acceleration.', reason: 'rejected' },
    { id: 'api:crossOriginIsolated', label: '<b>Cross-origin isolation</b>', code: 'APP-PLAT-003', fix: 'Reload once.', reason: 'absent' },
  ],
  pending: [],
  codes: ['APP-PLAT-002', 'APP-PLAT-003'],
};

afterEach(() => {
  document.body.replaceChildren();
});

describe('unsupportedScreenModel', () => {
  it('uses default copy and lists every miss with its code and fix', () => {
    const model = unsupportedScreenModel(verdict);
    expect(model).toMatchObject({ title: DEFAULT_UNSUPPORTED_COPY.title, lead: DEFAULT_UNSUPPORTED_COPY.lead, code: 'APP-PLAT-002', help: undefined });
    expect(model.items).toEqual([
      { label: 'WebGPU with a usable graphics adapter', code: 'APP-PLAT-002', fix: 'Turn on hardware acceleration.' },
      { label: '<b>Cross-origin isolation</b>', code: 'APP-PLAT-003', fix: 'Reload once.' },
    ]);
  });

  it('takes translated copy and a help link (label defaults to the URL)', () => {
    const model = unsupportedScreenModel(verdict, { title: 'Instaflow needs Chrome on desktop', helpUrl: 'https://example.test/help' });
    expect(model.title).toBe('Instaflow needs Chrome on desktop');
    expect(model.help).toEqual({ label: 'https://example.test/help', url: 'https://example.test/help' });
  });
});

describe('mountUnsupportedScreen (happy-dom)', () => {
  it('renders one landmark with the headline code, the "use Chrome" line and each miss', () => {
    const screen = mountUnsupportedScreen(document.body, unsupportedScreenModel(verdict, { helpUrl: 'https://example.test/help', helpLabel: 'How to fix' }), document);
    const root = document.getElementById(UNSUPPORTED_SCREEN_ID);
    expect(root).not.toBeNull();
    expect(root?.tagName).toBe('MAIN');
    expect(root?.getAttribute('data-code')).toBe('APP-PLAT-002');
    expect(root?.getAttribute('aria-labelledby')).toBe(`${UNSUPPORTED_SCREEN_ID}-title`);
    expect(document.getElementById(`${UNSUPPORTED_SCREEN_ID}-title`)?.textContent).toBe(DEFAULT_UNSUPPORTED_COPY.title);
    expect(root?.textContent).toContain('Use Chrome on desktop');
    const items = [...(root?.querySelectorAll('li') ?? [])];
    expect(items.map((li) => li.getAttribute('data-code'))).toEqual(['APP-PLAT-002', 'APP-PLAT-003']);
    expect(items[0]?.querySelector('code')?.textContent).toBe('APP-PLAT-002');
    expect(items[0]?.querySelector('p')?.textContent).toBe('Turn on hardware acceleration.');
    const link = root?.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.test/help');
    expect(link?.textContent).toBe('How to fix');
    screen.dispose();
    expect(document.getElementById(UNSUPPORTED_SCREEN_ID)).toBeNull();
  });

  it('renders labels as text, never as HTML', () => {
    mountUnsupportedScreen(document.body, unsupportedScreenModel(verdict), document);
    expect(document.querySelector('li b')).toBeNull();
    expect(document.querySelectorAll('li strong')[1]?.textContent).toBe('<b>Cross-origin isolation</b>');
  });

  it('without misses there is no list and no headline code', () => {
    const screen = mountUnsupportedScreen(document.body, unsupportedScreenModel({ ...verdict, missing: [], codes: [] }), document);
    expect(screen.root).toBe(document.getElementById(UNSUPPORTED_SCREEN_ID));
    expect(document.querySelector('ul')).toBeNull();
    expect(document.getElementById(UNSUPPORTED_SCREEN_ID)?.hasAttribute('data-code')).toBe(false);
  });
});
