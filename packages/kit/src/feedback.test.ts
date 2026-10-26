/**
 * Feedback and small blocks (OVERLAYS-FEEDBACK §2.3–§3.5, §5; DENSITY-DISCLOSURE §2): the SfError mapping (code never
 * shown), banners, the blocking error, progress, the inline confirm row, the copy field, first-use hints, disclosures.
 */
import { createScope, defineError, err, ok, unit } from '@staticflux/core';
import { createManualClock, createMemoryKeyValue, createSurfaceManager, defineCoachTarget, strictSurfacePolicy, SurfaceManagerToken } from '@staticflux/messaging';
import { deepFocused, expectNoA11yIssues, press } from '@staticflux/testkit/a11y';
import { manualVisibility } from '@staticflux/ui/testing';
import { html } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defineConfirmRow, type SfConfirmRowElement } from './confirm-row.js';
import { browserClipboardWrite, defineCopyField, type SfCopyFieldElement } from './copy-field.js';
import { defineDisclosure, type SfDisclosureElement } from './disclosure.js';
import {
  defineFeedback,
  diagnosticsText,
  errorFeedback,
  feedbackLevel,
  progressFraction,
  type SfBannerElement,
  type SfBlockingErrorElement,
  type SfProgressRowElement,
} from './feedback.js';
import { defineHint, HINT_MS } from './hint.js';
import { defineBlockingErrorSurface, defineHintSurface, defineSurfaces, type SfSurfaceLayerElement } from './surfaces.js';
import { cleanup, events, fixture, settle, shadow } from './test-helpers.js';

beforeAll(() => {
  defineFeedback();
  defineConfirmRow();
  defineCopyField();
  defineHint();
  defineDisclosure();
  defineSurfaces();
});
afterEach(cleanup);

const StorageFull = defineError('TEST-STORE-001', 'quota', 'Storage is full.', 'Free space in the origin quota (developer advice).');

describe('SfError → feedback (§3.2)', () => {
  it('uses the message line and the given fix; the code and the developer fix are never in what is shown', () => {
    const error = StorageFull({ details: { used: 10 }, traceId: 'abc' });
    const plain = errorFeedback(error);
    expect(plain.message).toBe('Storage is full.');
    expect(plain.fix).toBeUndefined();
    const copy = errorFeedback(error, { message: "Couldn't save: storage is full.", fix: { kind: 'action', label: 'Open Storage settings' } });
    expect(copy.message).toBe("Couldn't save: storage is full.");
    expect(copy.fix).toEqual({ kind: 'action', label: 'Open Storage settings' });
    for (const shown of [copy.message, JSON.stringify(copy.fix)]) {
      expect(shown).not.toContain('TEST-STORE-001');
      expect(shown).not.toContain('developer advice');
    }
    expect(copy.diagnostics).toBe(diagnosticsText(error));
    expect(copy.diagnostics).toContain('TEST-STORE-001 (quota)');
    expect(copy.diagnostics).toContain('"used":10');
    expect(copy.diagnostics).toContain('trace abc');
  });

  it('chooses the level by origin', () => {
    expect([feedbackLevel('field'), feedbackLevel('region'), feedbackLevel('capability'), feedbackLevel('condition'), feedbackLevel('boot')]).toEqual(['inline', 'section', 'toast', 'banner', 'blocking']);
  });
});

describe('<sf-banner>', () => {
  it('is a status without controls, a named region with an action, and offers × only when informational', async () => {
    const { element } = await fixture<HTMLDivElement>(
      html`<div>
        <sf-banner tone="warning" message="You're offline. Fonts need a connection; editing works."></sf-banner>
        <sf-banner tone="danger" message="Storage is full. Nothing is lost until the tab closes." action-label="Open Storage settings" dismissible></sf-banner>
        <sf-banner tone="info" message="This design is in the trash." action-label="Restore" dismissible></sf-banner>
      </div>`,
    );
    const [offline, full, trashed] = [...element.querySelectorAll('sf-banner')] as SfBannerElement[];
    expect(offline?.getAttribute('role')).toBe('status');
    expect(full?.getAttribute('role')).toBe('region');
    expect(full?.canDismiss).toBe(false);
    expect(full?.shadowRoot?.querySelector('sf-icon-button')).toBeNull();
    expect(trashed?.shadowRoot?.querySelector('sf-icon-button')).not.toBeNull();
    const actions = events(full as Element, 'sf-action');
    (shadow(full as Element, 'sf-button') as HTMLElement).click();
    expect(actions).toHaveLength(1);
    expectNoA11yIssues(element);
  });
});

