/**
 * Typed routes and routable dialogs (R7.5, R7.9, R7.16). Routes bind capabilities,
 * never hardcoded features: the availability stage picks the per-mode variant
 * (studio-desktop vs studio-mobile, R18.5).
 */
import { bindCapability, defineDialog, defineRoute, searchParam } from '@staticflux/router';
import { Features } from './contracts.js';
import { GateIds } from './policies.js';

export const HomeRoute = defineRoute({ id: 'app/home', path: '/', description: 'Document list (users) or welcome (guests).' });

export const LoginRoute = defineRoute({
  id: 'app/login',
  path: '/login',
  search: { returnTo: searchParam.string({ default: '/' }) },
  description: 'Mock sign-in page; starts the BFF login redirect.',
});

export const StudioRoute = defineRoute({
  id: 'studio/root',
  path: '/studio',
  abstract: true,
  requires: { auth: 'required', gate: { level: 'route', id: GateIds.studioRoute } },
});

export const DocRoute = defineRoute({
  id: 'studio/doc',
  parent: StudioRoute,
  path: 'doc/:id',
  search: { tab: searchParam.enum(['content', 'comments', 'history'], { default: 'content', kind: 'view' }) },
  feature: bindCapability('studio/editor', [
    { feature: Features.studioDesktop, modes: ['expanded', 'medium'] },
    { feature: Features.studioMobile, modes: ['compact'] },
  ]),
  description: 'The editor; `tab` is view state (light pipeline, no reactivation).',
});

export const OnboardingRoute = defineRoute({
  id: 'onboarding/root',
  path: '/onboarding',
  feature: bindCapability('onboarding/wizard', [{ feature: Features.onboarding }]),
});

export const OnboardingStepRoute = defineRoute({
  id: 'onboarding/step',
  parent: OnboardingRoute,
  path: 'step/:n',
  view: true,
  description: 'Wizard steps are view sub-routes of the onboarding feature.',
});

export const SettingsRoute = defineRoute({
  id: 'settings/root',
  path: '/settings',
  feature: bindCapability('settings/panel', [{ feature: Features.settings }]),
});

export const NotFoundRoute = defineRoute({ id: 'app/not-found', path: '/404' });

export const UpgradeDialog = defineDialog({ id: 'billing/upgrade', key: 'upgrade', description: 'Upsell (app-level, routable).' });

export const ShareDialogRoute = defineDialog({
  id: 'studio/share',
  key: 'share',
  owner: DocRoute,
  requires: { auth: 'required' },
  description: 'Share dialog of the open document.',
});

export const studioRoutes = [HomeRoute, LoginRoute, StudioRoute, DocRoute, OnboardingRoute, OnboardingStepRoute, SettingsRoute, NotFoundRoute] as const;
export const studioDialogs = [UpgradeDialog, ShareDialogRoute] as const;
