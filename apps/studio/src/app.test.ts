/**
 * Integration tests: the fully composed Studio app, booted headlessly in happy-dom
 * against mock services only (data mock transport, mock BFF, in-thread document
 * worker, mock collaboration network, mock AI provider, memory storage).
 */
import { ok } from '@staticflux/core';
import { DataTransportToken, type MockTransport } from '@staticflux/data';
import { GateFacts, GateToken, MeterRegistryToken } from '@staticflux/gate';
import { SurfaceManagerToken } from '@staticflux/messaging';
import { defaultWorkspace, WorkspaceManagerToken } from '@staticflux/shell';
import { IntentServiceToken } from '@staticflux/urlstate';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionScopeToken } from './adapters/auth-runtime.js';
import { CapabilityInvokerToken } from './adapters/capabilities-router.js';
import { CreditsMeter, DocumentStoreToken, Features, PanelControllerToken, SummarizeCapability } from './app/contracts.js';
import { DocsListEndpoint } from './app/endpoints.js';
import { HomeDocsToken } from './app/home.js';
import { ExpertWorkspace } from './app/shell.js';
import { DocRoute, LoginRoute, UpgradeDialog } from './app/routes.js';
import { ChatControllerToken } from './features/agent-chat/logic.js';
import { signedInServer, spans } from './test/fixtures.js';
import { bootHeadless, completeLoginRedirect, type Harness, settle, waitFor } from './test/harness.js';

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

async function openDoc(h: Harness, id = '1'): Promise<void> {
  const result = await h.router.navigate({ to: DocRoute, params: { id } });
  expect(result.outcome).toBe('committed');
  const doc = await h.get(DocumentStoreToken);
  await waitFor(() => doc.status === 'ready' && doc.docId === id, { message: `document ${id} ready` });
}

describe('boot', () => {
  it('reaches running with a boot waterfall span tree', async () => {
    harness = await bootHeadless({ url: '/' });
    const { supervisor } = harness.studio.app;
    expect(supervisor.state).toBe('running');
    expect(supervisor.impaired()).toEqual([]);
    const all = spans(harness.studio.perf.memory.records);
    const boot = all.find((s) => s.name === 'app.boot');
    expect(boot?.status).toBe('ok');
    const children = all.filter((s) => s.parentSpanId === boot?.context.spanId).map((s) => s.name);
    expect(children).toEqual(expect.arrayContaining(['boot.core', 'boot.critical']));
    const critical = all.find((s) => s.name === 'boot.critical');
    // Critical units (platform facts, app profile, flag resolver, …) resolve under boot.critical.
    expect(all.some((s) => s.parentSpanId === critical?.context.spanId)).toBe(true);
    // The first navigation joins the boot journey (perf journey tracker sink).
    await waitFor(() => harness!.router.current?.route.id === 'app/home', { message: 'home route' });
    expect(all.length).toBeGreaterThan(5);
  });
});

describe('auth boundary + deep-link intent', () => {
  it('lets guests open `/`, redirects /studio/doc/1 to login and completes after mock login with the intent preserved', async () => {
    harness = await bootHeadless({ url: '/' });
    expect(harness.session.state).toBe('guest');
    expect(harness.router.current?.route.id).toBe('app/home');

    const redirected = await harness.router.navigate({ href: '/studio/doc/1?panel=chat&prompt=Draft%20an%20intro' });
    expect(redirected.outcome).toBe('committed');
    expect(redirected.redirects).toEqual(['/studio/doc/1?panel=chat&prompt=Draft%20an%20intro']);
    expect(harness.router.current?.route).toBe(LoginRoute);
    // The intent params are stripped from returnTo and held through the redirect.
    expect(harness.env.history.url).toBe('/login?returnTo=%2Fstudio%2Fdoc%2F1');
    expect(harness.host.stateOf(Features.studioDesktop.id)).toBe('declared'); // denied chunk never loaded (I-8)

    const login = await harness.session.login({ returnTo: '/studio/doc/1', loginHint: 'ada' });
    expect(login.ok && login.value.kind).toBe('redirecting');
    expect(harness.env.navigations.at(-1)).toContain('/mock-bff/login?returnTo=%2Fstudio%2Fdoc%2F1');

    // BFF redirect back = full page load = a second boot against the same server + storage.
    harness = await completeLoginRedirect(harness);
    const { router, session, host } = harness;
    await waitFor(() => session.state === 'authenticated', { message: 'session restored' });
    await waitFor(() => router.current?.route === DocRoute, { message: 'doc route' });
    expect(router.current?.location.pathname).toBe('/studio/doc/1');
    await waitFor(() => host.stateOf(Features.studioDesktop.id) === 'mounted', { message: 'studio mounted' });
    const doc = await harness.get(DocumentStoreToken);
    await waitFor(() => doc.status === 'ready', { message: 'doc ready' });
    expect(doc.title).toBe('Welcome to Studio');
    expect(doc.blocks.length).toBe(3);

    // The held intent was restored, authorized after the pipeline and delivered (prefill only).
    const panel = await harness.get(PanelControllerToken);
    await waitFor(() => panel.open === 'agent/chat' && host.stateOf(Features.agentChat.id) === 'mounted', { message: 'chat panel' });
    const chat = await host.handle(Features.agentChat.id)!.injector!.get(ChatControllerToken);
    expect(chat.ok).toBe(true);
    if (!chat.ok) return;
    await waitFor(() => chat.value.store.state.draft === 'Draft an intro', { message: 'prefilled draft' });
    expect(chat.value.store.state.messages).toEqual([]); // never auto-sent (I-13)
    const intents = (await harness.get(IntentServiceToken)).inspect();
    expect(intents.find((i) => i.id === 'agent/chat-prompt')?.state).toBe('delivered');
  });
});

