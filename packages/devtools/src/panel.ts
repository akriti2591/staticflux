/**
 * `<sf-devtools>` — the devtools overlay (subpath `@staticflux/devtools/panel`,
 * lazy-loaded by `installDevtools` on first open).
 *
 * Renders the view models of a `Devtools` handle; it holds no data of its own.
 * Tabs follow the WAI-ARIA tabs pattern (roving tabindex, arrow keys, Home/End);
 * Escape closes and focus returns to where it was. Theming via CSS custom
 * properties (`--sf-devtools-*`), `theme="light|dark|auto"` (auto follows
 * `prefers-color-scheme`). Waterfall and graph are plain CSS bars / layered lists.
 */
import { err, type LevelName, ok, type Result, type Subsystem } from '@staticflux/core';
import { GATE_LEVELS, type GateLevel } from '@staticflux/gate';
import { css, html, LitElement, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { styleMap } from 'lit/directives/style-map.js';
import type { Devtools, DevtoolsCommand, ExplanationView } from './devtools.js';
import { PanelLoadFailedError } from './errors.js';
import { formatDebugFlag } from './levels.js';
import { DEVTOOLS_TABS, type DevtoolsTab, isDevtoolsTab, TAB_LABELS } from './tabs.js';
import { type CriticalStepView, previewJson, type WaterfallRow } from './views.js';

export const PANEL_TAG = 'sf-devtools' as const;
/** Fired (bubbles, composed) when the panel closes itself (Escape / close button). */
export const CLOSE_EVENT = 'sf-devtools-close' as const;

export type PanelTheme = 'auto' | 'light' | 'dark';

export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return '–';
  if (Math.abs(ms) < 10) return `${ms.toFixed(1)} ms`;
  if (Math.abs(ms) < 10_000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function pct(value: number, total: number): string {
  if (total <= 0) return '0%';
  return `${Math.max(0, Math.min(100, (value / total) * 100)).toFixed(3)}%`;
}

function attrText(attrs: Readonly<Record<string, unknown>>): string {
  const entries = Object.entries(attrs);
  if (entries.length === 0) return '';
  return entries.map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('|') : String(v)}`).join(' ');
}

export class SfDevtoolsElement extends LitElement {
  static override properties = {
    devtools: { attribute: false },
    open: { type: Boolean, reflect: true },
    tab: { type: String, reflect: true },
    theme: { type: String, reflect: true },
    decisionEffect: { state: true },
    decisionText: { state: true },
    explanation: { state: true },
    commandResult: { state: true },
  };

  static override styles = css`
    :host {
      --sf-devtools-bg: #ffffff;
      --sf-devtools-fg: #1d1f24;
      --sf-devtools-muted: #5d6470;
      --sf-devtools-border: #d5d9e0;
      --sf-devtools-surface: #f4f6f9;
      --sf-devtools-accent: #2357d8;
      --sf-devtools-bar: #8aa6ee;
      --sf-devtools-critical: #d9480f;
      --sf-devtools-ok: #2b8a3e;
      --sf-devtools-warn: #b7791f;
      --sf-devtools-error: #c92a2a;
      --sf-devtools-font: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      position: fixed;
      inset: auto 0 0 0;
      height: var(--sf-devtools-height, 45vh);
      z-index: 2147483000;
      display: block;
      color: var(--sf-devtools-fg);
      background: var(--sf-devtools-bg);
      border-top: 1px solid var(--sf-devtools-border);
      font: 12px/1.4 var(--sf-devtools-font);
      box-shadow: 0 -4px 16px rgb(0 0 0 / 0.15);
    }
    :host(:not([open])) {
      display: none;
    }
    :host([theme='dark']) {
      --sf-devtools-bg: #16181d;
      --sf-devtools-fg: #e3e6eb;
      --sf-devtools-muted: #9aa3b2;
      --sf-devtools-border: #2e333d;
      --sf-devtools-surface: #1f232a;
      --sf-devtools-accent: #7aa2ff;
      --sf-devtools-bar: #3f5fae;
      --sf-devtools-critical: #ff8a4c;
      --sf-devtools-ok: #69db7c;
      --sf-devtools-warn: #f5c56b;
      --sf-devtools-error: #ff6b6b;
    }
    @media (prefers-color-scheme: dark) {
      :host(:not([theme='light'])) {
        --sf-devtools-bg: #16181d;
        --sf-devtools-fg: #e3e6eb;
        --sf-devtools-muted: #9aa3b2;
        --sf-devtools-border: #2e333d;
        --sf-devtools-surface: #1f232a;
        --sf-devtools-accent: #7aa2ff;
        --sf-devtools-bar: #3f5fae;
        --sf-devtools-critical: #ff8a4c;
        --sf-devtools-ok: #69db7c;
        --sf-devtools-warn: #f5c56b;
        --sf-devtools-error: #ff6b6b;
      }
    }
    .frame { display: flex; flex-direction: column; height: 100%; }
    header { display: flex; align-items: center; gap: 8px; padding: 0 8px; border-bottom: 1px solid var(--sf-devtools-border); background: var(--sf-devtools-surface); }
    header .title { font-weight: 600; white-space: nowrap; }
    [role='tablist'] { display: flex; flex: 1; overflow-x: auto; }
    [role='tab'] { font: inherit; color: var(--sf-devtools-muted); background: none; border: 0; border-bottom: 2px solid transparent; padding: 6px 10px; cursor: pointer; white-space: nowrap; }
    [role='tab'][aria-selected='true'] { color: var(--sf-devtools-fg); border-bottom-color: var(--sf-devtools-accent); }
    [role='tab']:focus-visible, button:focus-visible, select:focus-visible, input:focus-visible, [role='tabpanel']:focus-visible { outline: 2px solid var(--sf-devtools-accent); outline-offset: -2px; }
    .badge { display: inline-block; min-width: 1.4em; padding: 0 4px; margin-left: 4px; border-radius: 8px; background: var(--sf-devtools-error); color: #fff; text-align: center; }
    [role='tabpanel'] { flex: 1; overflow: auto; padding: 8px; }
    button, select, input { font: inherit; color: var(--sf-devtools-fg); background: var(--sf-devtools-bg); border: 1px solid var(--sf-devtools-border); border-radius: 3px; padding: 2px 6px; }
    button { cursor: pointer; }
    h3 { font-size: 12px; margin: 10px 0 4px; }
    .muted { color: var(--sf-devtools-muted); }
    .hint { color: var(--sf-devtools-muted); font-style: italic; }
    table { border-collapse: collapse; width: 100%; }
    th, td { text-align: left; padding: 2px 6px; border-bottom: 1px solid var(--sf-devtools-border); vertical-align: top; }
    th { color: var(--sf-devtools-muted); font-weight: 500; }
    .wf-row { display: grid; grid-template-columns: minmax(180px, 32%) 1fr 70px; align-items: center; gap: 6px; min-height: 18px; }
    .wf-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .wf-track { position: relative; height: 10px; background: var(--sf-devtools-surface); }
    .wf-bar { position: absolute; top: 0; height: 100%; min-width: 1px; background: var(--sf-devtools-bar); }
    .wf-row.critical .wf-bar { background: var(--sf-devtools-critical); }
    .wf-row.error .wf-bar { background: var(--sf-devtools-error); }
    .wf-row.open .wf-bar { opacity: 0.5; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .state { padding: 0 4px; border-radius: 3px; border: 1px solid var(--sf-devtools-border); }
    .state.ready, .state.running, .state.mounted, .state.allow, .state.activated { color: var(--sf-devtools-ok); }
    .state.failed, .state.given-up, .state.crashed, .state.deny, .state.error { color: var(--sf-devtools-error); }
    .state.degraded, .state.paused, .state.warning, .state.refreshing, .state.restarting { color: var(--sf-devtools-warn); }
    .layers { display: flex; gap: 12px; align-items: flex-start; overflow-x: auto; }
    .layer { min-width: 200px; border: 1px solid var(--sf-devtools-border); border-radius: 4px; padding: 4px; }
    .node { padding: 3px 4px; border-bottom: 1px dashed var(--sf-devtools-border); }
    .node:last-child { border-bottom: 0; }
    .node.critical-set .name { font-weight: 600; }
    .card { border: 1px solid var(--sf-devtools-border); border-radius: 4px; padding: 6px; margin-bottom: 8px; }
    .card.error { border-left: 3px solid var(--sf-devtools-error); }
    .card.warning { border-left: 3px solid var(--sf-devtools-warn); }
    pre { margin: 4px 0; padding: 6px; background: var(--sf-devtools-surface); max-height: 240px; overflow: auto; white-space: pre-wrap; }
    .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin: 4px 0; }
  `;

  declare devtools: Devtools | undefined;
  declare open: boolean;
  declare tab: DevtoolsTab;
  declare theme: PanelTheme;
  declare decisionEffect: '' | 'allow' | 'deny';
  declare decisionText: string;
  declare explanation: Result<ExplanationView> | undefined;
  declare commandResult: string | undefined;

  private unsubscribe: (() => void) | undefined;
  private subscribedTo: Devtools | undefined;
  private returnFocus: Element | null = null;

  constructor() {
    super();
    this.devtools = undefined;
    this.open = false;
    this.tab = 'boot';
    this.theme = 'auto';
    this.decisionEffect = '';
    this.decisionText = '';
    this.explanation = undefined;
    this.commandResult = undefined;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.subscribe();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.subscribedTo = undefined;
  }

  private subscribe(): void {
    if (this.subscribedTo === this.devtools) return;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.subscribedTo = this.devtools;
    if (this.devtools !== undefined && this.isConnected) {
      // Only an open panel re-renders; a closed one costs nothing per record.
      this.unsubscribe = this.devtools.subscribe(() => {
        if (this.open) this.requestUpdate();
      });
    }
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('devtools')) this.subscribe();
    if (changed.has('tab') && !isDevtoolsTab(this.tab)) this.tab = 'boot';
    if (changed.has('open') && this.open && changed.get('open') !== true) {
      this.returnFocus = this.ownerDocument.activeElement;
    }
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (!changed.has('open')) return;
    if (this.open) this.focusTab(this.tab);
    else if (changed.get('open') === true) {
      const target = this.returnFocus as HTMLElement | null;
      this.returnFocus = null;
      if (target !== null && typeof target.focus === 'function' && target.isConnected) target.focus();
    }
  }

  /** Close (Escape / close button) and tell the installer. */
  close(): void {
    this.open = false;
    this.dispatchEvent(new CustomEvent(CLOSE_EVENT, { bubbles: true, composed: true }));
  }

  private focusTab(tab: DevtoolsTab): void {
    const button = this.renderRoot.querySelector<HTMLElement>(`#sf-dt-tab-${tab}`);
    button?.focus();
  }

  private select(tab: DevtoolsTab, focus = false): void {
    this.tab = tab;
    if (focus) void this.updateComplete.then(() => this.focusTab(tab));
  }

  private onTabKeydown(event: KeyboardEvent): void {
    const index = DEVTOOLS_TABS.indexOf(this.tab);
    let next: number | undefined;
    if (event.key === 'ArrowRight') next = (index + 1) % DEVTOOLS_TABS.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + DEVTOOLS_TABS.length) % DEVTOOLS_TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = DEVTOOLS_TABS.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    this.select(DEVTOOLS_TABS[next] as DevtoolsTab, true);
  }

  private onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      this.close();
    }
  }

  protected override render(): TemplateResult {
    const dt = this.devtools;
    const violations = dt?.collector.violationCount() ?? 0;
    return html`
      <div class="frame" role="dialog" aria-modal="false" aria-label="StaticFlux devtools" @keydown=${this.onKeydown}>
        <header>
          <span class="title">StaticFlux</span>
          <div role="tablist" aria-label="Devtools views" @keydown=${this.onTabKeydown}>
            ${DEVTOOLS_TABS.map(
              (tab) => html`<button
                role="tab"
                id="sf-dt-tab-${tab}"
                aria-selected=${tab === this.tab ? 'true' : 'false'}
                aria-controls="sf-dt-panel-${tab}"
                tabindex=${tab === this.tab ? 0 : -1}
                @click=${() => this.select(tab)}
              >
                ${TAB_LABELS[tab]}${tab === 'violations' && violations > 0
                  ? html`<span class="badge" aria-label="${violations} violations">${violations}</span>`
                  : nothing}
              </button>`,
            )}
          </div>
          <button aria-label="Close devtools" title="Close (Esc)" @click=${() => this.close()}>✕</button>
        </header>
        <div role="tabpanel" id="sf-dt-panel-${this.tab}" aria-labelledby="sf-dt-tab-${this.tab}" tabindex="0">
          ${dt === undefined ? html`<p class="hint">No devtools handle bound.</p>` : this.open ? this.renderTab(dt) : nothing}
        </div>
      </div>
    `;
  }

  private renderTab(dt: Devtools): TemplateResult {
    switch (this.tab) {
      case 'boot':
        return this.renderBoot(dt);
      case 'journeys':
        return this.renderJourneys(dt);
      case 'graph':
        return this.renderGraph(dt);
      case 'lifecycles':
        return this.renderLifecycles(dt);
      case 'decisions':
        return this.renderDecisions(dt);
      case 'stores':
        return this.renderStores(dt);
      case 'violations':
        return this.renderViolations(dt);
      case 'metrics':
        return this.renderMetrics(dt);
      case 'settings':
        return this.renderSettings(dt);
    }
  }

  // ---------------------------------------------------------------- boot

  private renderBars(rows: readonly WaterfallRow[], total: number): TemplateResult {
    return html`<div role="table" aria-label="Boot waterfall">
      ${rows.map(
        (row) => html`<div
          role="row"
          class="wf-row ${row.onCriticalPath ? 'critical' : ''} ${row.status === 'error' ? 'error' : ''} ${row.status === 'open' ? 'open' : ''}"
          title="${row.name} ${attrText(row.attrs)}"
        >
          <span role="cell" class="wf-label" style=${styleMap({ paddingLeft: `${row.depth * 12}px` })}>${row.label}</span>
          <span role="cell" class="wf-track" aria-hidden="true">
            <span class="wf-bar" style=${styleMap({ left: pct(row.offset, total), width: pct(row.duration, total) })}></span>
          </span>
          <span role="cell" class="num">${formatMs(row.duration)}${row.onCriticalPath ? html`<span class="muted" aria-label="on critical path"> ★</span>` : nothing}</span>
        </div>`,
      )}
    </div>`;
  }

  private renderPath(steps: readonly CriticalStepView[]): TemplateResult {
    if (steps.length === 0) return html`<span class="muted">—</span>`;
    return html`<ol>
      ${steps.map((s) => html`<li style=${styleMap({ marginLeft: `${s.depth * 12}px` })}>${s.label} <span class="muted">+${formatMs(s.offset)} · ${formatMs(s.duration)}</span></li>`)}
    </ol>`;
  }

  private renderBoot(dt: Devtools): TemplateResult {
    const boot = dt.views.boot();
    if (boot.status === 'missing') return html`<p class="hint">${boot.hint}</p>`;
    return html`
      <div class="row">
        <span class="state ${boot.status === 'failed' ? 'error' : boot.status === 'complete' ? 'ready' : 'refreshing'}">${boot.status}</span>
        <span>total ${formatMs(boot.total)}</span>
        <span class="muted">${boot.rows.length} spans · ${boot.units.length} units · ★ = critical path</span>
      </div>
      ${boot.overBudget.length > 0
        ? html`<div class="card error" role="alert">
            <strong>Over budget:</strong>
            ${boot.overBudget.map((u) => html`<div>${u.unit}: own ${formatMs(u.ownMs)} &gt; ${formatMs(u.budgetMs ?? 0)}</div>`)}
          </div>`
        : nothing}
      ${boot.hint === undefined ? nothing : html`<p class="hint">${boot.hint}</p>`}
      ${this.renderBars(boot.rows, boot.total)}
      <h3>Per-unit DI resolution</h3>
      <table>
        <thead><tr><th>unit</th><th>scope</th><th class="num">total</th><th class="num">waiting</th><th class="num">own</th><th class="num">budget</th><th>waited on</th></tr></thead>
        <tbody>
          ${boot.units.map(
            (u) => html`<tr>
              <td>${u.onCriticalPath ? '★ ' : ''}${u.unit}</td>
              <td>${u.scope ?? ''}</td>
              <td class="num">${formatMs(u.duration)}</td>
              <td class="num">${formatMs(u.waitMs)}</td>
              <td class="num">${formatMs(u.ownMs)}</td>
              <td class="num ${u.overBudget ? 'state error' : ''}">${u.budgetMs === undefined ? '' : formatMs(u.budgetMs)}</td>
              <td class="muted">${u.waitedOn.join(', ')}</td>
            </tr>`,
          )}
        </tbody>
      </table>
      <h3>Critical path</h3>
      ${this.renderPath(boot.criticalPath)}
    `;
  }

  // ---------------------------------------------------------------- journeys

  private renderJourneys(dt: Devtools): TemplateResult {
    const journeys = dt.views.journeys();
    if (journeys.length === 0) return html`<p class="hint">No journeys yet. Navigate, or register perf's journey tracker for full journey traces.</p>`;
    return html`${journeys.map(
      (j) => html`<div class="card">
        <div class="row">
          <strong>${j.route ?? '(no route)'}</strong>
          <span class="state">${j.start}</span>
          <span class="state ${j.outcome}">${j.outcome}</span>
          <span>${formatMs(j.duration)}</span>
          <span class="muted">${Object.entries(j.classification).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}:${v}`).join(' ')} · ${j.source}</span>
        </div>
        ${j.phases.map(
          (p) => html`<div class="wf-row">
            <span class="wf-label">${p.name}</span>
            <span class="wf-track" aria-hidden="true"><span class="wf-bar" style=${styleMap({ left: pct(p.offset, j.duration), width: pct(p.total, j.duration) })}></span></span>
            <span class="num">${formatMs(p.total)}</span>
          </div>
          <details><summary class="muted">critical path (${p.criticalPath.length})</summary>${this.renderPath(p.criticalPath)}</details>`,
        )}
        ${j.marks.length > 0
          ? html`<table><tbody>${j.marks.map((m) => html`<tr><td>${m.feature}</td><td>${m.mark}</td><td class="num">${formatMs(m.value)}</td><td class="muted">${m.method}</td></tr>`)}</tbody></table>`
          : nothing}
      </div>`,
    )}`;
  }

  // ---------------------------------------------------------------- graph

  private renderGraph(dt: Devtools): TemplateResult {
    const graph = dt.views.graph();
    const counts = Object.entries(graph.counts).map(([state, n]) => `${state}: ${n}`).join(' · ');
    if (graph.layers.length === 0) return html`<p class="hint">No units. Bind an injector (and unit definitions for the declared graph).</p>`;
    return html`
      <div class="row muted">${graph.source === 'graph' ? 'Layered by required dependencies (layer 0 = no deps)' : 'Live instances by scope (pass `units` for the declared graph)'} · ${counts}</div>
      ${graph.issues.length > 0
        ? html`<div class="card warning">${graph.issues.map((i) => html`<div><span class="state ${i.severity}">${i.code}</span> ${i.message}</div>`)}</div>`
        : nothing}
      <div class="layers" role="list" aria-label="Dependency layers">
        ${graph.layers.map(
          (layer, index) => html`<div class="layer" role="listitem">
            <h3>${graph.source === 'graph' ? `Layer ${index}` : (layer[0]?.scope ?? '')}</h3>
            <ul role="list" style="list-style:none;margin:0;padding:0">
              ${layer.map(
                (n) => html`<li class="node ${n.inCriticalSet ? 'critical-set' : ''}" title=${n.error ?? n.tokenId}>
                  <div class="name">${n.unitId}</div>
                  <div class="row">
                    <span class="state ${n.state}">${n.state}</span>
                    <span class="muted">${n.scope}${n.critical ? ' · critical' : ''}${n.declared ? '' : ' · undeclared'} · in ${n.fanIn} / out ${n.fanOut}</span>
                  </div>
                  ${n.requires.length > 0 ? html`<div class="muted">→ ${n.requires.join(', ')}</div>` : nothing}
                  ${n.error === undefined ? nothing : html`<div class="state error">${n.error}</div>`}
                </li>`,
              )}
            </ul>
          </div>`,
        )}
      </div>
    `;
  }

  // ---------------------------------------------------------------- lifecycles

  private renderLifecycles(dt: Devtools): TemplateResult {
    const view = dt.views.lifecycles();
    if (view.total === 0) return html`<p class="hint">No lifecycle transitions seen. Lifecycle events are emitted at \`verbose\`; raise the subsystem's level in Settings.</p>`;
    return html`${view.groups.map(
      (group) => html`<h3>${group.label} <span class="muted">(${group.items.length})</span></h3>
        <table>
          <thead><tr><th>instance</th><th>state</th><th class="num">transitions</th><th>details</th></tr></thead>
          <tbody>
            ${group.items.map(
              (item) => html`<tr>
                <td>${item.instance}</td>
                <td><span class="state ${item.state}">${item.state || '?'}</span>${item.invalid > 0 ? html` <span class="state error" title="last: ${item.lastInvalid?.event ?? ''} in ${item.lastInvalid?.state ?? ''}">${item.invalid} invalid</span>` : nothing}</td>
                <td class="num">${item.transitions}</td>
                <td class="muted">
                  ${attrText(item.details)}
                  ${item.history.length > 0
                    ? html`<details><summary>history</summary>${item.history.map((h) => html`<div>${h.from} → ${h.to}${h.event === undefined ? '' : ` (${h.event})`}</div>`)}</details>`
                    : nothing}
                </td>
              </tr>`,
            )}
          </tbody>
        </table>`,
    )}`;
  }

  // ---------------------------------------------------------------- decisions

  private runExplain(form: HTMLFormElement): void {
    const dt = this.devtools;
    if (dt === undefined) return;
    const data = new FormData(form);
    const level = String(data.get('level') ?? 'route') as GateLevel;
    const resource = String(data.get('resource') ?? '');
    const action = String(data.get('action') ?? '');
    const subject = data.get('subject') === 'agent' ? 'agent' : 'principal';
    this.explanation = dt.explain(level, resource, action === '' ? undefined : action, subject);
  }

  private renderExplanation(): TemplateResult | typeof nothing {
    const result = this.explanation;
    if (result === undefined) return nothing;
    if (!result.ok) return html`<div class="card error" role="status">${result.error.code}: ${result.error.message}</div>`;
    const e = result.value;
    return html`<div class="card ${e.effect === 'deny' ? 'error' : ''}" role="status">
      <div class="row"><span class="state ${e.effect}">${e.effect}</span>${e.reason === undefined ? nothing : html`<span>reason: ${e.reason}</span>`}<span class="muted">${e.level}:${e.resourceId}:${e.actionId} · ${e.subject} · table v${e.tableVersion} · ${e.source}</span></div>
      <div>determining: ${e.determining.join(', ') || '—'}</div>
      <div class="muted">evaluated: ${e.evaluated.join(', ') || '—'}</div>
      ${e.alternatives.length > 0 ? html`<div>alternatives: ${e.alternatives.join(', ')}</div>` : nothing}
      ${e.cost === undefined ? nothing : html`<div>cost: ${e.cost.amount} ${e.cost.meter}</div>`}
      ${e.requiresConfirmation ? html`<div>requires confirmation</div>` : nothing}
      <table><tbody>${e.facts.map((f) => html`<tr><td>${f.fact}</td><td>${previewJson(f.value, 200)}</td></tr>`)}</tbody></table>
      <p class="hint">Client gating is UX, not security — the server re-checks.</p>
    </div>`;
  }

  private renderDecisions(dt: Devtools): TemplateResult {
    const view = dt.views.decisions({ ...(this.decisionEffect === '' ? {} : { effect: this.decisionEffect }), text: this.decisionText });
    return html`
      <form class="row" aria-label="Explain a decision" @submit=${(e: Event) => { e.preventDefault(); this.runExplain(e.currentTarget as HTMLFormElement); }}>
        <label>level <select name="level">${GATE_LEVELS.map((l) => html`<option value=${l} ?selected=${l === 'route'}>${l}</option>`)}</select></label>
        <label>resource <input name="resource" placeholder="/studio" required /></label>
        <label>action <input name="action" placeholder="gate/access" /></label>
        <label>subject <select name="subject"><option value="principal">principal</option><option value="agent">agent</option></select></label>
        <button type="submit">Explain</button>
      </form>
      ${this.renderExplanation()}
      <div class="row">
        <label>effect <select @change=${(e: Event) => { this.decisionEffect = (e.target as HTMLSelectElement).value as '' | 'allow' | 'deny'; }}>
          <option value="">all</option><option value="allow">allow</option><option value="deny">deny</option>
        </select></label>
        <label>filter <input .value=${this.decisionText} @input=${(e: Event) => { this.decisionText = (e.target as HTMLInputElement).value; }} /></label>
        <span class="muted">${view.allow} allow · ${view.deny} deny</span>
      </div>
      ${view.items.length === 0
        ? html`<p class="hint">No decision changes yet (emitted at \`verbose\` on gate/decisions, or bind the gate).</p>`
        : html`<table>
            <thead><tr><th>resource</th><th>effect</th><th>reason</th><th>determining</th><th>subject</th></tr></thead>
            <tbody>${view.items.map(
              (d) => html`<tr>
                <td>${d.level}:${d.resourceId}<span class="muted">:${d.actionId}</span></td>
                <td><span class="state ${d.effect}">${d.effect}</span></td>
                <td>${d.reason ?? ''}${d.alternatives !== undefined && d.alternatives.length > 1 ? html`<span class="muted"> (${d.alternatives.join(' | ')})</span>` : nothing}</td>
                <td class="muted">${d.determining.join(', ')}</td>
                <td class="muted">${d.subject}</td>
              </tr>`,
            )}</tbody>
          </table>`}
    `;
  }

  // ---------------------------------------------------------------- stores

  private renderStores(dt: Devtools): TemplateResult {
    const stores = dt.views.stores();
    if (stores.length === 0) return html`<p class="hint">No stores bound. Contribute with \`inspectStore(Token)\` or pass \`stores\` to installDevtools.</p>`;
    return html`${stores.map(
      (s) => html`<details class="card">
        <summary><strong>${s.id}</strong> <span class="muted">${s.mode} · v${s.version} · epoch ${s.epoch}${s.schemaVersion === undefined ? '' : ` · schema ${s.schemaVersion}`} · ${s.patches.length} patches</span></summary>
        <pre>${previewJson(s.state)}</pre>
        ${s.patches.length > 0
          ? html`<table><thead><tr><th class="num">v</th><th>action</th><th>ops</th></tr></thead><tbody>${s.patches.map(
              (p) => html`<tr><td class="num">${p.version}</td><td>${p.action}</td><td class="muted">${p.paths.join(' · ')}${p.ops > p.paths.length ? ` (+${p.ops - p.paths.length})` : ''}</td></tr>`,
            )}</tbody></table>`
          : nothing}
      </details>`,
    )}`;
  }

  // ---------------------------------------------------------------- violations

  private renderViolations(dt: Devtools): TemplateResult {
    const view = dt.views.violations();
    if (view.groups.length === 0) return html`<p class="hint">No conformance violations.</p>`;
    return html`
      <div class="row"><span class="state error">${view.errors} errors</span><span class="state warning">${view.warnings} warnings</span><span class="muted">${view.total} total</span></div>
      ${view.groups.map(
        (g) => html`<div class="card ${g.severity}">
          <div class="row"><strong>${g.code}</strong><span class="state ${g.severity}">${g.severity}</span><span>×${g.count}</span>${g.message === undefined ? nothing : html`<span>${g.message}</span>`}</div>
          <div><strong>Fix:</strong> ${g.fix || html`<span class="muted">(none given)</span>`}</div>
          ${g.features.length > 0 ? html`<div class="muted">features: ${g.features.join(', ')}</div>` : nothing}
          ${g.units.length > 0 ? html`<div class="muted">units: ${g.units.join(', ')}</div>` : nothing}
          <div class="muted">from: ${g.subsystems.join(', ')}</div>
        </div>`,
      )}
    `;
  }

  // ---------------------------------------------------------------- metrics

  private renderMetrics(dt: Devtools): TemplateResult {
    const view = dt.views.metrics();
    if (view.metrics.length === 0) return html`<p class="hint">No metrics recorded or declared.</p>`;
    return html`
      ${view.silent.length > 0 ? html`<p class="hint">Declared but never recorded: ${view.silent.join(', ')}</p>` : nothing}
      <table>
        <thead><tr><th>metric</th><th>kind</th><th class="num">last</th><th class="num">count</th><th class="num">min</th><th class="num">max</th><th>attrs</th></tr></thead>
        <tbody>
          ${view.metrics.map((m) =>
            m.series.length === 0
              ? html`<tr><td>${m.id}</td><td>${m.kind}</td><td class="muted" colspan="5">no values</td></tr>`
              : m.series.map(
                  (s, i) => html`<tr>
                    <td>${i === 0 ? m.id : ''}</td>
                    <td>${i === 0 ? m.kind : ''}</td>
                    <td class="num">${m.kind === 'counter' ? s.sum : s.last}${m.unit === undefined ? '' : ` ${m.unit}`}</td>
                    <td class="num">${s.count}</td>
                    <td class="num">${s.min}</td>
                    <td class="num">${s.max}</td>
                    <td class="muted">${attrText(s.attrs)}</td>
                  </tr>`,
                ),
          )}
        </tbody>
      </table>
    `;
  }

  // ---------------------------------------------------------------- settings

  private async runCommand(dt: Devtools, command: DevtoolsCommand): Promise<void> {
    const result = await dt.command(command);
    this.commandResult = result.ok ? `${command}: ok` : `${command}: ${result.error.code} ${result.error.message}`;
  }

  private renderSettings(dt: Devtools): TemplateResult {
    const view = dt.views.settings();
    const levelSelect = (subsystem: Subsystem | '*', current: LevelName | undefined): TemplateResult => html`<select
      aria-label="Level for ${subsystem}"
      @change=${(e: Event) => dt.setLevel(subsystem, (e.target as HTMLSelectElement).value as LevelName)}
    >
      ${current === undefined ? html`<option value="" selected disabled>—</option>` : nothing}
      ${view.levels.map((l) => html`<option value=${l} ?selected=${l === current}>${l}</option>`)}
    </select>`;
    const defaultOverride = view.overrides.find((o) => o.subsystem === '*')?.level;
    return html`
      <h3>App</h3>
      <div class="row">
        <span>state: <span class="state ${view.appState ?? ''}">${view.appState ?? 'no supervisor bound'}</span></span>
        ${view.commands.map((c) => html`<button ?disabled=${!c.available} @click=${() => void this.runCommand(dt, c.command)}>${c.command}</button>`)}
        ${this.commandResult === undefined ? nothing : html`<span role="status" class="muted">${this.commandResult}</span>`}
      </div>
      <h3>Verbosity <span class="muted">(applies now, no reload)</span></h3>
      <div class="row"><span>default (*)</span>${levelSelect('*', defaultOverride)}<button @click=${() => dt.verbosity.reset()}>Reset overrides</button></div>
      <div class="row muted">Session flag: ${view.overrides.length === 0 ? '—' : `?sf-debug=${formatDebugFlag(view.overrides)}`}</div>
      <table>
        <thead><tr><th>subsystem</th><th>level</th></tr></thead>
        <tbody>
          ${view.subsystems.map(
            (s) => html`<tr><td>${s.subsystem}${s.overridden ? html` <span class="muted">(override)</span>` : nothing}</td><td>${levelSelect(s.subsystem as Subsystem, s.level)}</td></tr>`,
          )}
        </tbody>
      </table>
      <h3>Theme</h3>
      <select aria-label="Theme" @change=${(e: Event) => { this.theme = (e.target as HTMLSelectElement).value as PanelTheme; }}>
        ${(['auto', 'light', 'dark'] as const).map((t) => html`<option value=${t} ?selected=${t === this.theme}>${t}</option>`)}
      </select>
      <h3>Sources</h3>
      <div class="muted">${Object.entries(view.bound).map(([k, v]) => `${k}: ${v ? 'bound' : '—'}`).join(' · ')}</div>
    `;
  }
}

/** Define `<sf-devtools>` (idempotent). Errors if another element owns the tag. */
export function definePanel(registry: CustomElementRegistry = customElements): Result<void> {
  const existing = registry.get(PANEL_TAG);
  if (existing === SfDevtoolsElement) return ok();
  if (existing !== undefined) return err(PanelLoadFailedError({ message: `"${PANEL_TAG}" is already defined by another element.` }));
  registry.define(PANEL_TAG, SfDevtoolsElement);
  return ok();
}

declare global {
  interface HTMLElementTagNameMap {
    'sf-devtools': SfDevtoolsElement;
  }
}
