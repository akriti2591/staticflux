/**
 * Adapter: @staticflux/platform app profile → @staticflux/router (R18.4–R18.6).
 * The availability stage picks the feature variant serving `[hostMode, formFactor]`
 * (studio-desktop on expanded/medium, studio-mobile on compact); a profile change
 * re-runs the pipeline so the variant swaps (`router.refresh()`).
 */
import { contribution, unit } from '@staticflux/core';
import { AppProfileToken } from '@staticflux/platform';
import { modesPredicate, RouterToken, RouteProfileToken } from '@staticflux/router';
import { defineSubsystem, SubsystemsToken } from '@staticflux/runtime';

export const profilePredicateUnit = unit({
  id: 'studio/profile-predicate-unit',
  provides: RouteProfileToken,
  scope: 'app',
  deps: { required: { profile: AppProfileToken } },
  create: ({ profile }) => modesPredicate(() => [profile.current.hostMode, profile.current.formFactor]),
  description: 'Per-mode feature variants by host mode × form factor.',
});

export const profileRefreshSubsystemUnit = contribution({
  id: 'studio/profile-refresh-subsystem-unit',
  provides: SubsystemsToken,
  scope: 'app',
  deps: { required: { profile: AppProfileToken, router: RouterToken } },
  create: ({ profile, router }) =>
    defineSubsystem({
      id: 'studio/profile-refresh',
      dependsOn: ['router/navigation'],
      start: (ctx) => {
        ctx.scope.defer(
          profile.onChange((next, previous) => {
            if (next.formFactor !== previous.formFactor || next.hostMode !== previous.hostMode) void router.refresh();
          }),
        );
      },
      description: 'Mode change → variant swap (R18.6).',
    }),
});
