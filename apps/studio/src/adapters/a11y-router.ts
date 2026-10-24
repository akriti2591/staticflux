/**
 * Adapter: @staticflux/a11y ⇄ @staticflux/router (R15.1). After a full navigation
 * focus moves to the main region (the registered route target) and the new page is
 * announced politely; view-state changes (tabs, wizard steps) keep focus.
 */
import { contribution } from '@staticflux/core';
import { AnnouncerToken, FocusManagerToken } from '@staticflux/a11y';
import { type NavigationHooks, NavigationHooksToken } from '@staticflux/router';
import { OutletsToken } from '../app/contracts.js';

export const routeFocusHookUnit = contribution({
  id: 'studio/route-focus-hook-unit',
  provides: NavigationHooksToken,
  scope: 'app',
  deps: { required: { focus: FocusManagerToken, announcer: AnnouncerToken, outlets: OutletsToken } },
  create: ({ focus, announcer, outlets }, ctx): NavigationHooks => {
    outlets.main.tabIndex = -1;
    ctx.scope.defer(focus.registerRouteTarget(outlets.main, ctx.scope));
    return {
      id: 'studio/route-focus',
      afterNavigate(result) {
        if (result.outcome !== 'committed' || result.kind !== 'full' || result.skipped) return;
        focus.focusRouteTarget();
        announcer.announce(`Navigated to ${result.match.location.pathname}`, { politeness: 'polite', dedupe: true });
      },
    };
  },
  description: 'Route-change focus + announcement.',
});
