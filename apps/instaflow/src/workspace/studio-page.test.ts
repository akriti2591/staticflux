/**
 * The Studio page's boot (#62) with a deferred fake session: the frame mounts before the session resolves, then the
 * app mounts in its place; the missing-design and the error paths still work (and leave no frame behind).
 */
import { err, ok, type Result, type SfError } from '@staticflux/core';
import { compileTheme } from '@staticflux/ui/theme';
import { settle } from '@staticflux/ui/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerBootError } from '../workers/errors.js';
import { UnknownDesignError } from '../home/errors.js';
import { cleanPopTheme } from '../theme/clean-pop.js';
import { createDeviceSettings } from '../settings/device-settings.js';
import { bootFailureText, bootStudioPage } from './studio-page.js';
import type { StudioSession } from './studio-session.js';

let container: HTMLElement;
let status: HTMLElement;

beforeEach(() => {
  const style = document.createElement('style');
  style.textContent = compileTheme(cleanPopTheme);
  document.head.append(style);
  container = document.createElement('div');
  status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.textContent = 'Starting Studio…';
  document.body.append(container, status);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

function deferred(): { readonly promise: Promise<Result<StudioSession>>; resolve(r: Result<StudioSession>): void; reject(e: unknown): void } {
  let resolve: (r: Result<StudioSession>) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise<Result<StudioSession>>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // The page asks for the session after the frame is laid out: a rejection may come before anyone awaits it.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/** A session whose app mounts a marker element (what `StudioApp.mount` does with `<if-studio>`). */
function fakeSession(): { readonly session: StudioSession; readonly mount: ReturnType<typeof vi.fn> } {
  const mount = vi.fn((into: HTMLElement) => {
    const app = document.createElement('div');
    app.setAttribute('data-app', '');
    into.append(app);
    return app;
  });
  return { session: { app: { mount } } as unknown as StudioSession, mount };
}

const frameOptions = { settings: createDeviceSettings({ storage: null, window: null }) };
const frameElement = (): Element | null => container.querySelector('if-studio');

describe('bootStudioPage', () => {
  it('mounts the frame before the session resolves, then the app in its place', async () => {
    const pending = deferred();
    const open = vi.fn(() => pending.promise);
    const booted = bootStudioPage({ container, status, open, missing: () => undefined, frame: frameOptions });
    // The frame is there at once, inert and busy, and the session is asked for once the frame is laid out.
    const frame = frameElement();
    expect(frame).not.toBeNull();
    expect(frame?.hasAttribute('inert')).toBe(true);
    expect(container.getAttribute('aria-busy')).toBe('true');
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(frame?.shadowRoot?.querySelector('[data-region="dock"]')).not.toBeNull();
    expect(status.textContent).toBe('Starting Studio…');

    const { session, mount } = fakeSession();
    pending.resolve(ok(session));
    expect(await booted).toBe(session);
    expect(mount).toHaveBeenCalledWith(container);
    expect(frame?.isConnected).toBe(false);
    expect(frameElement()).toBeNull();
    expect(container.querySelector('[data-app]')).not.toBeNull();
    expect(container.hasAttribute('aria-busy')).toBe(false);
    expect(status.isConnected).toBe(false);
  });

  it('a design that is not here: the frame goes, the missing page shows, no alert', async () => {
    const pending = deferred();
    const missing = vi.fn();
    const booted = bootStudioPage({ container, status, open: () => pending.promise, missing, frame: frameOptions });
    expect(frameElement()).not.toBeNull();
    pending.resolve(err(UnknownDesignError({ details: { asset: 'as_gone', trashed: true, title: 'Poster' } })));
    expect(await booted).toBeUndefined();
    expect(missing).toHaveBeenCalledWith({ asset: 'as_gone', trashed: true, title: 'Poster' });
    expect(frameElement()).toBeNull();
    expect(status.isConnected).toBe(false);
  });

  it('a failed session: the frame goes and the status line says why, as an alert', async () => {
    const pending = deferred();
    const booted = bootStudioPage({ container, status, open: () => pending.promise, missing: () => undefined, frame: frameOptions });
    const error: SfError = WorkerBootError({ details: { step: 'spawn editor' } });
    pending.resolve(err(error));
    expect(await booted).toBeUndefined();
    expect(frameElement()).toBeNull();
    expect(container.hasAttribute('aria-busy')).toBe(false);
    expect(status.getAttribute('role')).toBe('alert');
    expect(status.textContent).toBe(`Studio could not start: studio: ${error.code} ${error.message}`);
  });

  it('a throw while opening (a missing store, a chunk that did not load) is the same failure', async () => {
    const pending = deferred();
    const booted = bootStudioPage({ container, status, open: () => pending.promise, missing: () => undefined, frame: frameOptions });
    pending.reject(new Error('workspace store: IF-WS-001 blocked'));
    expect(await booted).toBeUndefined();
    expect(frameElement()).toBeNull();
    expect(status.getAttribute('role')).toBe('alert');
    expect(status.textContent).toBe('Studio could not start: workspace store: IF-WS-001 blocked');
  });
});

describe('bootFailureText', () => {
  it('words an error result like the page always did (code, message, cause) and a throw by its message', () => {
    const error = WorkerBootError({ cause: new Error('no SharedArrayBuffer'), details: { step: 'ring' } });
    expect(bootFailureText(error)).toBe(`Studio could not start: studio: ${error.code} ${error.message} (no SharedArrayBuffer)`);
    expect(bootFailureText(new Error('boom'))).toBe('Studio could not start: boom');
  });
});
