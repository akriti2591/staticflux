/**
 * Adapter: @staticflux/perf feature marks ⇄ @staticflux/runtime feature host (R17.7, R17.20).
 *
 * - Every mount starts a perf mark session for the feature (with its declared
 *   readiness ownership, same `firstRender | interactive | complete` keys in both
 *   packages); firstRender is measured by the framework.
 * - Features report the marks they own through `ReadinessToken`, which records them
 *   on both sides: the runtime readiness metric and the perf journey marks.
 */
import { contribution, token, unit } from '@staticflux/core';
import { FeatureMarksToken } from '@staticflux/perf';
import { defineSubsystem, FeatureHostToken, type FeatureId, type ReadinessMark, SubsystemsToken } from '@staticflux/runtime';

export interface Readiness {
  report(feature: FeatureId, mark: ReadinessMark): void;
  /** A content render committed (framework-measured firstRender). */
  rendered(feature: FeatureId, element?: Element): void;
}
export const ReadinessToken = token('studio/readiness').type<Readiness>();

export const readinessUnit = unit({
  id: 'studio/readiness-unit',
  provides: ReadinessToken,
  scope: 'app',
  deps: { required: { host: FeatureHostToken, marks: FeatureMarksToken } },
  create: ({ host, marks }): Readiness => ({
    report(feature, mark) {
      host.mark(feature, mark);
      marks.signal(feature, mark);
    },
    rendered(feature, element) {
      marks.renderCommitted(feature, element);
      host.mark(feature, 'firstRender');
    },
  }),
});

export const featureMarksSubsystemUnit = contribution({
  id: 'studio/feature-marks-subsystem-unit',
  provides: SubsystemsToken,
  scope: 'app',
  deps: { required: { host: FeatureHostToken, marks: FeatureMarksToken } },
  create: ({ host, marks }) =>
    defineSubsystem({
      id: 'perf/feature-marks',
      start: (ctx) => {
        for (const info of host.list()) {
          const readiness = host.handle(info.id)?.manifest.readiness;
          if (readiness !== undefined) marks.declare(info.id, readiness);
        }
        ctx.scope.defer(
          host.onTransition((t) => {
            if (t.to === 'mounting') marks.start(t.id);
          }),
        );
      },
      description: 'Feature mounts open perf mark sessions.',
    }),
});