describe('gating + capabilities', () => {
  it('shows the upgrade dialog when a free user invokes a pro capability', async () => {
    harness = await bootHeadless({ url: '/', server: signedInServer('ada') });
    await waitFor(() => harness!.session.isAuthenticated, { message: 'signed in' });
    await openDoc(harness);
    const gate = await harness.get(GateToken);
    expect(gate.fact(GateFacts.plan)).toBe('free');

    const invoker = await harness.get(CapabilityInvokerToken);
    const result = await invoker.invoke(SummarizeCapability, {});
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.details['reason']).toBe('upgrade');

    await waitFor(() => harness!.router.openDialog === UpgradeDialog, { message: 'routable upgrade dialog' });
    expect(harness.env.history.url).toBe('/studio/doc/1/d/upgrade');
    const surfaces = await harness.get(SurfaceManagerToken);
    await waitFor(() => surfaces.topModal?.def.id === 'billing/upgrade-dialog', { message: 'upgrade surface showing' });
    expect(harness.host.stateOf(Features.billing.id)).toBe('activated'); // dialog content chunk loaded after authorize
  });

  it('agent tool calls run as the agent subject and reserve → commit credits', async () => {
    harness = await bootHeadless({ url: '/', server: signedInServer('ada') });
    const server = harness.env.server;
    await waitFor(() => harness!.session.isAuthenticated, { message: 'signed in' });
    await openDoc(harness);
    const meters = await harness.get(MeterRegistryToken);
    const credits = meters.get(CreditsMeter);
    expect(credits.ok).toBe(true);
    if (!credits.ok) return;
    await waitFor(() => credits.value.available === 10, { message: 'credits synced from billing' });

    const panel = await harness.get(PanelControllerToken);
    expect(await panel.show('agent/chat')).toEqual(ok());
    const chat = await harness.host.handle(Features.agentChat.id)!.injector!.get(ChatControllerToken);
    if (!chat.ok) throw chat.error;
    const sent = await chat.value.send('Please add an image of the architecture');
    expect(sent).toEqual(ok());

    const messages = chat.value.store.state.messages;
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(messages[1]?.text).toContain('You asked');
    expect(messages[2]).toMatchObject({ role: 'tool', ok: true });

    const reservations = Object.values(server.state.reservations);
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({ userId: 'ada', amount: 2, state: 'committed' });
    expect(server.state.users['ada']?.credits).toBe(8);
    await waitFor(() => credits.value.available === 8 && credits.value.held === 0, { message: 'meter settled' });

    const doc = await harness.get(DocumentStoreToken);
    await waitFor(() => doc.blocks.some((b) => b.kind === 'image' && b.src.includes('picsum')), { message: 'image block inserted' });
    const invocation = spans(harness.studio.perf.memory.records).find((s) => s.name === 'capability.invoke' && s.attrs['capability'] === 'agent/insert-image');
    expect(invocation?.attrs['subject']).toBe('agent');
  });
});

describe('routing', () => {
  it('a view-state tab change runs the light pipeline and does not reactivate the feature', async () => {
    harness = await bootHeadless({ url: '/', server: signedInServer('ada') });
    await waitFor(() => harness!.session.isAuthenticated, { message: 'signed in' });
    await openDoc(harness);
    const transitions: string[] = [];
    harness.host.onTransition((t) => transitions.push(`${t.id}:${t.to}`));

    const result = await harness.router.navigate({ to: DocRoute, params: { id: '1' }, search: { tab: 'comments' } });
    expect(result.outcome).toBe('committed');
    expect(result.kind).toBe('view');
    const doc = await harness.get(DocumentStoreToken);
    await waitFor(() => doc.tab.get() === 'comments', { message: 'tab bound from URL' });
    expect(transitions.filter((t) => t.startsWith(Features.studioDesktop.id))).toEqual([]);

    // Store → URL (urlstate sync, one history write per frame; no router pipeline).
    doc.tab.set('history');
    await waitFor(() => harness!.env.history.url === '/studio/doc/1?tab=history', { message: 'URL follows the store' });
    expect(transitions).toEqual([]);
  });

  it('picks the per-mode variant: compact form factor mounts studio-mobile over the same document store', async () => {
    harness = await bootHeadless({ url: '/', server: signedInServer('ada'), width: 390 });
    await waitFor(() => harness!.session.isAuthenticated, { message: 'signed in' });
    await openDoc(harness, '2');
    await waitFor(() => harness!.host.stateOf(Features.studioMobile.id) === 'mounted', { message: 'mobile editor mounted' });
    expect(harness.host.stateOf(Features.studioDesktop.id)).toBe('declared');
    expect((await harness.get(DocumentStoreToken)).title).toBe('Document 2');
  });

  it('the exit guard waits for the pending save before leaving the editor', async () => {
    harness = await bootHeadless({ url: '/', server: signedInServer('ada') });
    await waitFor(() => harness!.session.isAuthenticated, { message: 'signed in' });
    await openDoc(harness);
    const doc = await harness.get(DocumentStoreToken);
    doc.rename('Renamed while leaving');
    expect(doc.pendingSave).toBe(true);
    const left = await harness.router.navigate({ href: '/' });
    expect(left.outcome).toBe('committed');
    expect(harness.env.server.state.docs['1']?.title).toBe('Renamed while leaving');
    expect(doc.pendingSave).toBe(false);
  });
});

