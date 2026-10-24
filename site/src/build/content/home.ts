import { code } from '../components.js';
import { html, md, raw, type Raw } from '../html.js';
import type { Page } from '../layout.js';
import { GITHUB, href } from '../site.js';

const ORBIT = raw(`<svg class="orbit" viewBox="0 0 480 480" role="img" aria-labelledby="orbit-title orbit-desc">
<title id="orbit-title">A static core with flux around it</title>
<desc id="orbit-desc">A solid core in the centre; around it, orbits carrying the pluggable implementations.</desc>
<defs>
  <radialGradient id="core-glow" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="var(--site-glow)"/><stop offset="1" stop-color="transparent"/></radialGradient>
  <linearGradient id="flux-a" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="var(--site-flux)"/><stop offset="1" stop-color="var(--site-flux-3)"/></linearGradient>
  <linearGradient id="flux-b" x1="1" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--site-flux-2)"/><stop offset="1" stop-color="var(--site-flux)"/></linearGradient>
</defs>
<circle cx="240" cy="240" r="200" fill="url(#core-glow)"/>
<g fill="none" stroke-linecap="round">
  <circle cx="240" cy="240" r="212" stroke="var(--site-grid-line)" stroke-width="1"/>
  <circle cx="240" cy="240" r="160" stroke="var(--site-grid-line)" stroke-width="1"/>
  <g class="orbit__ring orbit__ring--a"><ellipse cx="240" cy="240" rx="205" ry="78" stroke="url(#flux-a)" stroke-width="2.5" stroke-dasharray="2 10" transform="rotate(-24 240 240)"/></g>
  <g class="orbit__ring orbit__ring--b"><ellipse cx="240" cy="240" rx="190" ry="70" stroke="url(#flux-b)" stroke-width="2.5" transform="rotate(32 240 240)" stroke-dasharray="120 26 6 26"/></g>
  <g class="orbit__ring orbit__ring--c"><ellipse cx="240" cy="240" rx="150" ry="150" stroke="var(--sf-color-border)" stroke-width="1.5" stroke-dasharray="1 8"/></g>
</g>
<g class="orbit__nodes">
  <g transform="translate(62 170)"><rect x="-38" y="-15" width="76" height="30" rx="15" class="orbit__chip"/><text y="5" text-anchor="middle">router</text></g>
  <g transform="translate(410 128)"><rect x="-32" y="-15" width="64" height="30" rx="15" class="orbit__chip"/><text y="5" text-anchor="middle">auth</text></g>
  <g transform="translate(424 330)"><rect x="-32" y="-15" width="64" height="30" rx="15" class="orbit__chip"/><text y="5" text-anchor="middle">gate</text></g>
  <g transform="translate(92 352)"><rect x="-38" y="-15" width="76" height="30" rx="15" class="orbit__chip"/><text y="5" text-anchor="middle">worker</text></g>
  <g transform="translate(250 42)"><rect x="-30" y="-15" width="60" height="30" rx="15" class="orbit__chip"/><text y="5" text-anchor="middle">data</text></g>
  <g transform="translate(236 444)"><rect x="-26" y="-15" width="52" height="30" rx="15" class="orbit__chip"/><text y="5" text-anchor="middle">ui</text></g>
</g>
<circle cx="240" cy="240" r="62" class="orbit__core"/>
<circle cx="240" cy="240" r="62" fill="none" stroke="var(--site-flux)" stroke-width="2" opacity="0.55"/>
<text x="240" y="236" text-anchor="middle" class="orbit__core-label">core</text>
<text x="240" y="256" text-anchor="middle" class="orbit__core-sub">≤ 7.5 KB</text>
</svg>`);

interface Fabric {
  readonly n: string;
  readonly title: string;
  readonly text: string;
  readonly snippet: string;
}

