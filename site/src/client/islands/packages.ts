/**
 * Island `island:packages` — layer chips + search over the prerendered package cards.
 *
 * The chips are a real `@staticflux/ui` component: `<site-package-filter>` self-injects its
 * render dependency (the filter store) from the nearest `<sf-scope>` — here the island
 * element, provided with the island's own feature-level child injector — and re-renders
 * only when what it read changes. The store's `layer` is bound to `?layer=` by urlstate,
 * so filtered views are shareable links; the cards themselves stay static HTML.
 */
import { effect, err, ok } from '@staticflux/core';
import { defineIsland } from '@staticflux/hydrate';
import { component, defineComponent, provideScope, SfElement, UiEnvironmentToken } from '@staticflux/ui';
import { css, html, type TemplateResult } from 'lit';
import { LAYERS, type LayerId, PackageFilterToken } from '../contracts.js';
import { MissingInjectorError } from '../errors.js';

const LAYER_LABELS: Readonly<Record<LayerId, string>> = {
  core: 'Core',
  runtime: 'Runtime',
  vertical: 'Verticals',
  ui: 'UI',
  shell: 'Shell',
  tooling: 'Tooling',
};

const filterSpec = component({
  tag: 'site-package-filter',
  deps: { render: { filter: PackageFilterToken } },
  size: { block: '44px' }, // reserved while the placeholder shows: no layout shift
  description: 'Layer chips + search for the packages reference.',
});

class SitePackageFilter extends SfElement<typeof filterSpec> {
  static override readonly spec = filterSpec;
  static override properties = { counts: { attribute: false } };
  declare counts: Readonly<Partial<Record<LayerId | 'all', number>>>;

  constructor() {
    super();
    this.counts = {};
  }

  static override styles = css`
    :host { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; min-block-size: 44px; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    button {
      font: 500 0.875rem/1 var(--sf-font-body); color: var(--sf-color-fg); cursor: pointer;
      padding: 9px 12px; border-radius: 999px; border: 1px solid var(--site-border-strong);
      background: var(--sf-color-surface); display: inline-flex; gap: 6px; align-items: center;
      transition: background var(--sf-motion-duration), border-color var(--sf-motion-duration);
    }
    button:hover { border-color: var(--sf-color-accent); }
    button[aria-pressed='true'] { background: var(--sf-color-fg); color: var(--sf-color-bg); border-color: var(--sf-color-fg); }
    button:focus-visible, input:focus-visible { outline: 3px solid var(--sf-color-focus); outline-offset: 2px; }
    .n { font: 500 0.75rem/1 var(--sf-font-mono); opacity: 0.7; }
    label { margin-inline-start: auto; display: flex; flex: 1 1 220px; max-inline-size: 320px; }
    input {
      inline-size: 100%; font: 400 0.9375rem/1.2 var(--sf-font-body); color: var(--sf-color-fg);
      padding: 10px 14px; border-radius: 999px; border: 1px solid var(--site-border-strong); background: var(--sf-color-surface);
    }
    input::placeholder { color: var(--sf-color-muted); }
    .vh { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    @media (prefers-reduced-motion: reduce) { button { transition: none; } }
  `;

  override render(): TemplateResult {
    const { filter } = this.deps;
    const active = filter.layer.get();
    const chip = (layer: LayerId | undefined, label: string): TemplateResult => html`
      <button type="button" aria-pressed=${String(active === layer)} @click=${() => filter.layer.set(layer)}>
        ${label}<span class="n">${this.counts[layer ?? 'all'] ?? ''}</span>
      </button>`;
    return html`
      <div class="chips" role="group" aria-label="Filter by layer">
        ${chip(undefined, 'All')}${LAYERS.map((layer) => chip(layer, LAYER_LABELS[layer]))}
      </div>
      <label><span class="vh">Search packages</span>
        <input type="search" placeholder="Search name, purpose, export…" .value=${filter.query.get()}
          @input=${(event: Event) => filter.query.set((event.target as HTMLInputElement).value)} />
      </label>`;
  }
}

function isCounts(value: unknown): value is { readonly counts: Readonly<Record<string, number>> } {
  return typeof value === 'object' && value !== null && typeof (value as { counts?: unknown }).counts === 'object';
}

const packagesIsland = defineIsland({
  async hydrate(element, { injector, scope, props, signal }) {
    if (injector === undefined) return err(MissingInjectorError());
    const [environment, filter] = await Promise.all([injector.get(UiEnvironmentToken, signal), injector.get(PackageFilterToken, signal)]);
    if (!environment.ok) return environment;
    if (!filter.ok) return filter;

    // The island element is the component scope: components inside resolve from the island injector.
    const provided = provideScope(element as HTMLElement, { injector, environment: environment.value, name: 'packages-island' });
    scope.defer(() => provided.dispose());
    if (customElements.get(filterSpec.tag) === undefined) {
      const defined = defineComponent(SitePackageFilter);
      if (!defined.ok) return defined;
    }
    const host = element.querySelector<SitePackageFilter>(filterSpec.tag);
    if (host !== null && isCounts(props)) host.counts = props.counts;

    const cards = [...element.querySelectorAll<HTMLElement>('[data-pkg]')];
    const groups = [...element.querySelectorAll<HTMLElement>('[data-layer-group]')];
    const status = element.querySelector<HTMLElement>('[data-pkg-count]');
    effect(() => {
      const layer = filter.value.layer.get();
      const query = filter.value.query.get().trim().toLowerCase();
      let shown = 0;
      for (const card of cards) {
        const match = (layer === undefined || card.dataset['layer'] === layer) && (query === '' || (card.dataset['search'] ?? '').includes(query));
        card.hidden = !match;
        if (match) shown += 1;
      }
      for (const group of groups) group.hidden = group.querySelector('[data-pkg]:not([hidden])') === null;
      if (status !== null) status.textContent = shown === cards.length ? `${cards.length} packages` : `${shown} of ${cards.length} packages`;
    }, scope);
    return ok();
  },
});

export const hydrate = packagesIsland.hydrate;
