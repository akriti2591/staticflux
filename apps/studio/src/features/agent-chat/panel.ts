/**
 * `<agent-chat-panel>` — the chat UI over the headless controller. Renders messages
 * as they stream (fine-grained: only this component re-renders), prefilled drafts
 * from `?panel=chat&prompt=…` are never auto-sent (I-13).
 */
import { defineButton } from '@staticflux/kit/button';
import { defineTextField } from '@staticflux/kit/text-field';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { themeTokens as t } from '@staticflux/ui/theme';
import { css, html, type TemplateResult } from 'lit';
import { ChatControllerToken } from './logic.js';

const panelSpec = component({
  tag: 'agent-chat-panel',
  deps: { render: { chat: ChatControllerToken } },
  placeholder: () => html`<sf-skeleton lines="3"></sf-skeleton>`,
  size: { block: '240px' },
});

export class AgentChatPanel extends SfElement<typeof panelSpec> {
  static override readonly spec = panelSpec;
  static override styles = css`
    :host { display: grid; gap: ${t.space.sm.css}; padding: ${t.space.md.css}; background: ${t.color.surface1.css}; border-inline-start: 1px solid ${t.color.border.css}; min-inline-size: 260px; }
    h2 { margin: 0; font-size: ${t.type.sizeLg.css}; font-weight: ${t.font.weightSemibold.css}; }
    ol { list-style: none; padding: 0; margin: 0; display: grid; gap: ${t.space.sm.css}; max-block-size: 50vh; overflow: auto; }
    li { padding: ${t.space.sm.css}; border-radius: ${t.radius.md.css}; background: ${t.color.surfaceSunken.css}; }
    .user { text-align: end; background: ${t.color.accentSubtle.css}; }
    .tool { font-family: ${t.font.familyMono.css}; font-size: ${t.type.sizeSm.css}; color: ${t.color.textMuted.css}; }
    form { display: flex; gap: ${t.space.sm.css}; align-items: end; }
    sf-text-field { flex: 1; }
  `;

  override render(): TemplateResult {
    const { chat } = this.deps;
    const state = chat.store.state;
    return html`
      <h2>Assistant</h2>
      <ol aria-live="polite" data-testid="chat-messages">
        ${state.messages.map((m) => html`<li class=${m.role}>${m.text}</li>`)}
      </ol>
      <form @submit=${(e: Event) => { e.preventDefault(); void chat.send(); }}>
        <sf-text-field label="Message" label-hidden multiline rows="2" data-testid="chat-draft" .value=${state.draft} @input=${(e: Event) => chat.store.actions.setDraft((e.target as HTMLTextAreaElement).value)}></sf-text-field>
        <sf-button type="submit" variant="primary" ?disabled=${state.status === 'streaming'}>Send</sf-button>
      </form>
    `;
  }
}

export function defineChatPanel(): void {
  defineButton();
  defineTextField();
  const defined = defineComponent(AgentChatPanel);
  if (!defined.ok) throw defined.error;
}
