/**
 * `<agent-chat-panel>` — the chat UI over the headless controller. Renders messages
 * as they stream (fine-grained: only this component re-renders), prefilled drafts
 * from `?panel=chat&prompt=…` are never auto-sent (I-13).
 */
import { component, defineComponent, SfElement } from '@staticflux/ui';
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
    :host { display: grid; gap: 8px; padding: 12px; border-inline-start: 1px solid var(--sf-color-border, #ddd); min-inline-size: 260px; }
    ol { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; max-block-size: 50vh; overflow: auto; }
    .user { text-align: end; }
    .tool { font-family: var(--sf-font-mono, monospace); font-size: 0.85em; }
    form { display: flex; gap: 6px; }
    textarea { flex: 1; font: inherit; }
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
        <textarea aria-label="Message" data-testid="chat-draft" .value=${state.draft} @input=${(e: Event) => chat.store.actions.setDraft((e.target as HTMLTextAreaElement).value)}></textarea>
        <button type="submit" ?disabled=${state.status === 'streaming'}>Send</button>
      </form>
    `;
  }
}

export function defineChatPanel(): void {
  const defined = defineComponent(AgentChatPanel);
  if (!defined.ok) throw defined.error;
}
