/**
 * Adapter: @staticflux/gate → @staticflux/router `authorize` stage (R6.10, R7.8).
 * Routes declare `requires.gate`; the decision is a synchronous table lookup.
 * `login` denials redirect to sign-in, `upgrade` denials open the routable upsell
 * dialog; anything else blocks with the typed SF-GATE error. UX, not security.
 */
import { contribution } from '@staticflux/core';
import { denialError, GateToken } from '@staticflux/gate';
import { block, proceed, redirect, stagePlugin, StagePluginsToken } from '@staticflux/router';
import { HomeRoute, LoginRoute, UpgradeDialog } from '../app/routes.js';

export const gateAuthorizePluginUnit = contribution({
  id: 'studio/gate-authorize-plugin-unit',
  provides: StagePluginsToken,
  scope: 'app',
  deps: { required: { gate: GateToken } },
  create: ({ gate }) =>
    stagePlugin({
      id: 'studio/gate-authorize',
      stage: 'authorize',
      pipelines: ['full', 'dialog'],
      applies: (context) => context.requires.gate !== undefined,
      run: (context) => {
        const requirement = context.requires.gate;
        if (requirement === undefined) return proceed();
        const decision = gate.decide(requirement.level, requirement.id);
        context.span.set('gate.effect', decision.effect);
        if (decision.effect === 'allow') return proceed();
        if (decision.reason === 'login') return redirect({ to: LoginRoute, search: { returnTo: context.intent.href } }, { reason: 'gate-login' });
        if (decision.reason === 'upgrade') return redirect({ to: HomeRoute, dialog: UpgradeDialog }, { reason: 'gate-upgrade' });
        return block(denialError(decision));
      },
      description: 'Route/feature gate decisions in the authorize stage.',
    }),
});
