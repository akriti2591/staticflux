/**
 * Adapter: @staticflux/urlstate intents → @staticflux/runtime features. After a
 * navigation, an authorized intent whose owner is a registered feature activates it,
 * so its (lazy) chunk registers the consumer and gets the intent delivered (prefill
 * only, I-13). The chat intent (`?panel=chat`) also opens the assistant panel.
 */
import { contribution } from '@staticflux/core';
import { NavigationHooksToken } from '@staticflux/router';
import { FeatureHostToken, type FeatureId } from '@staticflux/runtime';
import { IntentServiceToken } from '@staticflux/urlstate';
import { ChatPromptIntent, PanelControllerToken } from '../app/contracts.js';

export const intentActivationHookUnit = contribution({
  id: 'studio/intent-activation-hook-unit',
  provides: NavigationHooksToken,
  scope: 'app',
  deps: { required: { intents: IntentServiceToken, host: FeatureHostToken, panel: PanelControllerToken } },
  create: ({ intents, host, panel }) => ({
    id: 'studio/intent-activation',
    afterNavigate(result) {
      if (result.outcome !== 'committed') return;
      for (const info of intents.inspect()) {
        if (info.state !== 'authorized') continue;
        const owner = info.owner as FeatureId;
        if (!host.has(owner)) continue;
        if (info.id === ChatPromptIntent.id) void panel.show('agent/chat');
        else void host.activate(owner);
      }
    },
  }),
  description: 'Authorized intents activate their owning feature (chat opens the panel).',
});