const FABRIC: readonly Fabric[] = [
  {
    n: '01',
    title: 'Declarations',
    text: 'Tokens, flags, metrics, routes, capabilities and errors are typed values — never magic strings. Misconfiguration is a compile-time or CI error.',
    snippet: "token('docs/api').type<DocsApi>()",
  },
  {
    n: '02',
    title: 'A requires / provides graph',
    text: 'Every unit declares what it needs and what it offers. The injector resolves in topological order, times every resolution and refuses cycles and scope leaks.',
    snippet: 'deps: { required, lazy, functional }',
  },
  {
    n: '03',
    title: 'Scopes & lifecycles',
    text: 'Every lifecycle is a typed state machine; every resource lives in a disposal scope with an AbortSignal. Leaving a state cleans up — always.',
    snippet: 'scope.listen(window, "resize", fit)',
  },
  {
    n: '04',
    title: 'Plugins, not branches',
    text: 'Experiments, modes and hosts are alternate bindings and separate features. Feature code never asks “which variant am I?”',
    snippet: 'binder.variants({ flag, of, variants })',
  },
  {
    n: '05',
    title: 'One telemetry fabric',
    text: 'DI, navigation stages, chunks, requests, gate decisions, workers and renders all emit OpenTelemetry-shaped spans. Devtools are just a consumer.',
    snippet: "metric.histogram('docs/render', { unit: 'ms' })",
  },
];

interface Vertical {
  readonly title: string;
  readonly text: string;
  readonly packages: readonly string[];
  readonly guide: string;
}

const VERTICALS: readonly Vertical[] = [
  { title: 'Navigation & URL state', text: 'A 13-stage async pipeline with exit guards, typed routes, per-mode variants, view sub-routes, routable dialogs and consume-once intents.', packages: ['router', 'urlstate', 'handoff'], guide: 'guides/routing/' },
  { title: 'Sessions, gating & credits', text: 'Pluggable identity providers, single-flight refresh, multi-tab sync; facts → policies → O(1) explainable decisions; reserve → commit meters.', packages: ['auth', 'gate', 'config'], guide: 'guides/auth-gating/' },
  { title: 'Data & storage', text: 'Transport-agnostic resources with SWR and epochs, one retry layer, breakers, schema-first stores with patches, one async storage interface.', packages: ['data', 'storage'], guide: 'guides/data-storage/' },
  { title: 'Threads, documents & Wasm', text: 'Supervised workers, read-only replicas with intents, a CRDT-backed document engine, Wasm as worker-scoped units, multi-tab coordination.', packages: ['worker', 'document', 'wasm'], guide: 'guides/threads/' },
  { title: 'Rich surfaces', text: 'DOM, Canvas2D, WebGL, WebGPU and HTML-in-Canvas as projections, rendered in a worker via OffscreenCanvas with forwarded input.', packages: ['surface'], guide: 'guides/threads/' },
  { title: 'Performance & journeys', text: 'Journey traces from first input to feature complete, framework-measured feature marks, budgets per device tier, a conformance stream.', packages: ['perf', 'loader', 'devtools'], guide: 'guides/performance/' },
  { title: 'UI, shell & messaging', text: 'Lit components that self-inject render / lazy / functional deps; slots, workspaces, themes; one surface manager for every overlay.', packages: ['ui', 'shell', 'messaging'], guide: 'guides/ui-shell/' },
  { title: 'Accessible & localizable', text: 'Focus management, traps, announcer and shortcut registry; typed ICU catalogs with lazy locales and RTL — base requirements, not add-ons.', packages: ['a11y', 'i18n'], guide: 'guides/ui-shell/' },
  { title: 'Offline & instant boot', text: 'Service worker from warmup tiers, safe updates without reload, islands over prerendered HTML, store snapshots restored before the network.', packages: ['pwa', 'hydrate', 'loader'], guide: 'guides/pwa-hydration/' },
  { title: 'AI-native', text: 'Typed capabilities callable by UI, palette and agents through one gated, confirmed, metered pipeline; WebMCP publishing; advisors that only tune performance.', packages: ['capabilities', 'webmcp', 'ai', 'advisors'], guide: 'guides/ai/' },
  { title: 'Isolation for untrusted code', text: 'Third-party plugins run in sandboxed iframes or workers and can only invoke the capabilities granted to them.', packages: ['sandbox'], guide: 'guides/ai/' },
  { title: 'Tooling that enforces', text: 'Vite and Rspack plugins for logical chunks and budgets, the sf CLI for graph, lint, error catalog and ratchets, and a testkit with fake time.', packages: ['vite-plugin', 'sf', 'testkit'], guide: 'guides/tooling/' },
];

