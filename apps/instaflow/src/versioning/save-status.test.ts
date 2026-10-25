import { box, unit } from '@staticflux/core';
import { HeadConflictError } from '@staticflux/document/v2';
import type { SfStatusElement } from '@staticflux/kit/status';
import { auditA11y } from '@staticflux/testkit/a11y';
import { compileTheme } from '@staticflux/ui/theme';
import { mountTestRoot, settle } from '@staticflux/ui/testing';
import { html, render } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanPopTheme } from '../theme/clean-pop.js';
import type { LatestService, SaveState } from './latest.js';
import { defineSaveStatus, type IfSaveStatusElement, saveStatusView } from './save-status.js';
import { LatestServiceToken } from './tokens.js';

const text = (key: string, cause?: string): string => (cause === undefined ? key : `${key}:${cause}`);

describe('saveStatusView', () => {
  it('maps every save state to a tone, a busy flag and words', () => {
    expect(saveStatusView({ status: 'saved', stalled: false, since: 0 }, text)).toEqual({ tone: 'success', busy: false, label: 'saved' });
    expect(saveStatusView({ status: 'saving', stalled: false, since: 0 }, text)).toEqual({ tone: 'neutral', busy: true, label: 'saving' });
    expect(saveStatusView({ status: 'saving', stalled: true, since: 0 }, text)).toEqual({ tone: 'warning', busy: false, label: 'notSavedUnknown' });
    expect(saveStatusView({ status: 'saving', stalled: true, cause: HeadConflictError({ message: 'disk full' }), since: 0 }, text).label).toBe('notSaved:disk full');
    expect(saveStatusView({ status: 'offline-mirror-behind', stalled: false, since: 0 }, text)).toEqual({ tone: 'warning', busy: false, label: 'mirrorBehind' });
  });
});

describe('<if-save-status>', () => {
  let dispose: (() => Promise<void>) | undefined;
  beforeAll(() => defineSaveStatus());
  afterEach(async () => {
    await dispose?.();
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  it('renders the Latest service state reactively in a polite live region', async () => {
    const style = document.createElement('style');
    style.textContent = compileTheme(cleanPopTheme);
    document.head.append(style);
    const state = box<SaveState>({ status: 'saved', stalled: false, since: 0 });
    const latest: LatestService = { state: () => state.get(), onChange: () => () => {}, flush: async () => ({ ok: true, value: undefined }), dispose: () => {} };
    const root = mountTestRoot({ units: [unit({ id: 'test/latest', provides: LatestServiceToken, scope: 'app', create: () => latest })] });
    dispose = () => root.dispose();
    render(html`<if-save-status></if-save-status>`, root.container);
    await settle();
    const host = root.container.querySelector('if-save-status') as IfSaveStatusElement;
    await host.updateComplete;
    const status = (): SfStatusElement => host.shadowRoot?.querySelector('sf-status') as SfStatusElement;
    expect(status().getAttribute('role')).toBe('status');
    expect(status().textContent).toBe('Saved');
    expect(status().tone).toBe('success');
    expect(auditA11y(root.container)).toEqual([]);

    state.set({ status: 'saving', stalled: false, since: 1 });
    await settle();
    await host.updateComplete;
    expect(status().textContent).toBe('Saving…');
    expect(status().busy).toBe(true);

    state.set({ status: 'saving', stalled: true, cause: HeadConflictError({ message: 'storage is full' }), since: 2 });
    await settle();
    await host.updateComplete;
    expect(status().textContent).toBe('Not saved yet: storage is full');
    expect(status().tone).toBe('warning');

    state.set({ status: 'offline-mirror-behind', stalled: false, since: 3 });
    await settle();
    await host.updateComplete;
    expect(status().textContent).toBe('Saved in this browser · folder not updated');
  });
});
