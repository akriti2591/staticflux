/**
 * `<studio-block-list>` — the document body (shared UI library, not a feature).
 * Reads the shared document store (render dep: placeholder until ready); edits are
 * intents to the document worker. Re-renders only for what it reads (R12.14).
 */
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, type TemplateResult } from 'lit';
import { DocumentStoreToken } from '../app/contracts.js';

const blockListSpec = component({
  tag: 'studio-block-list',
  deps: { render: { doc: DocumentStoreToken } },
  placeholder: () => html`<sf-skeleton lines="4"></sf-skeleton>`,
  size: { block: '160px' },
});

export class StudioBlockList extends SfElement<typeof blockListSpec> {
  static override readonly spec = blockListSpec;
  static override styles = css`
    :host { display: block; }
    ol { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--sf-space-2, 8px); }
    textarea { width: 100%; min-block-size: 3em; font: inherit; resize: vertical; box-sizing: border-box; }
    figure { margin: 0; }
    img { max-inline-size: 100%; border-radius: var(--sf-radius-small, 4px); background: var(--sf-color-skeleton, #eee); min-block-size: 40px; }
  `;

  override render(): TemplateResult {
    const { doc } = this.deps;
    if (doc.status === 'loading') return html`<sf-skeleton lines="4"></sf-skeleton>`;
    return html`<ol data-testid="blocks">
      ${doc.blocks.map((block) =>
        block.kind === 'image'
          ? html`<li><figure><img alt=${block.text} src=${block.src} crossorigin="anonymous" /><figcaption>${block.text}</figcaption></figure></li>`
          : html`<li>
              <textarea
                aria-label="Paragraph"
                ?readonly=${doc.readOnly}
                .value=${block.text}
                @change=${(event: Event) => void doc.editText(block.id, (event.target as HTMLTextAreaElement).value)}
              ></textarea>
            </li>`,
      )}
    </ol>`;
  }
}

export function defineBlockList(): void {
  const defined = defineComponent(StudioBlockList);
  if (!defined.ok) throw defined.error;
}
