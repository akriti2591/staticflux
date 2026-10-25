import { callout, code, h2, readMore } from '../components.js';
import { html, md, paras, type Raw } from '../html.js';
import type { Page } from '../layout.js';
import { gh, href } from '../site.js';

interface Principle {
  readonly id: string;
  readonly title: string;
  readonly rule: string;
  readonly why: string;
}

/** P1–P10 as stated in docs/REQUIREMENTS.md §1, with the reasoning behind each. */
const PRINCIPLES: readonly Principle[] = [
  {
    id: 'P1',
    title: 'Type-safe end to end',
    rule: 'Misconfiguration is a compile-time or CI error, not a runtime surprise. Tokens, flags, routes and capabilities are typed values; declaration merging is the cross-package extension mechanism.',
    why: 'A string key that drifts silently is the most common bug in a large app. A typed value that drifts fails the build — and tells you where.',
  },
  {
    id: 'P2',
    title: 'Declare, don’t wire',
    rule: 'Every logical unit declares what it requires and what it provides. Manifests are data, checked by types and by tooling.',
    why: 'When dependencies are data, the graph can be printed, checked for cycles and scope leaks, ordered for boot, split into chunks — by a machine, before anyone runs the app.',
  },
  {
    id: 'P3',
    title: 'Granular units',
    rule: 'No god objects. A unit does one thing; fan-in and fan-out are measured and budgeted.',
    why: 'Small units are testable alone, lazy-loadable alone and replaceable alone. The graph tool flags the unit that starts to absorb everything.',
  },
  {
    id: 'P4',
    title: 'Composition, not inheritance; plugins, not branches',
    rule: 'Experiments and variants are alternate bindings, never if/else in feature code. Inheritance depth is at most one (Lit’s base element).',
    why: 'Branches multiply: every flag doubles the paths through a feature. Bindings replace instead of multiply — each variant is a unit you can test and delete.',
  },
  {
    id: 'P5',
    title: 'Everything observable',
    rule: 'Every unit, transition, resolution, request and decision emits telemetry through one vendor-neutral fabric. Devtools are a consumer of that fabric.',
    why: 'You cannot fix a boot regression you cannot see. With one fabric, the boot waterfall, the journey trace and the gate explanation come for free.',
  },
  {
    id: 'P6',
    title: 'Everything cancellable and disposable',
    rule: 'Every async operation takes an AbortSignal; every resource registers in a lifecycle-owned disposal scope.',
    why: 'Leaks and late writes are lifecycle bugs. When every listener, timer and request belongs to a scope, leaving the scope is the cleanup.',
  },
  {
    id: 'P7',
    title: 'Budgets enforced from day one',
    rule: 'Bundle size, chunk size, boot time, activation time, memory and dependency fan-out are declared in manifests, enforced in CI and surfaced in devtools.',
    why: 'Performance is lost one reasonable commit at a time. A budget that fails CI — and ratchets tighter when you beat it — keeps the wins you already paid for.',
  },
  {
    id: 'P8',
    title: 'Shallow abstractions',
    rule: 'At most one layer between a contract and its implementation.',
    why: 'Every indirection is a place to get lost. One hop from interface to code means a reader — or an agent — can always find what actually runs.',
  },
  {
    id: 'P9',
    title: 'One version per app',
    rule: 'Every framework package is a singleton per app; no duplicate versions, including across federated modules.',
    why: 'Two copies of the injector or the reactivity runtime break identity checks in subtle ways. The build validates shared singletons before anything ships.',
  },
  {
    id: 'P10',
    title: 'Accessible, localizable, testable by default',
    rule: 'These are base requirements, not add-ons.',
    why: 'Retrofitting focus management, RTL or test seams is expensive; designing them into the primitives makes the right thing the default thing.',
  },
];

function principle(p: Principle): Raw {
  return html`<li class="principle" id="${p.id.toLowerCase()}"><span class="principle__id">${p.id}</span><h3>${p.title}</h3><p>${md(p.rule)}</p><p class="principle__why"><strong>Why:</strong> ${md(p.why)}</p></li>`;
}