describe('<sf-blocking-error> and its surface', () => {
  it('replaces an open dialog, is an alertdialog that Escape cannot close, and keeps the code for Copy diagnostics only', async () => {
    const manager = createSurfaceManager({ policy: strictSurfacePolicy, clock: createManualClock() });
    const managerUnit = unit({ id: 'test/surfaces', provides: SurfaceManagerToken, scope: 'app', create: () => manager });
    const { element } = await fixture<SfSurfaceLayerElement>(html`<sf-surface-layer></sf-surface-layer>`, { units: [managerUnit] });
    const owner = { scope: createScope('app') };
    const surface = defineBlockingErrorSurface({ id: 'test/cant-start' });
    const copied: string[] = [];
    let reloads = 0;
    const error = StorageFull();
    const handle = manager.request(surface, {
      owner,
      replace: true,
      props: { heading: "The editor can't start", message: 'Reload to try again. Your work is saved.', diagnostics: errorFeedback(error).diagnostics, onReload: () => (reloads += 1), onCopyDiagnostics: (text) => copied.push(text) },
    });
    await settle();
    const dialog = element.shadowRoot?.querySelector('dialog') as HTMLDialogElement;
    expect(dialog.getAttribute('role')).toBe('alertdialog');
    const card = dialog.querySelector('sf-blocking-error') as SfBlockingErrorElement;
    expect(card.shadowRoot?.textContent).not.toContain('TEST-STORE-001');
    expectNoA11yIssues(element);
    press(document.body, 'Escape');
    await settle();
    expect(handle.state).toBe('showing');
    const [copy, reload] = [...(card.shadowRoot?.querySelectorAll('sf-button') ?? [])] as HTMLElement[];
    copy?.click();
    reload?.click();
    expect(copied[0]).toContain('TEST-STORE-001');
    expect(reloads).toBe(1);
  });
});

describe('<sf-progress-row>', () => {
  it('is determinate when steps are countable, indeterminate otherwise, and cancels', async () => {
    const { element } = await fixture<HTMLDivElement>(
      html`<div><sf-progress-row label="Rendering page 2 of 5" .value=${2} .max=${5}></sf-progress-row><sf-progress-row label="Preparing fonts"></sf-progress-row></div>`,
    );
    const [counted, unknown] = [...element.querySelectorAll('sf-progress-row')] as SfProgressRowElement[];
    const bar = shadow(counted as Element, '[role="progressbar"]');
    expect(bar.getAttribute('aria-valuenow')).toBe('2');
    expect(bar.getAttribute('aria-valuetext')).toBe('Rendering page 2 of 5');
    expect(shadow(unknown as Element, '[role="progressbar"]').hasAttribute('aria-valuenow')).toBe(false);
    expect(shadow(unknown as Element, '.bar').hasAttribute('data-indeterminate')).toBe(true);
    const cancels = events(counted as Element, 'sf-cancel');
    (shadow(counted as Element, 'sf-button') as HTMLElement).click();
    expect(cancels).toHaveLength(1);
    expect(progressFraction(3, 2)).toBe(1);
    expect(progressFraction(undefined, 2)).toBeUndefined();
    expectNoA11yIssues(element);
  });
});

describe('<sf-confirm-row>', () => {
  it('focuses the safe action, Escape cancels inside the row', async () => {
    const { element } = await fixture<SfConfirmRowElement>(html`<sf-confirm-row message="Delete 'Client v1'?" confirm-label="Delete"></sf-confirm-row>`);
    await settle();
    expect(deepFocused()?.textContent).toBe('Cancel');
    const cancels = events(element, 'sf-cancel');
    const confirms = events(element, 'sf-confirm');
    const escape = press(deepFocused() as Element, 'Escape');
    expect(escape.defaultPrevented).toBe(true);
    expect(cancels).toHaveLength(1);
    (shadow(element, '.confirm') as HTMLElement).click();
    expect(confirms).toHaveLength(1);
    expectNoA11yIssues(element);
  });
});

