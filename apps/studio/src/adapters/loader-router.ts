/**
 * Adapter: @staticflux/router navigations → @staticflux/loader warmup (R12.3, R19.5).
 * After each committed navigation the Markov model observes the feature chunk the
 * user is on, and the `likely` tier warms in idle time in advisor-ranked order
 * (never on the navigation critical path).
 */
import { token, unit } from '@staticflux/core';
import { WarmupToken } from '@staticflux/loader';
import { RouterToken } from '@staticflux/router';
import { defineSubsystem, type Subsystem } from '@staticflux/runtime';
import { featureChunks } from '../app/features.js';
import { ChunkCursorToken, NextChunkModelToken, NO_FEATURE } from './advisors-loader.js';

/** Registered late (post-boot) with the supervisor; warmup is never on the boot path. */
export const NavigationWarmupToken = /* @__PURE__ */ token('studio/navigation-warmup').type<Subsystem>();

export const navigationWarmupSubsystemUnit = unit({
  id: 'studio/navigation-warmup-subsystem-unit',
  provides: NavigationWarmupToken,
  scope: 'app',
  deps: { required: { router: RouterToken, warmup: WarmupToken, cursor: ChunkCursorToken, model: NextChunkModelToken } },
  create: ({ router, warmup, cursor, model }) =>
    defineSubsystem({
      id: 'loader/navigation-warmup',
      dependsOn: ['router/navigation'],
      start: (ctx) => {
        ctx.scope.defer(
          router.onNavigation((result) => {
            if (result.outcome !== 'committed' || result.kind === 'view') return;
            const [feature] = router.mountedFeatures;
            const next = feature === undefined ? NO_FEATURE : (featureChunks[feature] ?? NO_FEATURE);
            if (next !== cursor.current) model.observe(next);
            cursor.current = next;
            void warmup.warmLikely(undefined, ctx.signal);
          }),
        );
      },
      description: 'Learn feature transitions; warm likely chunks after navigation.',
    }),
});
