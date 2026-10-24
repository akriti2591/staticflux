/**
 * `<sf-boundary region="main">` — per-region error boundary (R13.3).
 *
 * Catches bubbling `sf-error` events (component dependency failures, render errors,
 * missing scopes) from anything inside it, stops them from taking down other regions,
 * reports them (telemetry + metric) and renders an accessible fallback with Retry.
 * Retry calls `retry()` on the failing component(s) and shows the content again.
 */
import { type SfError } from '@staticflux/core';
import { component, defineComponent, SfElement, SfErrorEvent } from '@staticflux/ui';
import { css, html, type PropertyValues } from 'lit';
import { SHELL_SUBSYSTEM, shellMetrics } from './telemetry.js';

const boundarySpec = component({ tag: 'sf-boundary' });

interface Retryable {
  retry(): void;
}

export class SfBoundaryElement extends SfElement<typeof boundarySpec> {
  static override readonly spec = boundarySpec;
  static override properties = {
    region: { type: String },
    label: { type: String },
    failure: { state: true },
  };
  static override styles = css`
    :host {
      display: contents;
    }
    .fallback {
      padding: var(--sf-space-3, 16px);
      border: 1px solid var(--sf-color-border, #ccc);
      border-radius: var(--sf-radius, 8px);
      color: var(--sf-color-fg, inherit);
      background: var(--sf-color-surface, transparent);
    }
    code {
      font-family: var(--sf-font-mono, monospace);
      color: var(--sf-color-muted, inherit);
    }
  `;

  declare region: string;
  declare label: string;
  declare failure: SfError | undefined;
  private failing = new Set<Element>();

  constructor() {
    super();
    this.region = '';
    this.label = '';
    this.failure = undefined;
    this.addEventListener(SfErrorEvent.type, (event) => this.onError(event));
  }

  /** Clear the failure and retry failing components. */
  override retry(): void {
    const failing = [...this.failing];
    this.failing.clear();
    this.failure = undefined;
    for (const element of failing) (element as Partial<Retryable>).retry?.();
  }

  private onError(event: SfErrorEvent): void {
    if (event.target === this) return;
    event.stopPropagation();
    const origin = event.composedPath()[0];
    if (origin instanceof Element) this.failing.add(origin);
    this.failure ??= event.error;
    const telemetry = this.injector?.telemetry;
    telemetry?.record(shellMetrics.boundaryErrors, 1, { region: this.region, code: event.error.code });
    telemetry?.event('shell.boundary.caught', {
      subsystem: SHELL_SUBSYSTEM,
      level: 'critical',
      attrs: { region: this.region, code: event.error.code, origin: event.origin },
    });
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('failure')) this.toggleAttribute('failed', this.failure !== undefined);
  }

  override render(): unknown {
    const failure = this.failure;
    return html`<slot ?hidden=${failure !== undefined}></slot>
      ${failure === undefined
        ? null
        : html`<div class="fallback" role="alert">
            <p>${this.label === '' ? 'This part of the page failed to load.' : `${this.label} failed to load.`}</p>
            <p><code>${failure.code}</code></p>
            <button type="button" @click=${() => this.retry()}>Retry</button>
          </div>`}`;
  }
}

export function defineBoundary(registry: CustomElementRegistry = customElements): void {
  if (registry.get(boundarySpec.tag) === undefined) defineComponent(SfBoundaryElement, registry);
}