function body(): Raw {
  return html`
${paras(
  'StaticFlux is a client-side TypeScript framework for large single-page applications that span many teams, many packages and possibly many repositories. Its name is its design: a **static** core of contracts and primitives that rarely changes, and **flux** — everything else — as implementations that plug into it.',
  'The core never knows about features. Features, and the framework’s own packages, contribute through the same typed contribution points. That one decision — *inversion of control everywhere* — is where most of the rest follows from.',
)}

${h2('The ten principles')}
<p>${md('Every package is held to these. They are stated in `docs/REQUIREMENTS.md` §1 and enforced, wherever a machine can enforce them, by types, lint rules, the dependency graph tool and CI budgets.')}</p>
<ol class="principles">${PRINCIPLES.map(principle)}</ol>

${h2('Inversion of control')}
${paras(
  'In most apps, the app reaches out for what it needs: it imports a singleton, reads a global, calls a service locator. In StaticFlux, nothing reaches out. A unit *declares* its dependencies and the injector *hands them in*. The router doesn’t know about auth — auth contributes a stage plugin. The shell doesn’t know about features — features contribute slot items. The gate doesn’t know where facts come from — fact sources are plugins.',
  'The payoff is that every package stays small and replaceable, and every integration is visible in one place: the composition. In the Studio example app, `src/app/compose.ts` is the single file where packages meet, and each pair of packages that needs to talk does so through a tiny adapter file.',
)}
${code(
  `
  // auth never imports runtime. It exposes a listener port; the app contributes to it.
  export const epochRefreshListenerUnit = contribution({
    id: 'studio/epoch-refresh-listener-unit',
    provides: SessionListenersToken,          // a multi token owned by @staticflux/auth
    scope: 'app',
    deps: { lazy: { supervisor: SupervisorToken } },  // owned by @staticflux/runtime
    create: ({ supervisor }) => ({
      id: 'studio/epoch-refresh',
      onSessionChange(change) {
        if (change.requiresEpochRefresh && supervisor.value?.can('refresh') === true) void supervisor.value.refresh();
      },
    }),
  });
  `,
  { file: 'apps/studio/src/adapters/auth-runtime.ts (abridged)' },
)}

${h2('Composition over inheritance')}
${paras(
  'StaticFlux has exactly one base class you extend: `SfElement`, because Lit requires a class. Everything else is composed. A feature is a manifest plus a module of hooks. A unit is a plain object with a `create` function. A variant is a binding. A middleware returns the same interface it wraps — `namespaced`, `withTtl`, `encrypted` and `tiered` storage all stack because each one *is* an `AsyncStore`.',
  'The `inheritance-depth` lint rule fails any chain deeper than one level, so this is not a style preference that erodes — it is a property of the codebase.',
)}

${h2('Performance first')}
${paras(
  '**Everything is lazy by default**, framework packages included. Loading eagerly is an explicit declaration with a mandatory reason, counted against the boot budget and shown in the boot waterfall. Critical units are the only ones boot waits for; a tiny inline mode detector picks a per-profile boot plan before anything else runs, so code for other modes is never fetched.',
  'Rendering is *snappy by construction*: one render pass per frame, fine-grained reactivity, measure/mutate phases separated by the scheduler, size-stable placeholders, heavy work in workers. And StaticFlux defines its own performance model — journeys and feature marks measured by the framework — instead of relying on Web Vitals as the source of truth.',
)}
${callout('note', 'Budgets ratchet', 'Size budgets live in `.size-limit.json` and run in CI. `pnpm budgets` proposes *tightening* a budget when the actual size beats it; loosening one needs a reviewed reason. Nothing ever loosens on its own.')}

${h2('An agent-first codebase')}
${paras(
  'The codebase is written to be read by humans *and* AI agents without either having to assume anything. That means: explicit over clever, verbose over magic, shallow abstractions, no magic strings, and rules enforced by tooling rather than by tribal knowledge.',
  'Every package ships an `AGENTS.md` (purpose, layer, public API by file, rules, budgets, test command), with generated sections kept in sync with the config CI enforces. Every error is defined once with `defineError` — a stable code like `SF-NAV-002`, a kind, a summary and a concrete fix — and collected into the machine-readable catalog `docs/errors.json`. Agents look codes up instead of guessing.',
)}
${code(
  `
  export const ScopeViolation = defineError('SF-DI-002', 'invariant',
    'A longer-lived unit requires a shorter-lived unit.',
    'Move the dependency to a lazy dep, or lower the consumer scope.');

  return err(ScopeViolation({ units: [consumer.id, dependency.id] }));
  `,
  { file: 'errors are values, with a fix' },
)}

${h2('Enforcement over convention')}
<p>${md('A rule that is only written down is a suggestion. StaticFlux turns its rules into checks that run in `pnpm check` and in CI:')}</p>
<div class="prose-table"><table>
  <thead><tr><th>Rule</th><th>Enforced by</th></tr></thead>
  <tbody>
    <tr><td>No deep imports, no runtime cycles, core imports nothing internal, features never import features</td><td><code>pnpm lint:boundaries</code> (dependency-cruiser)</td></tr>
    <tr><td>Layer boundaries: a package imports only what it declares, from lower layers</td><td><code>package.json</code> dependencies + <code>staticflux.layer</code>, documented by <code>sf agents</code></td></tr>
    <tr><td>No direct flag reads, no bare <code>addEventListener</code>, inheritance depth ≤ 1, no string tokens, no default exports</td><td><code>pnpm lint:sf</code> (the <code>sf</code> CLI)</td></tr>
    <tr><td>Missing providers, duplicate dependency keys, typed tokens / routes / URL keys</td><td>TypeScript (<code>composeUnits</code>, <code>defineModule</code>, declaration merging)</td></tr>
    <tr><td>No cycles, scope rules, fan-in / fan-out, read-but-never-informed metrics</td><td><code>sf graph</code></td></tr>
    <tr><td>Every error code unique and catalogued</td><td><code>pnpm errors:check</code></td></tr>
    <tr><td>Bundle budgets per package and per logical chunk</td><td><code>pnpm size</code>, the Vite / Rspack plugins</td></tr>
    <tr><td>Route × mode completeness, valid build manifests</td><td><code>sf routes</code>, <code>sf manifest</code></td></tr>
    <tr><td>Every implementation of a port passes its shared contract suite, on every medium and topology</td><td><code>@staticflux/testkit</code> contract suites in <code>pnpm test</code></td></tr>
    <tr><td>No denied or unknown licenses across npm, cargo and model weights</td><td><code>pnpm licenses:check</code></td></tr>
  </tbody>
</table></div>

${h2('Client gating is UX, not security')}
${paras(
  'StaticFlux has a fast, expressive gating system: facts, declarative policies, compiled decision tables, explainable decisions, meters for credits and quotas. It decides what to render, which chunks to load (a denied feature’s code is never even fetched) and which calls to attempt.',
  'It is **not** authorization. Anything that runs in the browser can be changed by the person using it. Every server endpoint re-checks every request. Every package that gates — `gate`, `auth`, `capabilities`, `webmcp`, `sandbox`, `router`, `loader` — says so in its `AGENTS.md`, and advisors (the intelligence layer) are never consulted for access decisions at all.',
)}
${callout('warn', 'Rule', 'Never treat `allow` as authorization, never skip a server check because the client gate allowed it, and never ship data a user may not see on the assumption that the gate hides it.')}

${h2('Where to go next')}
<ul class="cards">
  <li><a class="card" href="${href('before-after/')}"><h3>Before / After</h3><p>Everyday problems, side by side with the StaticFlux way.</p></a></li>
  <li><a class="card" href="${href('getting-started/')}"><h3>Get started</h3><p>Compose an app from units, add a feature, a route, a component, a test.</p></a></li>
  <li><a class="card" href="${gh('docs/REQUIREMENTS.md')}"><h3>Requirements</h3><p>Every requirement ID (R2.1 … R21.2) the packages trace to.</p></a></li>
</ul>
${readMore('core', 'runtime', 'gate')}
`;
}

export const philosophyPage: Page = {
  path: 'philosophy/',
  title: 'Philosophy',
  description: 'The ten StaticFlux principles and why: inversion of control, composition over inheritance, performance first, an agent-first codebase, enforcement over convention, and client gating as UX — not security.',
  nav: 'philosophy',
  layout: 'doc',
  toc: true,
  hero: {
    eyebrow: 'Philosophy',
    title: 'Static core. Flux implementations.',
    lede: 'A small, stable, versioned core of contracts — and everything else as plugins. Ten principles keep it that way, and tooling keeps the principles honest.',
  },
  body,
};