const PLATFORM: readonly { readonly api: string; readonly how: string }[] = [
  { api: 'Navigation API', how: 'History API fallback; memory history for embedded hosts' },
  { api: 'scheduler.yield / postTask', how: 'MessageChannel + setTimeout shim (Safari)' },
  { api: 'View Transitions', how: 'for route, view and workspace changes; skipped on reduced motion' },
  { api: 'Speculation Rules', how: 'progressive enhancement over modulepreload and SW warmup' },
  { api: 'SharedWorker + Web Locks', how: 'multi-tab leader election; BroadcastChannel fallback' },
  { api: 'OffscreenCanvas · WebGPU', how: 'render workers; main-thread fallback with the same engine' },
  { api: 'HTML-in-Canvas', how: 'feature-detected adapter; positioned DOM overlay fallback' },
  { api: 'Wasm SIMD · threads', how: 'variant builds picked from feature facts and isolation' },
  { api: 'COOP / COEP isolation', how: 'per-app choice; shared vs transfer channels picked for you' },
  { api: 'Built-in AI', how: 'one model-provider port; availability is a reactive fact' },
  { api: 'WebMCP', how: 'capabilities published as agent tools, gated as subject “agent”' },
  { api: 'IndexedDB · OPFS', how: 'one async AsyncStore; localStorage and memory fallbacks' },
];

function fabricCard(f: Fabric): Raw {
  return html`<li class="fabric__item"><span class="fabric__n">${f.n}</span><h3>${f.title}</h3><p>${f.text}</p><code class="fabric__snippet">${f.snippet}</code></li>`;
}

function verticalCard(v: Vertical): Raw {
  return html`<li class="vcard"><a class="vcard__link" href="${href(v.guide)}"><h3>${v.title}</h3><p>${v.text}</p><span class="vcard__pkgs">${v.packages.map((p) => html`<span class="chip">${p}</span>`)}</span></a></li>`;
}