describe('session lifecycle', () => {
  it('logout disposes the session scope', async () => {
    harness = await bootHeadless({ url: '/', server: signedInServer('ada') });
    await waitFor(() => harness!.session.isAuthenticated, { message: 'signed in' });
    const scopes = await harness.get(SessionScopeToken);
    await scopes.settled();
    const userInjector = scopes.injector;
    expect(scopes.key).toBe('user:ada');
    expect(userInjector?.scope.disposed).toBe(false);

    await harness.session.logout();
    await scopes.settled();
    expect(harness.session.state).toBe('guest');
    expect(userInjector?.scope.disposed).toBe(true);
    expect(scopes.key?.startsWith('guest:')).toBe(true);
    expect(harness.env.server.sessionUser).toBeUndefined();
  });

  it('an epoch refresh after a token change refetches active resources', async () => {
    harness = await bootHeadless({ url: '/', server: signedInServer('ada') });
    await waitFor(() => harness!.session.isAuthenticated, { message: 'signed in' });
    const home = await harness.get(HomeDocsToken);
    await waitFor(() => (home.list?.items.length ?? 0) > 0, { message: 'docs list loaded' });
    const transport = (await harness.get(DataTransportToken)) as MockTransport;
    const before = transport.callsTo(DocsListEndpoint).length;
    const epoch = harness.studio.app.supervisor.epoch;

    // The BFF rotates the session token with new claims (plan upgrade); the app refreshes its epoch.
    harness.env.server.upgrade('ada', 'pro');
    expect(await harness.session.refresh()).toEqual(ok());
    await waitFor(() => harness!.studio.app.supervisor.epoch > epoch, { message: 'epoch bumped' });
    await waitFor(() => transport.callsTo(DocsListEndpoint).length > before, { message: 'docs.list refetched' });
    const latest = transport.callsTo(DocsListEndpoint).at(-1);
    expect(latest?.epoch).toBe(harness.studio.app.supervisor.epoch);
    const gate = await harness.get(GateToken);
    await waitFor(() => gate.fact(GateFacts.plan) === 'pro', { message: 'plan fact follows the claims' });
  });
});

describe('ui', () => {
  it('the shell re-renders on workspace switches (regression: MobxController lost tracking)', async () => {
    harness = await bootHeadless({ url: '/', server: signedInServer('ada'), render: true });
    await waitFor(() => harness!.session.isAuthenticated, { message: 'signed in' });
    const shell = harness.root?.querySelector('sf-shell');
    expect(shell).not.toBeNull();
    const hasInspector = (): boolean => shell?.shadowRoot?.querySelector('studio-inspector') != null;
    await waitFor(() => shell?.shadowRoot?.querySelector('studio-header') != null, { message: 'shell rendered' });
    expect(hasInspector()).toBe(false);
    const workspaces = await harness.get(WorkspaceManagerToken);
    expect((await workspaces.switchTo(ExpertWorkspace.id)).ok).toBe(true);
    await waitFor(hasInspector, { message: 'inspector slot after switching to expert' });
    expect((await workspaces.switchTo(defaultWorkspace.id)).ok).toBe(true);
    await waitFor(() => !hasInspector(), { message: 'inspector gone after switching back' });
  });
});

describe('conformance', () => {
  it('records zero violations in the happy path', async () => {
    harness = await bootHeadless({ url: '/', server: signedInServer('grace'), render: true });
    await waitFor(() => harness!.session.isAuthenticated, { message: 'signed in' });
    await openDoc(harness);
    await harness.router.navigate({ to: DocRoute, params: { id: '1' }, search: { tab: 'comments' } });
    await harness.router.navigate({ href: '/onboarding/step/1' });
    await harness.router.navigate({ href: '/onboarding/step/2' });
    await harness.router.navigate({ href: '/settings' });
    await harness.router.navigate({ href: '/' });
    await settle(20);
    expect(harness.studio.app.supervisor.state).toBe('running');
    expect(harness.studio.perf.violations.violations).toEqual([]);
    expect(harness.studio.perf.journeys.history.length).toBeGreaterThan(0);
  });
});
