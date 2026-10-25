/**
 * Post-boot work, off the critical path (R12.1 tiers: visible → idle): load the late
 * units chunk (AI, WebMCP, warmup/advisors) and the deferred surfaces chunk, publish capabilities as WebMCP tools,
 * start the model router's background probe, restore the theme preference, and
 * activate billing logic once a user is signed in (credit banner).
 */
import { contribution, err, ok, type Result, toSfError, unit, watch } from '@staticflux/core';
import { SessionToken } from '@staticflux/auth';
import { SurfaceManagerToken } from '@staticflux/messaging';
import { AppInjectorToken, defineSubsystem, FeatureHostToken, FrameSchedulerToken, SubsystemsToken, SupervisorToken } from '@staticflux/runtime';
import { AppearanceToken } from '@staticflux/ui/theme';
import { Features, type LateServices, LateServicesToken } from './contracts.js';


export const lateServicesUnit = unit({
  id: 'studio/late-services-unit',
  provides: LateServicesToken,
  scope: 'app',
  deps: { required: { injector: AppInjectorToken, frames: FrameSchedulerToken, supervisor: SupervisorToken } },
  create: ({ injector, frames, supervisor }, ctx): LateServices => {
    const ready = frames
      .postTask(
        async (signal): Promise<Result<void>> => {
          let late: typeof import('./late.js');
          try {
            late = await import('./late.js');
          } catch (error) {
            return err(toSfError(error));
          }
          const registered = injector.register(...late.lateUnits);
          if (!registered.ok) return registered;
          // Surfaces (banners, toasts, routable dialogs) ready soon after first paint (deferred chunk).
          void injector.get(SurfaceManagerToken, signal);
          const warmup = await injector.get(late.NavigationWarmupToken, signal);
          if (warmup.ok) supervisor.register(warmup.value);
          await injector.get(late.WebMcpPublisherToken, signal);
          await injector.get(late.ModelProviderToken, signal);
          return ok();
        },
        { priority: 'idle', signal: ctx.signal },
      )
      .then((result) => (result.ok ? result.value : result));
    return { ready };
  },
  description: 'Registers the late units chunk after boot.',
});

export const postBootSubsystemUnit = contribution({
  id: 'studio/post-boot-subsystem-unit',
  provides: SubsystemsToken,
  scope: 'app',
  deps: { required: { session: SessionToken, host: FeatureHostToken }, lazy: { late: LateServicesToken, appearance: AppearanceToken } },
  create: ({ session, host, late, appearance }) =>
    defineSubsystem({
      id: 'studio/post-boot',
      dependsOn: ['router/navigation'],
      start: (ctx) => {
        late.trigger();
        void appearance.whenReady(ctx.signal).then((controller) => (controller.ok ? controller.value.restore(ctx.signal) : undefined));
        watch(
          () => session.isAuthenticated,
          (authenticated) => {
            if (authenticated) void host.activate(Features.billing.id, ctx.signal);
            else if (host.stateOf(Features.billing.id) === 'activated') void host.deactivate(Features.billing.id);
          },
          { scope: ctx.scope, fireImmediately: true },
        );
      },
      description: 'Late units, theme restore and billing activation.',
    }),
});