function body(): Raw {
  return html`
<section class="hero">
  <div class="hero__inner">
    <div class="hero__copy">
      <p class="eyebrow">Client-side TypeScript framework · Lit · MobX 7</p>
      <h1 class="hero__title">A <em>static</em> core.<br>Flux everywhere else.</h1>
      <p class="hero__lede">StaticFlux is a small, stable core of contracts — tokens, units, scopes, results, state machines, telemetry — and an ecosystem of building blocks that plug into it. Each package works on its own. Together they make large single-page apps fast, observable and boring to change.</p>
      <div class="hero__cta">
        <a class="btn btn--primary" href="${href('getting-started/')}">Get started</a>
        <a class="btn btn--ghost" href="${href('before-after/')}">See before / after</a>
      </div>
      <dl class="stats">
        <div><dt>Core boot surface</dt><dd>≤ 7.5 KB</dd></div>
        <div><dt>Packages</dt><dd>31 + 3 tools</dd></div>
        <div><dt>Boot JS budget</dt><dd>≤ 150 KB</dd></div>
      </dl>
    </div>
    <div class="hero__art">${ORBIT}</div>
  </div>
</section>

<section class="band band--code" aria-labelledby="compose-title">
  <div class="split">
    <div class="split__text">
      <p class="eyebrow">Declare, don’t wire</p>
      <h2 id="compose-title" class="display">Every piece says what it needs. The injector does the rest.</h2>
      <p>${md('A *unit* declares `requires` and `provides` with typed tokens. Boot resolves critical units in dependency order and traces each one into a boot waterfall; everything else stays lazy until something asks for it. A missing provider is a type error at the composition site, not a 2 a.m. page.')}</p>
      <p><a class="link-arrow" href="${href('guides/core-di/')}">Core &amp; DI guide</a></p>
    </div>
    <div class="split__code">${code(
      `
      import { type Result, token, unit } from '@staticflux/core';
      import { bootApp } from '@staticflux/runtime';
      import { DataClientToken, dataClientUnit, epochSourceUnit, mockTransportUnit, pauseControlUnit } from '@staticflux/data';
      import { DocsList, type DocsPage } from './endpoints.js';

      export interface DocsApi { list(signal: AbortSignal): Promise<Result<DocsPage>> }
      export const DocsApiToken = token('docs/api').type<DocsApi>();

      export const docsApiUnit = unit({
        id: 'docs/api-unit',
        provides: DocsApiToken,
        scope: 'app',
        deps: { required: { client: DataClientToken } },
        create: ({ client }): DocsApi => ({
          list: (signal) => client.call(DocsList, { cursor: undefined }, { signal }),
        }),
      });

      const booted = await bootApp({
        units: [
          docsApiUnit, dataClientUnit, epochSourceUnit, pauseControlUnit,
          mockTransportUnit((mock) => mock.route(DocsList, () => ({ items: [], nextCursor: null }))),
        ],
      });
      `,
      { file: 'app/compose.ts' },
    )}</div>
  </div>
</section>

<section class="section" aria-labelledby="fabric-title">
  <header class="section__head">
    <p class="eyebrow">The fabric</p>
    <h2 id="fabric-title" class="display">Five ideas, applied to everything.</h2>
    <p class="section__lede">The same five ideas shape the router, the session, the surface manager and your features alike. Learn them once; every package reads the same way.</p>
  </header>
  <ol class="fabric">${FABRIC.map(fabricCard)}</ol>
</section>

<section class="section section--tint" aria-labelledby="verticals-title">
  <header class="section__head">
    <p class="eyebrow">Building blocks</p>
    <h2 id="verticals-title" class="display">Verticals that work alone — and best together.</h2>
    <p class="section__lede">Opting in is one line and immediately pays off: register <code>perfUnits</code> and you get journey traces; register <code>gateUnits</code> and every route, slot and capability can be gated with explanations.</p>
  </header>
  <ul class="vgrid">${VERTICALS.map(verticalCard)}</ul>
  <p class="section__more"><a class="link-arrow" href="${href('packages/')}">All 34 packages and tools</a></p>
</section>

<section class="section" aria-labelledby="platform-title">
  <div class="platform">
    <div class="platform__intro">
      <p class="eyebrow">One stop for the modern web</p>
      <h2 id="platform-title" class="display">Use the newest platform APIs. Ship to every browser.</h2>
      <p>${md('StaticFlux packages feature-detect every modern API and degrade deliberately — Safari and Firefox gaps included. You write the feature once; the platform facts pick the path. Experimental APIs live in adapter packages, so the core never churns when a spec does.')}</p>
      <ul class="checks">
        <li>Client-only: no SSR server to run, backends behind typed contracts</li>
        <li>Everything lazy by default, eager only with a declared reason</li>
        <li>Budgets for bytes, boot time, feature marks — enforced in CI</li>
        <li>Accessible, localizable and testable by default</li>
      </ul>
    </div>
    <ul class="platform__grid">${PLATFORM.map((p) => html`<li><strong>${p.api}</strong><span>${p.how}</span></li>`)}</ul>
  </div>
</section>

<section class="section section--ink" aria-labelledby="agents-title">
  <div class="split split--reverse">
    <div class="split__text">
      <p class="eyebrow">Agent-first codebase</p>
      <h2 id="agents-title" class="display">Explicit enough for humans. Explicit enough for agents.</h2>
      <p>${md('Every package ships an `AGENTS.md` with its purpose, public API by file, rules and budgets. Every error has a stable code and a fix, collected in a machine-readable catalog. Boundaries, budgets and lint rules are enforced by tooling — so nobody, human or AI, has to guess.')}</p>
      <p><a class="link-arrow" href="${href('philosophy/')}">Read the philosophy</a></p>
    </div>
    <div class="split__code">${code(
      `
      {
        "code": "SF-DI-002",
        "kind": "invariant",
        "summary": "A longer-lived unit requires a shorter-lived unit.",
        "fix": "Move the dependency to a lazy dep, or lower the consumer scope."
      }
      `,
      { lang: 'json', file: 'docs/errors.json' },
    )}</div>
  </div>
</section>

<section class="cta" aria-labelledby="cta-title">
  <h2 id="cta-title" class="display">Start with one unit. Grow into the whole fabric.</h2>
  <p>Clone the monorepo, run the checks, boot the Studio example — an AI-assisted document editor composing every vertical against mock services.</p>
  <div class="hero__cta hero__cta--center">
    <a class="btn btn--primary" href="${href('getting-started/')}">Get started</a>
    <a class="btn btn--ghost" href="${href('example/')}">Tour the example app</a>
    <a class="btn btn--ghost" href="${GITHUB}">GitHub</a>
  </div>
</section>`;
}

export const homePage: Page = {
  path: '',
  title: 'Static core, flux implementations',
  description: 'StaticFlux is a client-side TypeScript framework: a small, stable core of contracts and an ecosystem of building blocks — DI, lifecycles, routing, auth, gating, data, workers, performance, UI — that work best together.',
  nav: 'home',
  layout: 'landing',
  body,
};
