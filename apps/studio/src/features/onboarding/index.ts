/**
 * Feature `onboarding/wizard` (chunk `feature:onboarding`, cheap): steps are view
 * sub-routes (`/onboarding/step/:n`, light pipeline), progress persists in the
 * `onboarding/progress` user-data slice, step 2 shows a coach mark on the AI button.
 * Copy comes from `OnboardingCopyToken` — an experiment variant binding (R8.4).
 */
import { ok, token, unit, watch } from '@staticflux/core';
import { type SliceHandle, UserDataToken } from '@staticflux/data';
import { ownerOf, SurfaceManagerToken } from '@staticflux/messaging';
import { isMatchOf, RouterToken } from '@staticflux/router';
import { defineButton } from '@staticflux/kit/button';
import { defineFeatureModule } from '@staticflux/runtime';
import { component, type ComponentHooksOf, defineComponent, SfElement } from '@staticflux/ui';
import { themeTokens as t } from '@staticflux/ui/theme';
import { css, html, type TemplateResult } from 'lit';
import { ReadinessToken } from '../../adapters/perf-runtime.js';
import { Features, OnboardingCopyToken, OnboardingProgressSlice } from '../../app/contracts.js';
import { OnboardingStepRoute } from '../../app/routes.js';
import { AiButtonCoachMark } from '../../app/surfaces.js';
import { mountFeatureRoot } from '../../ui/feature-root.js';

interface Progress {
  readonly step: number;
  readonly done: boolean;
}
const ProgressToken = /* @__PURE__ */ token('onboarding/progress').type<SliceHandle<Progress>>();

const progressUnit = unit({
  id: 'onboarding/progress-unit',
  provides: ProgressToken,
  scope: 'feature',
  deps: { required: { userData: UserDataToken } },
  create: ({ userData }) => userData.slice(OnboardingProgressSlice),
  init: async (slice, ctx) => {
    await slice.whenReady(ctx.signal);
    return ok();
  },
});

const STEPS = ['Name your first document', 'Meet the assistant', 'Pick a theme'] as const;

const wizardSpec = component({
  tag: 'onboarding-wizard',
  deps: { render: { copy: OnboardingCopyToken, router: RouterToken, progress: ProgressToken, readiness: ReadinessToken } },
  size: { block: '200px' },
});

class OnboardingWizard extends SfElement<typeof wizardSpec> {
  static override readonly spec = wizardSpec;
  static override styles = css`
    :host { display: grid; gap: ${t.space.md.css}; }
    ol { display: flex; gap: ${t.space.sm.css}; padding: 0; list-style: none; color: ${t.color.textMuted.css}; }
    [aria-current='step'] { font-weight: ${t.font.weightSemibold.css}; color: ${t.color.text.css}; }
    .nav { display: flex; gap: ${t.space.sm.css}; }
    small { color: ${t.color.textMuted.css}; }
  `;

  protected override wireDeps(on: ComponentHooksOf<typeof wizardSpec>): void {
    on.onReady('readiness', (readiness) => readiness.rendered(Features.onboarding.id, this));
  }

  override render(): TemplateResult {
    const { copy, router, progress } = this.deps;
    const match = router.current;
    const step = isMatchOf(match, OnboardingStepRoute) ? Math.min(STEPS.length, Math.max(1, Number(match.params.n) || 1)) : progress.value.step;
    const to = (n: number): void => void router.navigate({ to: OnboardingStepRoute, params: { n: String(n) } });
    return html`
      <h1 data-variant=${copy.variant}>${copy.headline}</h1>
      <ol aria-label="Steps">${STEPS.map((label, i) => html`<li aria-current=${i + 1 === step ? 'step' : 'false'}>${i + 1}. ${label}</li>`)}</ol>
      <p>${STEPS[step - 1]}</p>
      <div class="nav">
        <sf-button ?disabled=${step <= 1} @click=${() => to(step - 1)}>Back</sf-button>
        ${step < STEPS.length
          ? html`<sf-button variant="primary" @click=${() => to(step + 1)}>Next</sf-button>`
          : html`<sf-button variant="primary" @click=${() => void router.navigate({ href: '/' })}>Finish</sf-button>`}
      </div>
      <small>${progress.value.done ? 'Completed' : `Saved at step ${progress.value.step}`}</small>
    `;
  }
}

export default defineFeatureModule({
  units: [progressUnit],
  async activate(context) {
    const [router, progress, surfaces] = await Promise.all([
      context.injector.get(RouterToken),
      context.injector.get(ProgressToken),
      context.injector.get(SurfaceManagerToken),
    ]);
    if (!router.ok) return router;
    if (!progress.ok) return progress;
    watch(
      () => {
        const match = router.value.current;
        return isMatchOf(match, OnboardingStepRoute) ? Number(match.params.n) || 1 : undefined;
      },
      (step) => {
        if (step === undefined) return;
        progress.value.set((previous) => ({ step, done: previous.done || step >= STEPS.length }));
        if (step === 2 && surfaces.ok) surfaces.value.request(AiButtonCoachMark, { owner: ownerOf(context.injector) });
      },
      { scope: context.scope, fireImmediately: true },
    );
    return ok();
  },
  async mount(context) {
    defineButton();
    if (customElements.get(wizardSpec.tag) === undefined) defineComponent(OnboardingWizard);
    await mountFeatureRoot(context, () => html`<onboarding-wizard></onboarding-wizard>`);
    return ok();
  },
});
