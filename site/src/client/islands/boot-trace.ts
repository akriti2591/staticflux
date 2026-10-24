/**
 * Island `island:boot-trace` — the live boot waterfall of the page you are reading.
 *
 * The site attaches a memory sink to its telemetry before boot (telemetry buffers until
 * the first sink attaches), so every span is here: `app.boot`, `boot.core`,
 * `boot.critical`, each `di.resolve`, and the island hydrations as they happen.
 * `<site-boot-trace>` is a `@staticflux/ui` component with one render dependency.
 */
import { err, ok, type SpanEndRecord } from '@staticflux/core';
import { defineIsland } from '@staticflux/hydrate';
import { component, defineComponent, provideScope, SfElement, UiEnvironmentToken } from '@staticflux/ui';
import { css, html, type TemplateResult } from 'lit';
import { BootTraceToken } from '../contracts.js';
import { MissingInjectorError } from '../errors.js';

const traceSpec = component({
  tag: 'site-boot-trace',
  deps: { render: { trace: BootTraceToken } },
  size: { block: '180px' },
  description: 'Boot waterfall from the page telemetry.',
});

function labelOf(span: SpanEndRecord): string {
  const unit = span.attrs['unit'];
  const chunk = span.attrs['chunk'];
  if (typeof unit === 'string') return unit;
  if (typeof chunk === 'string') return `${span.name} ${chunk}`;
  return span.name;
}

class SiteBootTrace extends SfElement<typeof traceSpec> {
  static override readonly spec = traceSpec;
  static override styles = css`
    :host { display: block; font: 400 0.75rem/1.2 var(--sf-font-mono); color: var(--sf-color-muted); min-block-size: 180px; }
    ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 3px; }
    li { display: grid; grid-template-columns: minmax(0, 11rem) 1fr 3.6rem; gap: 8px; align-items: center; }
    .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--sf-color-fg); }
    .track { position: relative; block-size: 8px; border-radius: 4px; background: var(--site-grid-line); }
    .bar { position: absolute; inset-block: 0; border-radius: 4px; background: var(--site-flux); min-inline-size: 2px; }
    .bar.di { background: var(--site-flux-2); }
    .bar.island { background: var(--site-flux-3); }
    .ms { text-align: end; font-variant-numeric: tabular-nums; }
    p { margin: 0 0 8px; }
  `;

  override render(): TemplateResult {
    const { trace } = this.deps;
    trace.version.get(); // track: re-render when spans end
    const spans = trace
      .records()
      .filter((r): r is SpanEndRecord => r.type === 'span')
      .filter((r) => r.subsystem === 'runtime/app' || r.subsystem === 'core/di' || r.subsystem.startsWith('hydrate/'))
      .sort((a, b) => a.start - b.start)
      .slice(0, 16);
    if (spans.length === 0) return html`<p>No spans recorded yet.</p>`;
    const t0 = Math.min(...spans.map((s) => s.start));
    const t1 = Math.max(...spans.map((s) => s.end));
    const range = Math.max(1, t1 - t0);
    const total = spans.find((s) => s.name === 'app.boot')?.duration;
    return html`
      <p>${total === undefined ? '' : html`Booted in <strong>${total.toFixed(1)} ms</strong> · `}${spans.length} spans</p>
      <ol aria-label="Boot waterfall">
        ${spans.map((span) => {
          const kind = span.subsystem === 'core/di' ? 'di' : span.subsystem.startsWith('hydrate/') ? 'island' : '';
          const left = ((span.start - t0) / range) * 100;
          const width = (span.duration / range) * 100;
          return html`<li>
            <span class="name" title=${labelOf(span)}>${labelOf(span)}</span>
            <span class="track" aria-hidden="true"><span class="bar ${kind}" style="inset-inline-start:${left.toFixed(2)}%;inline-size:${width.toFixed(2)}%"></span></span>
            <span class="ms">${span.duration.toFixed(1)} ms</span>
          </li>`;
        })}
      </ol>`;
  }
}

const bootTraceIsland = defineIsland({
  async hydrate(element, { injector, scope, signal }) {
    if (injector === undefined) return err(MissingInjectorError());
    const environment = await injector.get(UiEnvironmentToken, signal);
    if (!environment.ok) return environment;
    const provided = provideScope(element as HTMLElement, { injector, environment: environment.value, name: 'boot-trace-island' });
    scope.defer(() => provided.dispose());
    if (customElements.get(traceSpec.tag) === undefined) {
      const defined = defineComponent(SiteBootTrace);
      if (!defined.ok) return defined;
    }
    return ok();
  },
});

export const hydrate = bootTraceIsland.hydrate;
