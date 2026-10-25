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
import { themeTokens as t } from '@staticflux/ui/theme';
import { css, html, type TemplateResult } from 'lit';
import { GuestDraftToken } from '../adapters/handoff-auth.js';
import { AiButtonTarget, CreditsMeter, OutletsToken, PanelControllerToken } from '../app/contracts.js';
import { HomeDocsToken } from '../app/home.js';
import { appMessages } from '../app/messages.js';
import { DocRoute, HomeRoute, LoginRoute, NotFoundRoute, OnboardingRoute, SettingsRoute } from '../app/routes.js';

/**
 * Controls are kit components (`sf-button`, `sf-text-field`, loaded right after boot by
 * `defineAppViews`); views only lay out and color links. Until the kit chunk defines them,
 * controls keep their size and look (no layout shift).
 */
const linkStyles = css`
  a { color: ${t.color.accentText.css}; text-underline-offset: 2px; }
  a:focus-visible { outline: 2px solid ${t.color.focusRing.css}; outline-offset: 2px; border-radius: ${t.radius.sm.css}; }
  sf-button:not(:defined) { display: inline-flex; align-items: center; box-sizing: border-box; min-block-size: ${t.size.control.css}; padding-inline: ${t.space.md.css}; border: 1px solid ${t.color.controlEdge.css}; border-radius: ${t.radius.control.css}; font-weight: ${t.font.weightMedium.css}; }
  sf-text-field:not(:defined) { display: inline-block; min-block-size: calc(${t.size.control.css} + 20px); }
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
  static override styles = [
    linkStyles,
    css`
      :host { display: flex; gap: ${t.space.md.css}; align-items: center; min-block-size: ${t.size.toolbar.css}; padding-inline: ${t.space.lg.css}; background: ${t.color.surface1.css}; border-block-end: 1px solid ${t.color.border.css}; }
      nav { display: flex; gap: ${t.space.md.css}; flex: 1; }
      .credits { color: ${t.color.textMuted.css}; font-size: ${t.type.sizeSm.css}; }
    `,
  ];

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
      <sf-button ${coachTarget(AiButtonTarget)} data-testid="open-chat" .pressed=${panel.open === 'agent/chat'} @click=${() => void (panel.open === undefined ? panel.show('agent/chat') : panel.hide())}>
        ${i18n.t(appMessages.openChat)}
      </sf-button>
      ${session.isAuthenticated
        ? html`<span>${session.principal?.displayName ?? session.principal?.id}</span><sf-button variant="ghost" @click=${() => void session.logout()}>${i18n.t(appMessages.signOut)}</sf-button>`
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
  static override styles = [
    linkStyles,
    css`
      :host { display: block; padding: ${t.space.lg.css}; }
      ul { padding-inline-start: ${t.space.lg.css}; }
      .login { display: flex; gap: ${t.space.sm.css}; }
      sf-text-field { min-inline-size: 24ch; }
      /* The feature outlet takes route-change focus (tabindex -1, a11y router adapter): no ring on a whole region. */
      .outlet:focus { outline: none; }
    `,
  ];

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
          <sf-text-field label="Draft title" .value=${draft.get()} @input=${(e: Event) => draft.set((e.target as HTMLInputElement).value)}></sf-text-field>
          <p><a href="/onboarding/step/1" @click=${go(this, '/onboarding/step/1')}>${i18n.t(appMessages.startTour)}</a></p>`;
      }
      const list = home.list;
      return html`<h1>${i18n.t(appMessages.home)}</h1>
        <ul data-testid="doc-list">
          ${(list?.items ?? []).map((doc) => html`<li><a href=${`/studio/doc/${doc.id}`} @click=${go(this, `/studio/doc/${doc.id}`)}>${doc.title}</a></li>`)}
        </ul>
        ${list?.hasMore === true ? html`<sf-button @click=${() => void list.fetchNext()}>${i18n.t(appMessages.loadMore)}</sf-button>` : ''}`;
    }
    if (route === LoginRoute && isMatchOf(match, LoginRoute)) {
      const returnTo = match.search.returnTo;
      return html`<h1>${i18n.t(appMessages.signIn)}</h1>
        <div class="login">
          ${(['ada', 'grace'] as const).map(
            (id) => html`<sf-button variant="primary" data-testid=${`login-${id}`} @click=${() => void session.login({ returnTo, loginHint: id })}>
              ${i18n.t(appMessages.signInAs, { name: id === 'ada' ? 'Ada (free)' : 'Grace (pro)' })}
            </sf-button>`,
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
  // Kit controls load right after boot (their own chunk, shared with features) and upgrade in place.
  void import('./controls.js').then((controls) => controls.defineAppControls());
  for (const element of [StudioHeader, StudioMain, StudioPanel, StudioInspector]) {
    const defined = defineComponent(element);
    if (!defined.ok) throw defined.error;
  }
}
