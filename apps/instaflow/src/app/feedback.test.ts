// @vitest-environment node
/** Instaflow feedback: level by origin and family, words without codes, the toasts port (OVERLAYS-FEEDBACK §3). */
import { createScope, defineError } from '@staticflux/core';
import { createManualClock, createSurfaceManager, strictSurfacePolicy } from '@staticflux/messaging';
import { settle } from '@staticflux/ui/testing';
import { describe, expect, it } from 'vitest';
import { createToasts, feedbackFor, INSTAFLOW_SURFACE_UNITS } from './feedback.js';

const WorkerDied = defineError('IF-WRK-099', 'unavailable', 'The editor worker stopped.', 'Restart the worker (developer text).');
const Quota = defineError('SF-STORE-099', 'quota', 'The storage quota is exhausted.', 'Free origin storage.');
const Unsupported = defineError('IF-PLAT-099', 'unavailable', 'This browser cannot run the editor.', 'Use a browser with WebGPU.');
const ImportFailed = defineError('IF-LIB-099', 'validation', "Couldn't import 'notes.txt'.", 'Pick an image file.');

describe('feedbackFor', () => {
  it('picks the level by origin, then by family; a field error always stays inline', () => {
    expect(feedbackFor(ImportFailed(), 'capability').level).toBe('toast');
    expect(feedbackFor(WorkerDied(), 'capability').level).toBe('banner');
    expect(feedbackFor(Quota(), 'capability').level).toBe('banner');
    expect(feedbackFor(Unsupported(), 'region').level).toBe('blocking');
    expect(feedbackFor(Unsupported(), 'field').level).toBe('inline');
    expect(feedbackFor(defineError('IF-X-001', 'unknown', 'x', 'y')(), 'region').level).toBe('section');
  });

  it('uses Instaflow words when it has them and never shows the code', () => {
    const copy = new Map([[Quota, { message: 'Storage is full. Nothing is lost until the tab closes.', fix: { kind: 'action' as const, label: 'Open Storage settings' } }]]);
    const feedback = feedbackFor(Quota(), 'condition', copy);
    expect(feedback.message).toBe('Storage is full. Nothing is lost until the tab closes.');
    expect(feedback.fix).toEqual({ kind: 'action', label: 'Open Storage settings' });
    expect(feedback.message + JSON.stringify(feedback.fix)).not.toMatch(/SF-STORE|origin storage/);
    expect(feedback.diagnostics).toContain('SF-STORE-099');
    expect(INSTAFLOW_SURFACE_UNITS).toHaveLength(3);
  });
});

describe('toasts port', () => {
  function setup() {
    const clock = createManualClock();
    const manager = createSurfaceManager({ clock, policy: strictSurfacePolicy });
    const toasts = createToasts(manager, { scope: createScope('app'), level: 'app' });
    return { clock, manager, toasts };
  }

  it('times toasts by tone and action, counts repeats, caps at three', async () => {
    const { clock, manager, toasts } = setup();
    const a = toasts.show({ message: 'Copied' });
    toasts.show({ message: 'Copied' });
    await settle(1);
    expect(a.count).toBe(2);
    toasts.show({ message: 'Moved to Client work', action: { label: 'Open', run: () => undefined } });
    toasts.show({ message: 'Saved as template' });
    const fourth = toasts.show({ message: 'Exported' });
    await settle(1);
    expect(manager.showing('toast')).toHaveLength(3);
    expect(fourth.state).toBe('queued');
    clock.advance(5000);
    expect(a.state).toBe('dismissed');
  });

  it('Undo runs the inverse once, shows Restored, and undoNewest is the Home Mod+Z', async () => {
    const { manager, toasts } = setup();
    let restored = 0;
    toasts.undoable({ message: "Moved 'Poster' to the trash", undo: () => (restored += 1) });
    await settle(1);
    expect(toasts.undoNewest()).toBe(true);
    await settle(1);
    expect(restored).toBe(1);
    expect(manager.showing('toast').map((h) => (h.props as { message: string }).message)).toEqual(['Restored']);
    expect(toasts.undoNewest()).toBe(false);
  });

  it('error toasts are danger with the fix as their action when the app can run it', async () => {
    const { manager, toasts } = setup();
    let retried = 0;
    const copy = new Map([[ImportFailed, { fix: { kind: 'action' as const, label: 'Try again' } }]]);
    toasts.error(ImportFailed(), () => (retried += 1), copy);
    await settle(1);
    const [handle] = manager.showing('toast');
    const props = handle?.props as { tone: string; action?: { label: string; run: () => void } };
    expect(props.tone).toBe('danger');
    expect(props.action?.label).toBe('Try again');
    props.action?.run();
    expect(retried).toBe(1);
  });
});
