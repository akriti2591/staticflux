/**
 * App-level views (not features): header, main region (home / login / not found +
 * the feature outlet), assistant panel and inspector regions. They self-inject their
 * dependencies (render deps block on a placeholder; lazy deps arrive reactively).
 */
import { SessionToken } from '@staticflux/auth';
import { I18nToken } from '@staticflux/i18n';
import { MeterRegistryToken } from '@staticflux/gate';
import { coachTarget } from '@staticflux/messaging';
import { isMatchOf, RouterToken } from '@staticflux/router';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, type TemplateResult } from 'lit';
import { GuestDraftToken } from '../adapters/handoff-auth.js';
import { AiButtonTarget, CreditsMeter, OutletsToken, PanelControllerToken } from '../app/contracts.js';
import { HomeDocsToken } from '../app/home.js';
import { appMessages } from '../app/messages.js';
import { DocRoute, HomeRoute, LoginRoute, NotFoundRoute, OnboardingRoute, SettingsRoute } from '../app/routes.js';

const linkStyles = css`
  a { color: inherit; }
  button { font: inherit; cursor: pointer; border-radius: var(--sf-radius-small, 4px); border: 1px solid var(--sf-color-border, #ccc); background: var(--sf-color-surface, #fff); color: inherit; padding: 4px 10px; }
  button.primary { background: var(--sf-color-accent, #4f46e5); color: var(--sf-color-accent-fg, #fff); border-color: transparent; }
`;

/** Navigate through the router (typed targets or hrefs); never a full page load. */
function go(host: HTMLElement, href: string): (event: Event) => void {
  return (event) => {
    event.preventDefault();
    host.dispatchEvent(new CustomEvent('studio-navigate', { detail: href, bubbles: true, composed: true }));
  };
}

// ------------------------------------------------------------------ header

const headerSpec = component({
  tag: 'studio-header',
  deps: {
    render: { session: SessionToken, i18n: I18nToken, panel: PanelControllerToken },
    lazy: { meters: MeterRegistryToken },
  },
  size: { block: '48px' },
});

export class StudioHeader extends SfElement<typeof headerSpec> {
  static override readonly spec = headerSpec;
  static override styles = [linkStyles, css`:host { display: flex; gap: 12px; align-items: center; padding: 8px 16px; } nav { display: flex; gap: 12px; flex: 1; } .credits { opacity: 0.8; }`];

  override render(): TemplateResult {
    const { session, i18n, panel, meters } = this.deps;
    const credits = meters.value?.get(CreditsMeter);
    const available = credits?.ok === true ? credits.value.available : undefined;
    return html`
      <strong>${i18n.t(appMessages.title)}</strong>
      <nav aria-label="Primary">
        <a href="/" @click=${go(this, '/')}>${i18n.t(appMessages.home)}</a>
        <a href="/onboarding/step/1" @click=${go(this, '/onboarding/step/1')}>${i18n.t(appMessages.startTour)}</a>
        <a href="/settings" @click=${go(this, '/settings')}>${i18n.t(appMessages.settings)}</a>
      </nav>
      ${available === undefined ? '' : html`<span class="credits" data-testid="credits">${i18n.t(appMessages.credits, { count: available })}</span>`}
      <button ${coachTarget(AiButtonTarget)} data-testid="open-chat" aria-pressed=${panel.open === 'agent/chat' ? 'true' : 'false'} @click=${() => void (panel.open === undefined ? panel.show('agent/chat') : panel.hide())}>
        ${i18n.t(appMessages.openChat)}
      </button>
      ${session.isAuthenticated
        ? html`<span>${session.principal?.displayName ?? session.principal?.id}</span><button @click=${() => void session.logout()}>${i18n.t(appMessages.signOut)}</button>`
        : html`<a href="/login" @click=${go(this, '/login')}>${i18n.t(appMessages.signIn)}</a>`}
    `;
  }
}

// ------------------------------------------------------------------ main region

