/**
 * Headless test harness: boots the fully composed Studio app in happy-dom against
 * mock services (data mock transport, mock BFF, in-thread document worker, memory
 * storage shared across boots) and exposes the services tests assert on.
 */
import type { Token } from '@staticflux/core';
import { type SessionStore, SessionToken } from '@staticflux/auth';
import { type Router, RouterToken } from '@staticflux/router';
import { type FeatureHost, FeatureHostToken } from '@staticflux/runtime';
import { bootStudio, type StudioApp } from '../app/compose.js';
import { createHeadlessEnvironment, type HeadlessEnvironment, type HeadlessOptions } from '../app/headless.js';
import { mountStudioUi } from '../app/shell.js';

export interface Harness {
  readonly studio: StudioApp;
  readonly env: HeadlessEnvironment;
  readonly router: Router;
  readonly session: SessionStore;
  readonly host: FeatureHost;
  get<T>(token: Token<T>): Promise<T>;
  /** Root element when booted with `render: true`. */
  readonly root: HTMLElement | undefined;
  dispose(): Promise<void>;
}

export async function waitFor(condition: () => boolean, { timeoutMs = 4000, message = 'condition' }: { readonly timeoutMs?: number; readonly message?: string } = {}): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

export async function bootHeadless(options: HeadlessOptions & { readonly render?: boolean } = {}): Promise<Harness> {
  const env = createHeadlessEnvironment(options);
  const booted = await bootStudio(env);
  if (!booted.ok) throw booted.error;
  const studio = booted.value;
  let root: HTMLElement | undefined;
  let unmount: (() => void) | undefined;
  if (options.render === true) {
    root = document.createElement('div');
    document.body.append(root);
    const mounted = await mountStudioUi(root, studio.injector);
    if (!mounted.ok) throw mounted.error;
    unmount = mounted.value;
  }
  const [router, session, host] = await Promise.all([studio.get(RouterToken), studio.get(SessionToken), studio.get(FeatureHostToken)]);
  await studio.app.supervisor.settled();
  return {
    studio,
    env,
    router,
    session,
    host,
    root,
    get: (token) => studio.get(token),
    async dispose() {
      unmount?.();
      root?.remove();
      await studio.shutdown();
    },
  };
}

/** Simulate the BFF login round trip: the app navigated to the mock login page; the
 * BFF authenticates and redirects back, which in a browser is a full page load —
 * here, a second boot against the same server and storage. */
export async function completeLoginRedirect(previous: Harness, options: { readonly render?: boolean } = {}): Promise<Harness> {
  const loginUrl = previous.env.navigations.at(-1);
  if (loginUrl === undefined) throw new Error('No login redirect was requested.');
  const returnTo = previous.env.server.completeBffLogin(loginUrl);
  await previous.dispose();
  return bootHeadless({ url: returnTo, server: previous.env.server, storage: previous.env.storage, ...options });
}
