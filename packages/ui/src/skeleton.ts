/**
 * `<sf-skeleton lines="3">` — the default placeholder: size-stable lines,
 * compositor-only shimmer (opacity), no motion under `prefers-reduced-motion`.
 * Decorative (`aria-hidden`); the owning component carries `aria-busy` (R15.5).
 */
import { css, html, LitElement, type PropertyValues } from 'lit';

export class SfSkeletonElement extends LitElement {
  static override properties = {
    lines: { type: Number },
  };

  static override styles = css`
    :host {
      display: block;
      contain: content;
    }
    .line {
      block-size: var(--sf-skeleton-line-height, 0.875rem);
      margin-block: var(--sf-skeleton-gap, 0.5rem);
      border-radius: var(--sf-radius-small, 4px);
      background: var(--sf-color-skeleton, rgba(127, 127, 127, 0.18));
      animation: sf-skeleton-pulse 1.4s ease-in-out infinite;
    }
    .line:last-child:not(:first-child) {
      inline-size: 60%;
    }
    @keyframes sf-skeleton-pulse {
      50% {
        opacity: 0.45;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .line {
        animation: none;
      }
    }
  `;

  declare lines: number;

  constructor() {
    super();
    this.lines = 1;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.setAttribute('aria-hidden', 'true');
  }

  protected override willUpdate(_changed: PropertyValues<this>): void {
    if (!Number.isFinite(this.lines) || this.lines < 1) this.lines = 1;
  }

  protected override render(): unknown {
    return html`${Array.from({ length: Math.floor(this.lines) }, () => html`<div class="line"></div>`)}`;
  }
}

export const SF_SKELETON_TAG = 'sf-skeleton';

export function defineSkeletonElement(registry: CustomElementRegistry = customElements): void {
  if (registry.get(SF_SKELETON_TAG) === undefined) registry.define(SF_SKELETON_TAG, SfSkeletonElement);
}