const mainSpec = component({
  tag: 'studio-main',
  deps: {
    render: { router: RouterToken, session: SessionToken, i18n: I18nToken, outlets: OutletsToken, home: HomeDocsToken, draft: GuestDraftToken },
  },
});

export class StudioMain extends SfElement<typeof mainSpec> {
  static override readonly spec = mainSpec;
  static override styles = [linkStyles, css`:host { display: block; padding: 16px; } ul { padding-inline-start: 18px; } .login { display: flex; gap: 8px; }`];

  override render(): TemplateResult {
    const { router, outlets } = this.deps;
    const match = router.current;
    return html`${this.renderAppView(match?.route)}${outlets.main}`;
  }

  private renderAppView(route: unknown): TemplateResult | string {
    const { router, session, i18n, home, draft } = this.deps;
    const match = router.current;
    if (route === HomeRoute) {
      if (!session.isAuthenticated) {
        return html`<h1>${i18n.t(appMessages.welcome)}</h1>
          <p>${i18n.t(appMessages.guestIntro)}</p>
          <label>Draft title <input .value=${draft.get()} @input=${(e: Event) => draft.set((e.target as HTMLInputElement).value)} /></label>
          <p><a href="/onboarding/step/1" @click=${go(this, '/onboarding/step/1')}>${i18n.t(appMessages.startTour)}</a></p>`;
      }
      const list = home.list;
      return html`<h1>${i18n.t(appMessages.home)}</h1>
        <ul data-testid="doc-list">
          ${(list?.items ?? []).map((doc) => html`<li><a href=${`/studio/doc/${doc.id}`} @click=${go(this, `/studio/doc/${doc.id}`)}>${doc.title}</a></li>`)}
        </ul>
        ${list?.hasMore === true ? html`<button @click=${() => void list.fetchNext()}>${i18n.t(appMessages.loadMore)}</button>` : ''}`;
    }
    if (route === LoginRoute && isMatchOf(match, LoginRoute)) {
      const returnTo = match.search.returnTo;
      return html`<h1>${i18n.t(appMessages.signIn)}</h1>
        <div class="login">
          ${(['ada', 'grace'] as const).map(
            (id) => html`<button class="primary" data-testid=${`login-${id}`} @click=${() => void session.login({ returnTo, loginHint: id })}>
              ${i18n.t(appMessages.signInAs, { name: id === 'ada' ? 'Ada (free)' : 'Grace (pro)' })}
            </button>`,
          )}
        </div>`;
    }
    if (route === NotFoundRoute || match?.notFound === true) return html`<h1>${i18n.t(appMessages.notFound)}</h1>`;
    if (route === DocRoute || route === OnboardingRoute || route === SettingsRoute) return '';
    return '';
  }
}

// ------------------------------------------------------------------ panel / inspector regions

const panelSpec = component({ tag: 'studio-panel', deps: { render: { outlets: OutletsToken, panel: PanelControllerToken } } });

export class StudioPanel extends SfElement<typeof panelSpec> {
  static override readonly spec = panelSpec;
  static override styles = css`:host { display: block; } :host([hidden]) { display: none; }`;
  override render(): TemplateResult {
    const { outlets, panel } = this.deps;
    this.toggleAttribute('hidden', panel.open === undefined);
    return html`${outlets.panel}`;
  }
}

const inspectorSpec = component({ tag: 'studio-inspector', deps: { render: { outlets: OutletsToken, router: RouterToken } } });

export class StudioInspector extends SfElement<typeof inspectorSpec> {
  static override readonly spec = inspectorSpec;
  override render(): TemplateResult {
    const { outlets, router } = this.deps;
    return html`<h2>Inspector</h2><p>Route: ${router.current?.route.id ?? '—'} · stage: ${router.stage ?? 'idle'}</p>${outlets.inspector}`;
  }
}

export function defineAppViews(): void {
  for (const element of [StudioHeader, StudioMain, StudioPanel, StudioInspector]) {
    const defined = defineComponent(element);
    if (!defined.ok) throw defined.error;
  }
}
