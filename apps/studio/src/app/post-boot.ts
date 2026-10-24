/**
 * Post-boot work, off the critical path (R12.1 tiers: visible → idle): publish
 * capabilities to WebMCP, start the model router's background probe, restore the
 * theme preference, and activate billing logic once a user is signed in (credit banner).
 */
import { contribution, watch } from '@staticflux/core';
import { SessionToken } from '@staticflux/auth';
import { ModelProviderToken } from '@staticflux/ai';
import { defineSubsystem, FeatureHostToken, FrameSchedulerToken, SubsystemsToken } from '@staticflux/runtime';
import { ThemeControllerToken } from '@staticflux/shell';
import { WebMcpPublisherToken } from '@staticflux/webmcp';
import { AppInjectorToken } from '@staticflux/runtime';
import { Features } from './contracts.js';

export const postBootSubsystemUnit = contribution({
  id: 'studio/post-boot-subsystem-unit',
  provides: SubsystemsToken,
  scope: 'app',
  deps: { required: { injector: AppInjectorToken, frames: FrameSchedulerToken, session: SessionToken, host: FeatureHostToken } },
  create: ({ injector, frames, session, host }) =>
    defineSubsystem({
      id: 'studio/post-boot',
      dependsOn: ['router/navigation'],
      start: (ctx) => {
        void frames.postTask(
          async (signal) => {
            await injector.get(WebMcpPublisherToken, signal);
            await injector.get(ModelProviderToken, signal);
            const theme = await injector.get(ThemeControllerToken, signal);
            if (theme.ok) await theme.value.restore(signal);
          },
          { priority: 'idle', signal: ctx.signal },
        );
        watch(
          () => session.isAuthenticated,
          (authenticated) => {
            if (authenticated) void host.activate(Features.billing.id, ctx.signal);
            else void host.deactivate(Features.billing.id);
          },
          { scope: ctx.scope, fireImmediately: true },
        );
      },
      description: 'Idle-time services (WebMCP, AI probe, theme) and billing activation.',
    }),
});
