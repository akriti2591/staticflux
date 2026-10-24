/**
 * Feature `agent/chat` (chunk `feature:agent-chat`, warm): headless logic + panel UI.
 * Logic can run without the panel (ref-counted by the feature host); the URL intent
 * `?panel=chat&prompt=…` is consumed after authorize and only prefills the draft.
 */
import { ok } from '@staticflux/core';
import { defineFeatureModule } from '@staticflux/runtime';
import { IntentServiceToken } from '@staticflux/urlstate';
import { html } from 'lit';
import { ChatPromptIntent } from '../../app/contracts.js';
import { mountFeatureRoot } from '../../ui/feature-root.js';
import { ChatControllerToken, chatControllerUnit, chatStoreUnit } from './logic.js';
import { defineChatPanel } from './panel.js';

export default defineFeatureModule({
  units: [chatStoreUnit, chatControllerUnit],
  async activate(context) {
    const [intents, chat] = await Promise.all([context.injector.get(IntentServiceToken), context.injector.get(ChatControllerToken)]);
    if (!intents.ok) return intents;
    if (!chat.ok) return chat;
    intents.value.consume(
      ChatPromptIntent,
      (delivery) => {
        // Prefill only: the user reviews and sends (delivery.execute() would refuse, I-13).
        if (delivery.params.prompt !== undefined) chat.value.store.actions.setDraft(delivery.params.prompt);
      },
      context.scope,
    );
    return ok();
  },
  async mount(context) {
    defineChatPanel();
    await mountFeatureRoot(context, () => html`<agent-chat-panel></agent-chat-panel>`);
    return ok();
  },
});