describe('<sf-copy-field>', () => {
  it('reads Copied after a copy and shows advice inline when the clipboard refuses', async () => {
    const { element } = await fixture<SfCopyFieldElement>(html`<sf-copy-field label="Link" value="https://instaflow.app/s/abc"></sf-copy-field>`);
    const written: string[] = [];
    element.write = async (text) => {
      written.push(text);
      return ok(undefined);
    };
    const copies = events<{ ok: boolean }>(element, 'sf-copy');
    expect((await element.copy()).ok).toBe(true);
    await settle();
    expect(written).toEqual(['https://instaflow.app/s/abc']);
    expect(shadow(element, 'sf-button').textContent).toContain('Copied');
    expectNoA11yIssues(element);
    element.write = async () => err(StorageFull());
    await element.copy();
    await settle();
    expect(copies.map((e) => e.detail.ok)).toEqual([true, false]);
    expect(shadow(element, '.error').textContent).toContain('clipboard');
    expect(shadow(element, 'input').getAttribute('aria-describedby')).toBe(shadow(element, '.error').id);
    expectNoA11yIssues(element);
    const missing = await browserClipboardWrite({} as Navigator)('x');
    expect(missing.ok ? '' : missing.error.code).toBe('SF-KIT-004');
  });
});

describe('first-use hints', () => {
  it('show at their target once, ignore Escape, and count as seen after × or the timer', async () => {
    const visibility = manualVisibility();
    const clock = createManualClock();
    const seen = createMemoryKeyValue<boolean>();
    const manager = createSurfaceManager({ policy: strictSurfacePolicy, clock, visibility, seen });
    const managerUnit = unit({ id: 'test/surfaces', provides: SurfaceManagerToken, scope: 'app', create: () => manager });
    const { element } = await fixture<SfSurfaceLayerElement>(html`<sf-surface-layer></sf-surface-layer>`, { units: [managerUnit] });
    const FrameTool = defineCoachTarget('test/frame-tool');
    const hint = defineHintSurface({ id: 'test/frame-hint', target: FrameTool, text: 'Drag on the canvas to draw a frame.' });
    const tool = document.createElement('button');
    tool.textContent = 'Frame';
    document.body.append(tool);
    manager.targets.register(FrameTool, tool);
    visibility.show(tool);
    const owner = { scope: createScope('view') };
    const handle = manager.request(hint, { owner });
    await settle();
    expect(handle.state).toBe('showing');
    const card = element.shadowRoot?.querySelector('sf-hint') as HTMLElement;
    expect(card.shadowRoot?.textContent).toContain('Drag on the canvas');
    expect(element.shadowRoot?.querySelector('.anchored')?.getAttribute('aria-label')).toBe('Drag on the canvas to draw a frame.');
    expect(shadow(card, 'button').getAttribute('tabindex')).toBe('-1');
    expectNoA11yIssues(element);
    press(document.body, 'Escape');
    await settle();
    expect(handle.state).toBe('showing');
    card.dispatchEvent(new CustomEvent('sf-expire', { bubbles: true, composed: true }));
    expect((await handle.closed).reason).toBe('completed');
    await settle();
    expect(seen.entries.get('messaging/seen/test/frame-hint')).toBe(true);
    const again = manager.request(hint, { owner });
    expect((await again.closed).reason).toBe('seen');
    expect(HINT_MS).toBe(6000);
  });
});

describe('<sf-disclosure>', () => {
  it('sections show a summary while collapsed; More rows a count; pinned is always open', async () => {
    const { element } = await fixture<HTMLDivElement>(
      html`<div>
        <sf-disclosure heading="Effects" summary="Shadow" key="inspector/effects"><p>rows</p></sf-disclosure>
        <sf-disclosure variant="more" .count=${2} key="inspector/transform-more"><p>skew</p></sf-disclosure>
        <sf-disclosure heading="Layer" pinned><p>opacity</p></sf-disclosure>
      </div>`,
    );
    const [section, more, pinned] = [...element.querySelectorAll('sf-disclosure')] as SfDisclosureElement[];
    expect(shadow(section as Element, '.summary').textContent).toBe('Shadow');
    expect(shadow(section as Element, '.body').hidden).toBe(true);
    const toggles = events<{ open: boolean; key: string }>(section as Element, 'sf-toggle');
    (shadow(section as Element, 'button') as HTMLElement).click();
    await settle();
    expect(toggles[0]?.detail).toEqual({ open: true, key: 'inspector/effects' });
    expect(section?.shadowRoot?.querySelector('.summary')).toBeNull();
    expect(shadow(more as Element, '.count').textContent).toBe('2');
    expect(shadow(more as Element, '.heading').textContent).toBe('More');
    expect(pinned?.shadowRoot?.querySelector('button')).toBeNull();
    expect(pinned?.expanded).toBe(true);
    expectNoA11yIssues(element);
  });
});
