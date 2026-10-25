/**
 * Guides per area. Concise and accurate: every API named here is exported by the package
 * it is attributed to; each guide links to the package AGENTS.md files for the full surface.
 */
import { callout, code, h2, list, readMore } from '../components.js';
import { html, md, paras, type Raw } from '../html.js';
import type { Page, SidebarGroup } from '../layout.js';
import { gh, href } from '../site.js';

interface Guide {
  readonly slug: string;
  readonly title: string;
  readonly short: string;
  readonly summary: string;
  readonly packages: readonly string[];
  readonly lede: string;
  readonly body: () => Raw;
}

// ------------------------------------------------------------------ core & DI

const coreDi: Guide = {
  slug: 'core-di',
  title: 'Core & dependency injection',
  short: 'Core & DI',
  summary: 'Tokens, units, the readiness-aware injector, dependency kinds, scopes, variants and compile-time completeness.',
  packages: ['core'],
  lede: 'The fabric every package builds on: typed tokens, units that declare what they require and provide, and a hierarchical injector that knows the difference between “created” and “ready”.',
  body: () => html`
${h2('Tokens and units')}
${paras(
  'A **token** is a typed identity: `token(\'pkg/name\').type<T>()` for one value, `.multi<T>()` for a contribution list (routes, menu items, telemetry sinks). The string id is namespaced, type-checked and used for devtools — there are no string lookups at runtime.',
  'A **unit** declares `provides`, `scope`, `deps` and a synchronous `create`. Optional `init` makes it *ready* asynchronously (single-flight, cached, retried by `retry`), `refreshOn` re-runs it when a token or the app epoch refreshes, and `critical: true` makes boot wait for it.',
)}
${code(`
  import { err, toSfError, token, unit } from '@staticflux/core';

  export const DocRuntimeToken = token('app/doc-runtime').type<DocRuntimeHolder>();

  export const docRuntimeUnit = unit({
    id: 'app/doc-runtime-unit',
    provides: DocRuntimeToken,
    scope: 'app',
    deps: { required: { client: DataClientToken, supervisor: SupervisorToken } },
    // Capture deps in create (synchronous, cheap, no I/O) …
    create: ({ client, supervisor }, ctx): DocRuntimeHolder => {
      const holder: DocRuntimeHolder = {
        current: undefined,
        async load(signal) {
          const chunk = await import('./doc-runtime.js');   // heavy code stays off the boot path
          if (signal.aborted) return err(toSfError(signal.reason));
          holder.current = chunk.createRuntime({ client, telemetry: ctx.telemetry, scope: ctx.scope });
          return supervisor.register(holder.current.subsystem);
        },
      };
      return holder;
    },
    // … use them in init, through the instance. init makes the unit ready (or fails it).
    init: (holder, ctx) => holder.load(ctx.signal),
    retry: { attempts: 3 },
  });
`, { file: 'the create → init pattern (packages/core/AGENTS.md)' })}

${h2('Three kinds of dependency')}
<div class="prose-table"><table>
  <thead><tr><th>Kind</th><th>You receive</th><th>Semantics</th><th>Default init</th></tr></thead>
  <tbody>
    <tr><td><code>required</code></td><td><code>T</code></td><td>Must be ready before this unit is created (components call it <code>render</code>: placeholder until ready)</td><td><code>eager</code></td></tr>
    <tr><td><code>lazy</code></td><td><code>DepHandle&lt;T&gt;</code></td><td>Arrives any time; reactive <code>state</code> / <code>value</code>; <code>whenReady()</code></td><td><code>on-arrival</code></td></tr>
    <tr><td><code>functional</code></td><td><code>FunctionalDep&lt;T&gt;</code></td><td>Resolved and initialized on first <code>get()</code>; <code>prewarm()</code> on intent</td><td><code>on-demand</code></td></tr>
  </tbody>
</table></div>
<p>${md('Override timing per dependency: `{ token, init: \'idle\' | \'on-visible\' | \'on-intent\' | … }`. Hooks let a consumer act on a dependency inside a scope that is disposed when the consumer goes away **or** the dependency refreshes:')}</p>
${code(`
  create: ({ presence }, ctx) => {
    const count = box(0);
    // re-runs against the fresh instance after every refresh, in a fresh child scope
    ctx.onReady(presence, (feed, scope) => {
      scope.defer(feed.subscribe((n) => count.set(n)));
    });
    return { count };
  },
`)}

${h2('Scopes, levels and the injector tree')}
${paras(
  'Scope levels run from longest- to shortest-lived: `app → session → workspace → route → feature → view → component`. `injector.child(level, name, units)` creates a child injector; a longer-lived unit can never hold a shorter-lived one (SF-DI-002), and cycles are rejected with the path (SF-DI-004). Logging out disposes the session injector and everything in it.',
  'Every instance owns a `Scope` (`ctx.scope`): `defer` cleanups, `use` disposables, `listen` to events, `child` scopes, and a `signal` that aborts when the scope is disposed.',
)}

${h2('Overrides and variants')}
${code(`
  import { bind, variant } from '@staticflux/core';

  const units = [
    rankerUnit,                                                        // package default
    bind(fastRankerUnit, { precedence: 'app', source: 'app config' }), // app override
    variant({ of: RankerToken, unit: rankerBUnit, when: () => cohort === 'B' }), // experiment
  ];
  // precedence: experiment > workspace > app > default — and every override shows in devtools
`)}
<p>${md('In apps, experiments come from flags through `@staticflux/config`’s `createFlagBinder().variants(...)`, so feature code never reads a flag.')}</p>

${h2('Compile-time completeness')}
${code(`
  import { composeUnits, defineModule } from '@staticflux/core';

  export const appUnits = composeUnits([docsUnit, dataClientUnit /* missing: transport */]);
  //  ✗ Property '__missingProviders' is missing … "data/transport"

  // a package or feature module declares what its host must provide
  export const docsModule = defineModule({ id: 'docs/module', units: [docsUnit], external: [DataClientToken] });
`)}

${h2('Results, Tasks and machines')}
${list([
  '`Result<T, E>` with `ok` / `err` / `attempt` / `attemptAsync`; errors are `SfError`s from `defineError(code, kind, summary, fix)`.',
  '`Task<T>` = `(signal) => Promise<Result<T>>`, composed with `retry`, `timeout`, `createSingleFlight`, `createLimiter`, `createCircuitBreaker`, `settleAll`, `anySignal`, `sleep`.',
  'Every lifecycle is `defineMachine({ id, initial, states, transitions, terminal })` run by `createMachine` — reactive state, `can(event)`, invalid transitions return `SF-CORE-010` instead of corrupting state.',
  'Telemetry: `createTelemetry({ defaultLevel, levels })` with levels `off | critical | standard | verbose | debug` per subsystem, spans, events and typed `metric.*` declarations.',
  'Reactivity: `box`, `derived`, `effect`, `watch`, `batch`, `untracked` — MobX 7 behind a thin port.',
])}
${callout('rule', 'Rules', 'Never stash deps in module-level variables; keep `create` synchronous and cheap; every new error goes through `defineError` with a concrete `fix`; every lifecycle is a machine mirrored in `docs/LIFECYCLES.md`.')}
${readMore('core', 'testkit')}
`,
};

// ------------------------------------------------------------------ lifecycles

const lifecycles: Guide = {
  slug: 'lifecycles',
  title: 'Lifecycles & the runtime',
  short: 'Lifecycles',
  summary: 'App supervisor, subsystems with restart policies, features with independent logic/UI lifetimes, retention, the frame scheduler, worker scheduling and memory ledgers.',
  packages: ['runtime'],
  lede: 'Every lifecycle in StaticFlux is a typed finite state machine. The runtime supervises the app, its subsystems and its features — and the state you are in decides which operations even exist.',
  body: () => html`
${h2('The app is a supervisor')}
${code(`
  starting → core-ready → running ⇄ degraded
                           running ⇄ paused
              running|degraded|paused → reinitializing → core-ready
              any → shutting-down → terminated
`, { lang: 'text', file: 'docs/LIFECYCLES.md §1' })}
${paras(
  '`bootApp({ units, telemetry, subsystems })` resolves critical units, starts critical subsystems and returns a `Result<App>`. The supervisor broadcasts app-wide commands in dependency order (reverse for teardown): `pause`, `resume`, `abort` (one root signal cancels everything in flight), `refresh` (an epoch bump — stale data is revalidated and late responses dropped, no reload), `reinitialize` (back to core and re-boot, no reload) and `shutdown`.',
  'Subsystems declare `dependsOn` and a `restart` policy (backoff, `maxRestarts` per `windowMs`). A subsystem that gives up moves the app to `degraded` and its dependents are told they are impaired. Features may *request* commands (`supervisor.request`); a command policy decides.',
)}
${code(`
  import { defineSubsystem } from '@staticflux/runtime';

  export const syncSubsystem = defineSubsystem({
    id: 'app/background-sync',
    dependsOn: ['router/navigation'],
    restart: { maxRestarts: 3, windowMs: 60_000 },
    start: async (ctx) => queue.connect(ctx),
    pause: () => queue.hold(),
    resume: () => queue.release(),
    refresh: async (epoch) => queue.resetFor(epoch),
    stop: () => queue.close(),
  });
`)}

${h2('Features: logic and UI live separately')}
${code(`
  declared → loading → loaded → activating → activated
  activated → mounting → mounted ⇄ hidden
  mounted|hidden → unmounting → activated            (logic stays warm)
  activated → deactivating → loaded                  (logic disposed)
  loaded → archived (heavy: snapshot persisted) | evicted
`, { lang: 'text', file: 'docs/LIFECYCLES.md §6' })}
${paras(
  'A feature is `defineFeature({ id, weight, retention, modes, budget, readiness, load })` plus a module from `defineFeatureModule({ units, activate, mount, visible, hide, unmount, snapshot, restore })`. The logic scope contains the UI scope, which contains the visible scope — so a mounted feature always has live logic (I-5), and `hidden` keeps DOM and state while dropping effects.',
  'Weight classes set the default demotion: `cheap` features are recreated, `warm` keep logic alive, `heavy` ones archive a snapshot (to any `AsyncStore`) and rehydrate fast. The resource manager enforces budgets on memory pressure and device tier — framework budgets win over feature preferences — and never demotes a feature in use. Dependencies between features are ref-counted (I-6).',
)}

${h2('Frame scheduler')}
<p>${md('`createFrameScheduler()` coalesces updates into one flush per frame, separates `measure` and `mutate` phases (no layout thrashing), runs prioritized `postTask` work (`interaction | critical | visible | idle`), offers `yieldToMain` and `idleUntilUrgent`, and falls back where `scheduler.postTask` / `yield` are missing (Safari).')}</p>

${h2('Workers: scheduling and memory ledgers')}
<p>${md('Inside workers, `@staticflux/runtime/worker` gives the same priorities without frames: `createWorkerScheduler()` slices synchronous work into 8 ms tasks (`postTask`, `yield`, `shouldYield`), and `createLongTaskDetector` reports tasks over 50 ms. `@staticflux/runtime/memory` is a per-thread **cache memory ledger** for render, media and export workers: caches register with an `evict` callback and report their bytes; over budget — or when memory pressure rises — the ledger evicts lower priorities first, synchronously, before the resource manager demotes any feature.')}</p>
${code(`
  import { createMemoryBudgets, MiB } from '@staticflux/runtime/memory';

  const memory = createMemoryBudgets({ budgets: { gpu: 512 * MiB }, pressure });
  const tiles = memory.register({ id: 'render/tiles', kind: 'gpu', evict: (bytes) => cache.evict(bytes) });
  if (!tiles.ok) return tiles;
  tiles.value.report(cache.bytes);            // after every change; headroom() before a big allocation
`)}
${callout('note', 'Invariants', 'I-1 nothing executes in `paused` except the resume path · I-5 mounted ⇒ activated · I-6 a feature cannot deactivate while a dependent is mounted. Each has an error code (`SF-APP-001`, `SF-FT-001`, `SF-FT-002`).')}
<p><a class="link-arrow" href="${gh('docs/LIFECYCLES.md')}">All lifecycles, transitions and invariants</a></p>
${readMore('runtime', 'core')}
`,
};

// ------------------------------------------------------------------ routing & URL state

const routing: Guide = {
  slug: 'routing',
  title: 'Routing & URL state',
  short: 'Routing & URL state',
  summary: 'The 13-stage navigation pipeline, typed routes, exit guards, view sub-routes, routable dialogs, URL bindings and consume-once intents.',
  packages: ['router', 'urlstate', 'handoff'],
  lede: 'Navigation is an async, cancellable pipeline of named stages; the URL is a set of declared parts, each with a kind and an owner. The router never renders and never interprets requirements — plugins do.',
  body: () => html`
${h2('The pipeline')}
${code(`
  resolve → exit → availability → transient → pre-auth → auth-boundary → post-auth
          → authorize → load → prefetch → enter → render → commit
`, { lang: 'text' })}
${list([
  'Each stage is a span; plugins attach with `stagePlugin` and return `proceed()`, `redirect(target)`, `block(error)` or `cancel(reason)` as a `Result`.',
  'The newest navigation cancels older ones; uninterruptible guards hold cancellation until they settle.',
  'Back / Forward run the same pipeline (Navigation API, History API fallback, memory history for embedded hosts) and are reverted if blocked.',
  'Code for a route loads only after `auth-boundary` and `authorize` pass — a denied feature’s chunk is never fetched.',
])}

${h2('Typed routes and capabilities')}
${code(`
  export const DocRoute = defineRoute({
    id: 'studio/doc',
    parent: StudioRoute,                 // nested: per-segment guards and chunks
    path: 'doc/:id',                     // params inferred from the template
    search: { tab: searchParam.enum(['content', 'comments', 'history'], { default: 'content', kind: 'view' }) },
    feature: bindCapability('studio/editor', [
      { feature: Features.studioDesktop, modes: ['expanded', 'medium'] },
      { feature: Features.studioMobile, modes: ['compact'] },   // per-mode variants are features
    ]),
  });

  await router.navigate({ to: DocRoute, params: { id: '42' }, search: { tab: 'comments' } });
`)}
<p>${md('`view: true` routes and view-kind search params run a light pipeline (`exit → enter → commit`) — wizard steps and tabs never reactivate the feature. Route requirements are an open interface (`RouteRequirements`, declaration-merged): auth and gate plugins read `ctx.requires`.')}</p>

${h2('Exit guards')}
${code(`
  router.guardExit(DocRoute, guard(async (_navigation, signal) => {
    const flushed = await doc.flush(signal);
    return flushed.ok ? proceed() : err(flushed.error);
  }, { uninterruptible: true, name: 'studio/save-before-leave' }), context.uiScope);
`)}

${h2('Routable dialogs')}
<p>${md('Dialogs live at `/d/<key>` (app level) or `<feature path>/d/<key>` and run `exit → availability → authorize → load → enter → commit`. `defineDialog({ id, key, owner, requires })` on the router side, a `routable` surface on the messaging side; dismissing goes back when opened in-app and replaces to the parent when arrived via deep link.')}</p>

${h2('URL state: kinds and owners')}
<div class="prose-table"><table>
  <thead><tr><th>Kind</th><th>Example</th><th>Owner</th><th>Handled by</th></tr></thead>
  <tbody>
    <tr><td>path</td><td><code>/studio/doc/42</code></td><td>router</td><td>full pipeline</td></tr>
    <tr><td>view</td><td><code>?tab=comments</code></td><td>feature store</td><td><code>createUrlSync</code></td></tr>
    <tr><td>dialog</td><td><code>…/d/share</code></td><td>messaging</td><td>dialog bridge</td></tr>
    <tr><td>intent</td><td><code>?panel=chat&amp;prompt=…</code></td><td>declaring feature</td><td><code>createIntentService</code></td></tr>
    <tr><td>sticky</td><td><code>?workspace=…&amp;lang=…</code></td><td>declaring package</td><td><code>createUrlSync</code></td></tr>
    <tr><td>hidden</td><td>scroll, drafts</td><td>store / handoff</td><td>never in the URL</td></tr>
  </tbody>
</table></div>
${code(`
  declare module '@staticflux/core' {
    interface Registry { urlParams: { tab: 'content' | 'comments' | 'history'; prompt: string; panel: 'chat' } }
  }

  export const TabBinding = defineUrlBinding({
    key: 'tab', kind: 'view', codec: codec.enum(['content', 'comments', 'history']),
    owner: 'studio/document-store', default: 'content',
  });
  urlSync.bind(TabBinding, boxAdapter(store.tab), scope);   // URL ⇄ store, batched per frame

  // consume-once intent: digested at resolve, delivered after authorize, stripped via replace
  export const ChatPromptIntent = defineIntent({
    id: 'agent/chat-prompt', owner: 'agent/chat',
    params: { panel: codec.enum(['chat']), prompt: codec.string({ maxLength: 2000 }) }, required: ['panel'],
  });
  intents.consume(ChatPromptIntent, (delivery) => chat.setDraft(delivery.params.prompt ?? ''), scope);
`)}
${callout('rule', 'Intents prefill, they never execute', 'A URL is attacker-controlled input. `IntentDelivery.execute()` refuses unless the intent is declared `safe` (I-13, SF-URL-001). Intents survive login redirects through `@staticflux/handoff` slots.')}
${callout('warn', 'Client gating is UX', 'Route guards decide what to show and load. The server re-checks every request.')}
${readMore('router', 'urlstate', 'handoff')}
`,
};

// ------------------------------------------------------------------ auth, gating & credits

const authGating: Guide = {
  slug: 'auth-gating',
  title: 'Auth, gating & credits',
  short: 'Auth, gating & credits',
  summary: 'Identity providers and the session machine, facts → policies → decision tables, agents as subjects, meters with reserve → commit.',
  packages: ['auth', 'gate', 'config'],
  lede: 'One session model for every identity provider; one gate that turns facts into explainable, O(1) decisions at every level — app, workspace, route, feature, capability, UI slot.',
  body: () => html`
${callout('warn', 'Client gating is UX, not security', 'Decoded claims, session JSON and gate decisions are advisory. They decide what to render, which chunks to load and which calls to attempt. **The server validates and re-checks every request.**')}

${h2('Sessions')}
${code(`
  guest → authenticating → authenticated ⇄ refreshing
  authenticated → expired | revoked → guest | authenticating
`, { lang: 'text', file: 'docs/LIFECYCLES.md §9' })}
${list([
  'Providers: `bffCookieProvider` (recommended — tokens stay in the BFF), `oidcPkceProvider` (tokens in memory only), `passkeyProvider`, `embedHostProvider` (the host owns OAuth; the widget never holds a token), `customProvider`, `guestProvider`.',
  '**Guest and logged-in are the same app**: boot never waits on auth; `auth-boundary` route guards await `session.whenSettled()`.',
  '`refresh()` is single-flight (optionally under a Web Lock); state syncs across tabs over BroadcastChannel; `createAuthorizedTransport` adds grant headers and turns a 401 into one refresh and one retry.',
  'A session change with `requiresEpochRefresh` triggers an app-wide refresh through a contributed `SessionListener`; `createSessionScope` gives each principal a session injector that logout disposes.',
])}
${code(`
  const auth = [
    bffCookieProviderUnit({ endpoints: BFF_ENDPOINTS, csrf: { header: CSRF_HEADER } }),
    createSessionUnit({ channelName: 'studio/session' }),
    epochRefreshListenerUnit,        // SessionListenersToken → supervisor.refresh()
    guestDraftUpgradeHookUnit,       // GuestUpgradeHooksToken → handoff carries the guest draft
  ];
`, { file: 'apps/studio/src/app/compose.ts (abridged)' })}

${h2('Facts → policies → decisions')}
${code(`
  export const studioPolicies = definePolicySet('studio/policies', [
    definePolicy({
      id: 'studio/route-requires-login',
      resource: { level: 'route', ids: ['route:/studio'] },
      when: fact(GateFacts.authenticated).truthy(),
      deny: { reason: 'login' },
    }),
    definePolicy({
      id: 'studio/summarize-pro',
      resource: { level: 'capability', ids: ['studio/summarize'] },
      when: fact(GateFacts.plan).eq('pro'),
      deny: { reason: 'upgrade', meta: { plan: 'pro' } },
    }),
    definePolicy({                                   // agents are distinct, narrower subjects
      id: 'studio/agent-insert-image',
      subjects: ['agent'],
      resource: { level: 'capability', ids: ['agent/insert-image'] },
      when: fact(GateFacts.authenticated).truthy(),
      cost: { meter: CreditsMeter, amount: 2 },      // allow-with-cost
    }),
  ]);

  const decision = gate.decide('capability', 'studio/summarize');       // sync, O(1), reactive
  if (decision.effect === 'deny') openUpsell(decision.reason, decision.alternatives);
  const why = gate.explain('capability', 'studio/summarize');           // devtools: "why?"
`)}
${paras(
  'Policies are JSON-serializable data compiled to decision tables with a fact → entry reverse index, so a fact change recomputes only the affected decisions. Permits are OR-ed, any matching forbid wins, missing facts fail closed. Remote overrides (`applyRemote`) gate a cohort without a deploy and are validated all-or-nothing. Facts come from plugins — session, plan, entitlements, flags (`flagFact`), platform — and the gate imports none of their owners.',
)}

${h2('Meters: credits, quotas, rates')}
${code(`
  export const CreditsMeter = defineMeter('billing/credits', { unit: 'credits', mode: 'balance', lowThreshold: 3, reservationTtlMs: 60_000 });

  const meter = meters.get(CreditsMeter);
  if (!meter.ok) return meter;
  const hold = await meter.value.reserve(2, { signal });   // estimating → reserved | denied(quota)
  if (!hold.ok) return hold;
  const result = await runAgentCall(signal);
  if (result.ok) await hold.value.commit(result.value.cost); else await hold.value.release();
`)}
<p>${md('The server balance is authoritative (`setServerState`); the client view is optimistic. Low balance and exhaustion surface through messaging, and the capability pipeline reserves and commits for you. Flags (`@staticflux/config`) feed the gate as facts and DI as variant bindings — layered `default < app < workspace < remote < experiment < local override`, OpenFeature-compatible without the SDK.')}</p>
${readMore('auth', 'gate', 'config', 'handoff')}
`,
};

// ------------------------------------------------------------------ data & storage

const dataStorage: Guide = {
  slug: 'data-storage',
  title: 'Data & storage',
  short: 'Data & storage',
  summary: 'Transports, endpoints and resources with SWR, the single retry layer, schema-first stores with patches, user-data slices, and one async storage interface.',
  packages: ['data', 'storage'],
  lede: 'Transport-agnostic data with exactly one retry layer, caches keyed by epoch, stores whose patches replicate to workers — on top of a single async key-value interface for every backend.',
  body: () => html`
${h2('Endpoints and the client')}
${code(`
  export const DocGetEndpoint = defineEndpoint({
    id: 'docs/get',
    path: (input: { readonly id: string }) => \`/docs/\${input.id}\`,
    response: DocumentSchema,                    // s.object({ … }) — decoded and validated
  });

  const doc = await client.call(DocGetEndpoint, { id: '42' }, { signal });   // Promise<Result<Doc>>
`)}
<p>${md('Per call: a `data/request` span with `traceparent` → per-endpoint circuit breaker → `retry` (full jitter; idempotent endpoints by default) → per attempt: pause gate, timeout, transport, schema decode, epoch check. **Transports never retry and resources never retry** — the client is the only retry layer. Transports: fetch (JSON + NDJSON), SSE, WebSocket, host bridge, worker port and a mock with latency, failures and offline mode.')}</p>

${h2('Resources: SWR, pagination, batching, streams')}
${code(`
  export const DocResource = defineResource({ id: 'docs/get-resource', endpoint: DocGetEndpoint, key: (input) => [input.id] });
  export const ProfilesResource = defineBatchedResource<string, readonly Profile[], Profile>({
    id: 'users/profiles-resource', endpoint: UserBatchProfilesEndpoint,
    pick: (response, key) => response.find((p) => p.id === key), keyId: (key) => key, staleTimeMs: 60_000,
  });

  const handle = resources.query(DocResource, { id: '42' });  // reactive: status, data, error
  // status: idle | loading | ready | refreshing | error — refreshing keeps the last data (SWR)
`)}
<p>${md('Paginated (`cursorPagination` / `offsetPagination`), batched (DataLoader-style coalescing), streamed and subscription resources share the cache. After an app refresh the epoch bumps: active resources revalidate and responses tagged with an old epoch are discarded (I-10). `mutate` + `optimistic(…)` rolls back on failure.')}</p>

${h2('Schema-first stores with patches')}
${code(`
  export const ChatStore = defineStore({
    id: 'agent/chat',
    version: 1,
    schema: ChatStateSchema,
    initial: (): ChatState => ({ messages: [], draft: '', status: 'idle' }),
    actions: {
      append(state: ChatState, message: ChatMessage) { state.messages.push(message); },
      setDraft(state: ChatState, text: string) { state.draft = text; },
    },
  });
  const owner = ChatStore.create();      // the owner; .replica({ sink }) on other threads
`)}
<p>${md('Actions are synchronous, touch only a draft and roll back entirely on throw; state is frozen plain data. Each outermost action emits one versioned `PatchMessage` — the format `@staticflux/worker` replicates and hydration snapshots.')}</p>

${h2('User-data slices')}
${code(`
  export const ThemeSlice = defineSlice({
    key: 'settings/theme', scope: 'user', version: 1,
    schema: s.object({ mode: s.enum(['system', 'light', 'dark', 'high-contrast']) }),
    default: () => ({ mode: 'system' as const }),
  });
  const theme = userData.slice(ThemeSlice);     // reactive value, batched flushes, migrations
  theme.set({ mode: 'dark' });
`)}
<p>${md('Slices are scoped `device | user | workspace | session`, versioned with migrations on read (a failed migration yields defaults and a report — never a crash), conflict-resolved per slice, budgeted, and wiped on logout by default.')}</p>

${h2('One async storage interface')}
${code(`
  const store = createStore<Prefs>({
    backend: [createIndexedDbStore({ namespace: 'prefs' }), () => createMemoryStore()],
    middleware: [withBudget({ maxBytes: 64_000 })],
  });
  // AsyncStore: get · set · delete · has · clear · seek · batch · watch — all Promise<Result>
`)}
<p>${md('Adapters: memory, localStorage / sessionStorage, cookies, IndexedDB, OPFS, remote. Middleware returns the same interface: `namespaced`, `withTtl`, `withCodec` (JSON, versioned envelope, binary), `encrypted` (AES-GCM, key rotation), `withBudget`, `withTelemetry`, `tiered` (write-through / write-back), `fallback`. Slices, handoff, feature archives and advisor history all accept an `AsyncStore` through their `*FromStore` adapters. Large immutable content — images, video, document parts — goes to the content-addressed `@staticflux/blob` store instead (see the editors guide).')}</p>
${callout('rule', 'No synchronous storage', 'There is no synchronous storage API anywhere in the framework, so any layer can be swapped later. Never store tokens or secrets in cookies or Web Storage — encryption at rest is not protection from page script.')}
${readMore('data', 'storage', 'handoff')}
`,
};

// ------------------------------------------------------------------ threads

const threads: Guide = {
  slug: 'threads',
  title: 'Workers, documents, Wasm & surfaces',
  short: 'Workers, docs, Wasm, surfaces',
  summary: 'Supervised workers and typed protocols, read-only replicas, the CRDT document engine, Wasm modules as units, render workers and rich surfaces.',
  packages: ['worker', 'document', 'wasm', 'surface'],
  lede: 'Heavy work runs off the main thread by default — supervised, replicated, traced end to end, and with a fallback for every browser gap.',
  body: () => html`
${h2('Supervised workers and typed protocols')}
${code(`
  export const DocumentWorkerProtocol = defineProtocol({
    id: 'studio/document-worker',
    version: 1,
    requests: { open: request<OpenArgs, { readonly entities: number }>({ idempotent: true }) },
    events: { archived: event<{ readonly docId: string; readonly archive: DocumentArchive }>() },
  });

  const worker = createSupervisedWorker({
    id: 'studio/document-worker',
    protocol: DocumentWorkerProtocol,
    spawn: dedicatedWorkerSpawner(() => new Worker(new URL('./document.worker.ts', import.meta.url), { type: 'module' })),
    contexts,                                 // session, flags, decisions, platform → every worker
    replicas: [replica, presence],
    rehydrate: () => lastArchive,             // state restored after a respawn
    heartbeat: { intervalMs: 5_000, timeoutMs: 4_000, maxMissed: 3 },
    restart: { intensity: 3, periodMs: 60_000, baseDelayMs: 50 },
    fallback: { description: 'Read-only view', activate: () => readOnly.set(true), deactivate: () => readOnly.set(false) },
  });
  const opened = await worker.request('open', { docId: '42', blocks }, { signal });
`, { file: 'apps/studio/src/adapters/document-worker.ts (abridged)' })}
${list([
  'Worker lifecycle: `spawning → handshaking → ready ⇄ busy`, heartbeat-based `unresponsive`, `crashed → respawning` with backoff, `failed` (fallback activated, app degraded) when the intensity is exceeded. Throttled background tabs recover instead of respawning.',
  '**One owner per store; replicas never mutate** (I-9): `replica.intent(action, args)` sends writes to the owner, patches come back batched per frame; a gap or epoch mismatch resnapshots.',
  'Every envelope carries `traceparent` — worker telemetry joins the main timeline. Raw tokens are not replicated; a token broker executes authorized calls on the owning side.',
  'Multi-tab: `createTabCoordinator` (SharedWorker or leader tab via Web Locks + BroadcastChannel, with numbered terms) from `@staticflux/worker/coordinator`.',
])}

${h2('The document engine')}
<p>${md('`@staticflux/document` runs inside the document worker. **v1** (used by Studio): an ECS world (entities, structure-of-arrays component stores, queries, systems) materialized from a `DocumentCRDT` (Yjs behind an interface), a `DocumentEngine` that is itself a replicable store, presence, a collaboration transport contract with an in-memory mock, and snapshot / restore for archives and respawn. **v2** (`@staticflux/document/v2`): one CRDT document per page behind the engine-neutral `DocumentCRDTv2` port, a `DocumentRepo` with one commit per gesture, versioned components, a Loro engine, a binary render projection and a spatial index. The main thread holds only a projection — no CRDT library in the main bundle.')}</p>
<p><a class="link-arrow" href="${href('guides/editors/')}">Document v2, the stage and the editor ↔ render pipeline</a></p>

${h2('Wasm as worker-scoped units')}
${code(`
  export const ImageCodec = defineWasmModule<ImageCodecExports>({
    id: 'media/image-codec',
    source: { chunk: 'wasm:image-codec' },              // a logical chunk: gated, warmed, budgeted
    features: { required: ['simd'] },
    variants: [{ id: 'threads', source: { chunk: 'wasm:image-codec-mt' }, requires: ['threads'] }],
    budget: { bytes: 400_000, compileMs: 80 },
  });
  export const imageCodecUnit = wasmModuleUnit({ id: 'media/image-codec-unit', provides: ImageCodecToken, module: ImageCodec });
`)}
<p>${md('Feature facts (SIMD, threads, memory64, exceptions, GC) come from `WebAssembly.validate` probes plus cross-origin isolation; threaded builds are picked only when shared memory is actually usable, otherwise the next variant. Instantiation is the unit’s `init` (`compileStreaming`, with an ArrayBuffer fallback). Main-thread Wasm needs an explicit `allowMainThread: { reason, budgetMs }`.')}</p>

${h2('Rich surfaces')}
<p>${md('`@staticflux/surface` gives DOM, Canvas2D, WebGL, WebGPU and HTML-in-Canvas one `Surface` contract. Engines (`RenderEngine`: `init`, `frame`, `resize`, `input`, `dispose`) never touch the DOM, so the same engine runs in a render worker via a transferred `OffscreenCanvas` (`createWorkerSurface` / `hostRenderSurfaces`) or on the main thread. Input is forwarded as compact timestamped events and becomes intents where the state lives; pure-canvas content gets a parallel accessible DOM layer; per-surface frame metrics carry budgets. Tiled GPU raster (`/raster`), canvas text input (`/text-input`) and image scaling (`/image`) are separate entries, covered in the editors guide.')}</p>
${callout('note', 'Isolation is a per-app choice', 'Apps declare `isolation: required | preferred | off`. Channels, Wasm builds and features select shared-memory or transfer paths automatically; embedded hosts always fall back. See `@staticflux/platform` isolation and the Vite plugin’s dev COOP/COEP headers.')}
${readMore('worker', 'document', 'wasm', 'surface', 'platform')}
`,
};

// ------------------------------------------------------------------ editors

const editors: Guide = {
  slug: 'editors',
  title: 'Editors: pipeline, documents, stage, blobs & raster',
  short: 'Editors & canvases',
  summary: 'The editor ↔ render pipeline, document v2 with one CRDT doc per page, the composed stage and per-actor undo, a content-addressed blob store, GPU raster, text input and images.',
  packages: ['worker', 'document', 'stage', 'blob', 'surface'],
  lede: 'The ports a local-first editor with a GPU canvas needs, as framework packages: a pipeline between editor and renderer, documents split into parts, a composed stage with per-actor undo, and a content-addressed store underneath. Instaflow drove them; none of them knows about it.',
  body: () => html`
${h2('The editor ↔ render pipeline')}
${paras(
  '`@staticflux/worker/pipeline` is a set of topology-neutral pipes. Every pipe runs on three **media** with the same code: `local` (both ends in one worker), `shared` (SharedArrayBuffer + Atomics, isolated pages) and `message` (each side mirrors the region, changes are posted in order). `selectMedium({ topology })` picks one, so one worker or two is a boot setting, not a code path.',
  'Deltas are sequenced: each record carries `base → version`, and the reader applies them in order. A gap, an epoch change or a missing blob moves the reader to `resyncing` and asks the writer for a snapshot; the writer answers in `onResnapshot`. The renderer draws what has arrived — it never waits on, or guesses past, a hole.',
)}
${code(`
  import { acceptPeer, attachDeltaStream, createDeltaStream, createPeerBroker, defineDeltaStream, definePeer,
    isRegionEndpoint, selectMedium, workerHost } from '@staticflux/worker/pipeline';

  export const EditorRender = definePeer('app/editor-render');
  export const Scene = defineDeltaStream({ id: 'app/scene', capacityBytes: 1 << 20 });
  const SceneEndpoint = 'app/scene-endpoint' as const;

  // editor worker: owns the stream, re-sends its endpoint on every (re)connection
  const deltas = createDeltaStream(Scene, { medium: selectMedium({ topology: boot.topology }) });
  if (!deltas.ok) return deltas;
  deltas.value.onResnapshot(() => deltas.value.snapshot({ version, payload: encodeScene() }));
  deltas.value.append({ version: ++version, payload: encodeChange(change) });
  acceptPeer(runtime.link, EditorRender).onConnect((link) => {
    const endpoint = deltas.value.endpoint();
    if (endpoint.ok) link.send(SceneEndpoint, endpoint.value);
  });

  // render worker: attach, then apply up to the version the view-state frame shows
  acceptPeer(runtime.link, EditorRender).on(SceneEndpoint, async (endpoint) => {
    if (!isRegionEndpoint(endpoint)) return;
    const attached = await attachDeltaStream(Scene, endpoint);  // awaiting-snapshot → live ⇄ resyncing
    if (attached.ok) reader = attached.value;
  });
  // every vsync: apply what arrived, up to the version the view-state frame shows
  reader?.apply(applyToScene, { upTo: viewFrame.docVersion });

  // main thread: the broker wires the two workers and re-wires after a respawn
  createPeerBroker().connect(EditorRender, workerHost(editorWorker), workerHost(renderWorker));
`, { file: 'pipeline wiring (abridged)' })}
${list([
  '**View-state frames**: `defineCell` / `createCell` / `attachCell` — a seqlock cell; `read()` returns a private stable copy, torn reads are detected and retried.',
  '**Input ring**: lossless SPMC record rings (`defineRecordRing`); `@staticflux/surface/input-ring` puts forwarded pointer, pen and key events on one (`inputRingSink`) and each reader coalesces on its own (`drainInputRing({ coalesce })`).',
  '**Blobs by digest**: `createBlobSender` / `createBlobReceiver` move large payloads once; a delta that `refs` a blob never applies before it.',
  '**Brokered peer channels**: `createPeerBroker` connects two workers directly; `onConnect` runs on every (re)connection, so a respawned reader gets a fresh endpoint and asks for a snapshot.',
  '**Handles** (`createHandleLedger`, `Owned<T>`) account for every transferred platform handle; leaks are reported and closed with the scope.',
])}

${h2('Documents v2: one CRDT doc per page')}
${paras(
  'The v1 engine — an ECS world over a Yjs-backed `DocumentCRDT` — still runs Studio. Large editors use **v2** (`@staticflux/document/v2`): an asset is split into **parts**, one CRDT document per page plus a small document-level part, each behind the engine-independent `DocumentCRDTv2` port. The Loro engine (`@staticflux/document/loro-crdt`) is the implementation, worker only, its Wasm in its own budget; `adaptToV1` moves a v1 engine onto it.',
  '`createDocumentRepo` opens assets once (single-flight), loads parts lazily, persists snapshots plus one append-only commit log through the `DocumentStore` port, and compacts incrementally. Edits go through the repo: `commit(meta, { [part]: ops })`, `moveAcross` for a cross-page move (one record, both parts), and **one commit per gesture**.',
)}
${code(`
  import { createDocumentRepo, defineComponent, field } from '@staticflux/document/v2';
  import { createLoroEngine } from '@staticflux/document/loro-crdt';

  // versioned components: ids and fields are persisted format — add, or bump with a migration
  export const Spatial = defineComponent('spatial', { x: 'f64', y: 'f64', rotation: 'f64' }, { defaults: { rotation: 0 } });
  export const Style = defineComponent('style', { fill: 'color', blend: field.enum(['normal', 'multiply']) });

  const repo = createDocumentRepo({ store, engine: createLoroEngine() });   // store: any DocumentStore
  const doc = await repo.open('as_42', signal);
  if (!doc.ok) return doc;

  const drag = doc.value.gesture(meta, 'page:p1');        // stage every frame …
  if (!drag.ok) return drag;
  for (const x of pointerXs) drag.value.stage([{ op: 'set', node: 'card', path: 'spatial.x', value: x }]);
  drag.value.commit();                                     // … commit once: one record, one undo step
`)}
<p>${md('Two materialized views feed the pipeline. `@staticflux/document/render-projection` turns part changes into a compact binary scene (`defineRenderProjection`, `createRenderProjector` in the editor worker, `createSceneStore` in the render worker, both checking the projection hash). `@staticflux/document/spatial-index` keeps an rbush index in step with the part (`bindSpatialIndex`) for hit tests and marquee selection. Components generate JSON Schema (`componentJsonSchema`) and milestones are canonical parts (RFC 8785).')}</p>

${h2('The stage and per-actor undo')}
${paras(
  '`@staticflux/stage` composes what an editor, renderer, inspector or agent reads: a layer stack (`session` strongest, then proposal layers, then `local` — the asset), variant, inherit and reference arcs, final paths and locks. `read(node)` returns values with **provenance**, and `explain(node, path)` says which opinion won and which were overridden or ignored. Locks are checked before a write, never after.',
  'The undo service keeps one stack per **actor** — human, agent or flow, attributed from the capability run context. An undo over someone else’s later overwrite is not applied silently: it comes back as a typed conflict, and the user picks `overwrite` or `keep-theirs`.',
)}
${code(`
  import { createPartsDocument, createSessionLayer, createStage, createUndoService, stageWriteGuard } from '@staticflux/stage';

  const root = createPartsDocument('as_42');
  root.attach(page, { id: 'page:p1' });                   // each loaded page part
  const session = createSessionLayer();
  const stage = createStage({ root, session, assets });

  session.set('card', 'spatial.x', 50);                   // a session opinion: wins, never persisted
  stage.explain('card', 'spatial.x');                      // { value, winner, overridden, ignored }

  const undo = createUndoService({ doc, guard: stageWriteGuard(stage) });
  undo.commit(alice, 'Move card', { 'page:p1': [{ op: 'set', node: 'card', path: 'spatial.x', value: 10 }] });
  const outcome = await undo.undo(alice, signal);          // empty | conflict | applied
  if (outcome.ok && outcome.value.kind === 'conflict') showConflicts(outcome.value.conflicts);
`)}

${h2('Content-addressed blobs')}
<p>${md('`@staticflux/blob` is a local-first workspace store: immutable blobs by SHA-256 (whole up to 8 MiB, 4 MiB chunks above, deduped), a few small heads swapped atomically (temp file + `move()` under a Web Lock, compare-and-swap on a generation), an append-only journal that is the only ack point, and a leader tab that owns the writers. It knows nothing about documents; `DocumentRepo` stores its parts and records through it.')}</p>
${code(`
  import { createWorkspaceStore, openOpfsDirectory } from '@staticflux/blob';

  const dir = await openOpfsDirectory(['workspaces', workspaceId]);   // SF-BLOB-009 without OPFS
  if (!dir.ok) return dir;
  const workspace = createWorkspaceStore(dir.value, { lockPrefix: workspaceId, peer });
  if (!workspace.ok) return workspace;                              // Web Locks are required for heads

  const ref = await workspace.value.blobs.put(file.stream(), { mime: file.type, signal });
  if (!ref.ok) return ref;                                          // SF-BLOB-001 on quota
  const head = await workspace.value.blobs.get(ref.value, { range: { start: 0, end: 4096 }, signal });
`)}
${list([
  '`createFolderMirror` mirrors the workspace to a folder the user picked — batched, never on the ack path, read-only (not failing) when permission lapses.',
  '`createZipWriter` / `openZip` write and read bundles; deflate-raw blobs go in byte for byte, and `putEncoded` adopts them on import.',
  '`collectGarbage` sweeps from the catalog (never a directory listing) with a grace period; `requestPersistence` and `checkQuota` cover storage pressure.',
])}

${h2('GPU raster, text input and images')}
${paras(
  '`@staticflux/surface/raster` is the port for tiled GPU rendering in render and export workers. The app supplies a `RasterBackend` (it only draws); the framework decides **which** tiles and **when**: visible tiles first, a 2 ms in-frame raster budget, the rest on an idle lane, stale tiles and snapshots instead of holes, and no raster before `warmUp`. `createGpuDevice` recovers a lost device on a fresh adapter, and every tile cache reports its bytes to the memory ledger.',
)}
${code(`
  import { createTiledRenderer, workerSchedulerLane } from '@staticflux/surface/raster';

  const renderer = createTiledRenderer({
    backend,                                     // any RasterBackend (passes runRasterBackendContract)
    lane: workerSchedulerLane(scheduler),        // tile prep at idle priority, sliced
    requestFrame: () => requestAnimationFrame(draw),
    memory,                                      // @staticflux/runtime/memory ledger (kind 'gpu')
  });
  if (!renderer.ok) return renderer;
  await renderer.value.warmUp(signal);
  renderer.value.apply(delta);                   // tiles under the dirty rects go stale
  const report = renderer.value.frame();
`)}
<p>${md('`@staticflux/surface/text-input` is the `TextInput` port for canvas text editing — insert, delete, composition and selection as `TextIntent`s, with bounds for the IME. `createEditContextTextInput` and `createHiddenTextareaTextInput` both pass `runTextInputContract`; `textInputBindings({ editContext: () => facts.apis.editContext })` picks one with a variant binding, never a browser check. `@staticflux/surface/image` scales images (`scaleImage`, `fitWithin`) and encodes deterministic PNGs (`encodePng`) in any worker, no canvas needed.')}</p>
${callout('note', 'Contract suites on every topology', 'Each pipe has a shared suite in `@staticflux/testkit` that runs on every available medium and link transport. `runSequencingOracleContract` drives a whole pipeline — one worker or two, every medium — and checks each presented frame against a single-threaded reference.')}
${readMore('worker', 'document', 'stage', 'blob', 'surface', 'testkit')}
`,
};

// ------------------------------------------------------------------ performance

const performance: Guide = {
  slug: 'performance',
  title: 'Performance, observability & devtools',
  short: 'Performance & devtools',
  summary: 'One telemetry fabric, journey traces, framework-measured feature marks, budgets, the conformance stream, the loader’s warmup tiers and the devtools panel.',
  packages: ['perf', 'loader', 'devtools', 'core'],
  lede: 'StaticFlux defines its own performance model. Framework primitives emit OpenTelemetry-shaped spans automatically; opting in turns them into journey traces, budgets and devtools.',
  body: () => html`
${h2('One telemetry fabric')}
${paras(
  'Spans, events and typed metrics flow through `createTelemetry` with per-subsystem verbosity (`off | critical | standard | verbose | debug`), switchable at runtime (devtools, `?sf-debug=core/di:verbose`). Sinks are pluggable and the fabric buffers until the first one attaches. Built-in spans cover DI resolution, lifecycle transitions, navigation stages, chunk loads, requests, gate decisions, worker messages and renders.',
)}
${code(`
  export const ExportDuration = metric.histogram('studio/export-duration', { unit: 'ms' });

  unit({ id: 'studio/export-unit', provides: ExportToken, scope: 'feature', informs: [ExportDuration], create })
  // consumers declare reads: [ExportDuration]; read-but-never-informed is a build error (R17.21)
`)}

${h2('Journeys and feature marks')}
${paras(
  'Register `perfUnits` and every navigation becomes a **journey**: `app.boot` (core, critical units, shell frame) → `nav.pipeline` (one span per stage, chunk loads inside) → `feature` (activation, render) → `view`. Each phase reports total time and critical path, and journeys are classified by start (`cold | warm | soft`), activation (`fresh | warm | archived`), code source (`network | http-cache | sw`) and data source (`network | cache | snapshot`).',
  'Feature marks — `placeholderShown`, `firstRender`, `largestRender`, `interactive`, `complete` — are measured by the framework (render commit + next frame, Element Timing where supported, a largest-element heuristic elsewhere), labelled with their method, and never conflated with browser LCP. Features declare who reports which: `readiness: { firstRender: \'framework\', interactive: \'feature\' }`.',
)}
${code(`
  const units = [
    ...perfUnits,
    markBudgetUnit(defineMarkBudget({ feature: '*', mark: 'interactive', maxMs: 2_500, starts: ['cold'], reason: 'R12.7' })),
  ];
`)}
<p>${md('Detectors (long animation frames mapped to chunk ids, forced layouts, per-feature layout shift, render counts and render storms, input latency, memory) all degrade where Safari lacks the entry types. Every runtime rule violation is one typed `violation` event with a stable code and a fix — the **conformance stream** that devtools show and CI lab runs fail on.')}</p>

${h2('Loading: logical chunks and warmup tiers')}
${code(`
  chunk('feature:studio-desktop', { entry: 'src/features/studio-desktop/index.ts', tier: 'on-demand',
    budget: { category: 'heavy', reason: 'Editor + rich surface; loaded only after authorize' } });
  chunk('feature:agent-chat', { entry: 'src/features/agent-chat/index.ts', tier: 'likely', budget: { category: 'feature' } });
  chunk('lib:shell', { load: 'eager', reason: 'Shell frame renders before core-ready' });  // eager needs a reason
`, { file: 'src/app/chunks.ts' })}
<p>${md('Stable logical ids map to hashed files through `sf-manifest.json`. Tiers: `critical` (SW precache), `likely` (idle background), `speculative` (hover, viewport, prediction — network- and device-aware), `on-demand`. The chunk loader checks the gate and profile for the whole closure before fetching (I-8), preloads dependencies with the right `crossorigin`, retries with cache-busting, and reports warmup hits and wasted bytes. A tiny inline mode detector picks a per-profile **boot plan** so code for other modes is never fetched.')}</p>

${h2('Devtools')}
${code(`
  if (import.meta.env.DEV) {
    const { installDevtools } = await import('@staticflux/devtools');
    installDevtools({ injector: app.injector, units: appUnits });   // Ctrl/Cmd+Shift+D
  }
`)}
<p>${md('A bounded telemetry sink plus inspectors: boot waterfall with critical path and per-unit DI timings, navigation journeys, the DI graph, lifecycle states, gate decision traces with on-demand `explain()`, a store inspector, violations grouped by code with fixes, metric values, and controls for verbosity and app commands. The panel is its own lazy chunk; production builds exclude the package.')}</p>
${callout('note', 'See it on this page', 'The footer of every page of this site shows its own boot waterfall, read from a memory sink attached before `bootApp`.')}
${readMore('perf', 'loader', 'devtools', 'core')}
`,
};

// ------------------------------------------------------------------ UI & shell

const uiShell: Guide = {
  slug: 'ui-shell',
  title: 'UI, shell, messaging, a11y & i18n',
  short: 'UI, shell & a11y',
  summary: 'Lit components with declared deps, fine-grained rendering, the theme contract and kit, the shell frame and layout specs, one surface manager, focus and announcements, typed ICU catalogs.',
  packages: ['ui', 'kit', 'shell', 'messaging', 'a11y', 'i18n'],
  lede: 'Components self-inject what they need, render once per frame and only when what they read changes. The shell frames them; one surface manager owns every overlay; accessibility and localization are built in.',
  body: () => html`
${h2('Components')}
${code(`
  const headerSpec = component({
    tag: 'studio-header',
    deps: {
      render: { session: SessionToken, i18n: I18nToken, panel: PanelControllerToken },
      lazy: { meters: MeterRegistryToken },
    },
    size: { block: '48px' },
  });

  export class StudioHeader extends SfElement<typeof headerSpec> {
    static override readonly spec = headerSpec;
    override render(): TemplateResult {
      const { session, i18n, meters } = this.deps;
      const credits = meters.value?.get(CreditsMeter);
      return html\`<strong>\${i18n.t(appMessages.title)}</strong> …\`;
    }
  }
`, { file: 'apps/studio/src/ui/app-views.ts (abridged)' })}
${list([
  '`SfElement` is the only base class (no decorators). Dependencies resolve from the nearest `<sf-scope>` — one Lit Context key carries the injector handle.',
  'Updates go through the runtime frame scheduler: one render pass per frame; MobX tracking re-renders only for values read.',
  'A frozen scope (`<sf-scope ?frozen>`, hidden features) renders nothing and drops effects — hidden features cost zero render work.',
  'Hooks per dependency: `wireDeps(on)` with `onReady`, `onRefresh`, `onFailed`, `whileVisible`; `blocking: true` keeps the placeholder until the hook settles.',
  '`sfSrc(url)` adds the right `crossorigin` under cross-origin isolation; `crossOrigin(url, kind)` for templates.',
])}

${h2('The theme contract')}
${code(`
  import { appearanceUnit, extendTheme, themeContribution } from '@staticflux/ui/theme';
  import { defaultTheme } from '@staticflux/ui/default-theme';

  export const brandTheme = extendTheme(defaultTheme, {
    id: 'acme/brand',
    values: { color: { accent: '#5B3DF5' }, radius: { control: '9999px' } },   // typed: unknown keys fail to compile
  });
  const units = [appearanceUnit, themeContribution(brandTheme, { order: 10 })];  // the default theme is order −100
`)}
<p>${md('`@staticflux/ui/theme` defines **the** token set (`themeTokens`: color ramp, surfaces, text, accent and agent actions, type, a 4 px space grid, sizes, radii, shadows, motion, z) as typed values, never strings. `compileTheme` emits CSS that is right before any JavaScript runs (`prefers-color-scheme`, `prefers-contrast`, `prefers-reduced-motion`); after boot the appearance keeps `data-sf-*` attributes in sync with the user’s choice — scheme, contrast, density (Focus / Standard / Pro) and motion — through `appearance.set(…)`. `runThemeContract` (testkit) checks every brand theme’s contrast pairs against WCAG 2.2 AA.')}</p>

${h2('The kit')}
${code(`
  import { defineButton } from '@staticflux/kit/button';
  import { defineSlider } from '@staticflux/kit/slider';

  defineButton();
  defineSlider();
  html\`<sf-button variant="primary" size="md">Export</sf-button>
        <sf-slider label="Opacity" min="0" max="100" unit="%"></sf-slider>\`;
`)}
<p>${md('`@staticflux/kit` is a themed component set on `SfElement`: buttons, icon buttons, segmented controls, fields, sliders, tags, status, color fields, menus, popovers, tooltips, tabs, toolbars, docks and panels, inspector rows, a virtualized tree and the capability command palette. Styles use theme tokens only, so themes, density, contrast and reduced motion restyle everything; every entry point is its own budgeted chunk; overlays render messaging’s surfaces rather than replacing the manager; every component test runs `expectNoA11yIssues`.')}</p>

${h2('The shell')}
${code(`
  export const shellContributionUnits = [
    slotContribution({ id: 'studio/header', slot: 'header', label: 'Studio', render: () => html\`<studio-header></studio-header>\` }),
    slotContribution({ id: 'studio/ai-suggestions', slot: 'sidebar', label: 'AI suggestions',
      gate: gateResource('ui-slot', 'studio/ai-panel'), render: () => html\`<ai-suggestions></ai-suggestions>\` }),
    workspaceContribution(defineWorkspace({ id: 'studio/expert', label: 'Expert',
      gate: gateResource('workspace', 'workspace:studio/expert'), add: ['studio/inspector'] })),
  ];
`)}
<p>${md('`<sf-shell>` lays out slots per shell preset (expanded, medium, compact, embedded — chosen per app profile, never by `if`), wraps each region in an error boundary, hides gated contributions until allowed, applies the theme (the theme contract above; `createThemeController` remains for the older token set), switches workspaces in a View Transition, and renders skip links and landmarks first. The command palette and command shortcuts sit on the a11y shortcut registry.')}</p>

${h2('Layout specs')}
${code(`
  import { createSpecLayoutPort, createSpecRuntime, createSpecVocabulary, defineSpecContribution,
    defineSpecSection } from '@staticflux/shell/spec';

  const vocabulary = createSpecVocabulary({
    sections: [defineSpecSection({ id: 'tool', pinnable: true }), defineSpecSection({ id: 'panel', placements: ['dock', 'inspector'] })],
    contributions: [
      defineSpecContribution({ section: 'tool', id: 'app/pen', label: 'Pen' }),
      defineSpecContribution({ section: 'tool', id: 'app/heal', label: 'Heal', when: { lens: ['app/pixel'] } }),
      defineSpecContribution({ section: 'panel', id: 'app/layers', label: 'Layers', gate: gateResource('ui-slot', 'app/layers') }),
    ],
  });
  if (!vocabulary.ok) throw vocabulary.error;           // a malformed vocabulary is a programmer error

  const layout = createSpecLayoutPort();                 // reactive: views render entries(group) with phases
  const specs = createSpecRuntime({ vocabulary: vocabulary.value, port: layout, decide });
  const applied = await specs.apply({
    id: 'app/retouch', context: { lens: 'app/pixel' },
    slots: [{ section: 'tool', id: 'app/pen' }, { section: 'tool', id: 'app/heal' }, { section: 'panel', id: 'app/layers', placement: 'dock' }],
  }, { signal });                                        // Result<SpecApplied>: the diff, failures, dropped pins
`)}
<p>${md('`@staticflux/shell/spec` generalizes workspaces: a screen is a **spec** — data naming registered contributions, their sections and placements. `validateSpec` reports every issue at once (unknown contribution, context mismatch, gated out, cardinality, placement); `apply` diffs against what is mounted (`diffSpecs`: unmount, move, mount, kept, pinned) and drives the mount port in that order within one frame, each step animated for 120–200 ms (0 under reduced motion). Agents apply specs too, through their own subject’s `DecidePort`.')}</p>

${h2('One surface manager')}
${code(`
  export const SavedToast = defineSurface<{ readonly message: string }>({
    id: 'studio/saved-toast', kind: 'toast', scope: 'app', durationMs: 2500,
    render: ({ props }) => html\`\${props.message}\`,
  });
  surfaces.request(SavedToast, { owner: ownerOf(context.injector), props: { message: 'Saved' } });
`)}
<p>${md('Dialog, sheet, popover, tooltip, toast, banner, coach mark and inline alert share one stacking model, focus behaviour, theming and motion. Every surface has an owner scope (I-7), attention is arbitrated (toast caps, banner dedup, coach marks suppressed while a modal is up or the user is busy), surfaces are gated (a denied premium dialog resolves to its upsell) and every one reports shown / dismissed / dwell metrics.')}</p>

${h2('Accessibility')}
<p>${md('`@staticflux/a11y` provides the focus manager (route-change focus, stacked traps with restore and inert background), a debounced live-region announcer, a typed keyboard-shortcut registry with scopes and conflict detection (`checkShortcuts` in CI), reactive preference facts (reduced motion, contrast, forced colors, color scheme) and `aria-busy` helpers. Target: WCAG 2.2 AA. Placeholders expose busy state; announced text never goes to telemetry.')}</p>

${h2('Localization')}
${code(`
  export const appMessages = defineMessages('studio/app', {
    title: 'Studio',
    credits: '{count, plural, one {# credit} other {# credits}} left',
  });
  i18n.t(appMessages.credits, { count: 3 });     // params inferred from the ICU literal
`)}
<p>${md('Typed catalogs per package (keys are values, never strings), an ICU subset (plural, select, selectordinal, number, date, list), each locale a lazy chunk, negotiation with a fallback chain, runtime locale switch without reload (it flips only after every catalog in use loaded), RTL via `dir`, `Intl` formatters, and `checkCatalogs` for missing, unused and mismatched keys in CI.')}</p>
${readMore('ui', 'kit', 'shell', 'messaging', 'a11y', 'i18n')}
`,
};

// ------------------------------------------------------------------ PWA & hydration

const pwaHydration: Guide = {
  slug: 'pwa-hydration',
  title: 'PWA & hydration',
  short: 'PWA & hydration',
  summary: 'Service worker from warmup tiers, safe updates without reload, launch intents; islands over prerendered HTML and store snapshots for instant boot.',
  packages: ['pwa', 'hydrate'],
  lede: 'Instant boot from three directions: a service worker built from the chunk manifest, islands that hydrate prerendered HTML on demand, and state snapshots restored before the network answers.',
  body: () => html`
${h2('Service worker and updates')}
${paras(
  '`@staticflux/pwa/sw` runs inside the service worker: an atomic precache of the **critical** tier from `sf-manifest.json` (`serviceWorkerConfigFromManifest`), a warm cache that `likely` / `speculative` warmups fill at low priority, cache strategies per rule (Wasm, locale catalogs, lazy assets), network-first navigations with an app-shell fallback, and optional plugins (background sync of idempotent mutations, push, share target, COOP/COEP injection for static hosts).',
  'On the page, `createPwaUpdater({ env, scriptUrl, frameworkMajor, reinitialize, prompt })` registers the worker and runs the update flow: a new version → a messaging prompt → `skip-waiting` only on accept (chunk versions never mix) → `supervisor.reinitialize()` **without a reload**. A framework-major change or an unknown version falls back to a full reload — the explicit escape hatch.',
)}
${code(`
  const updater = createPwaUpdater({
    env: browserPwaPageEnv(),
    scriptUrl: '/sw.js',
    frameworkMajor: 0,
    reinitialize: { reinitialize: () => supervisor.reinitialize() },   // ReinitializePort
    prompt: { offer: (info, signal) => askToUpdate(info, signal) },     // UpdatePromptPort → 'accept' | 'dismiss'
  });
  await updater.register();
`)}
<p>${md('Launch data — links, files, share targets, notification clicks — arrives as `LaunchIntent`s through a port, as data only (prefill, never executed). `defineWebAppManifest` validates the web app manifest at build time.')}</p>

${h2('Islands over prerendered HTML')}
${code(`
  <!-- build time: renderIslandMarker({ chunk: 'island:code', hydrate: 'interaction', html }) -->
  <sf-island chunk="island:code" hydrate="interaction">
    <figure class="code">…<button data-copy>Copy</button>…</figure>
  </sf-island>
`, { lang: 'html', file: 'this site’s prerendered HTML' })}
${code(`
  // the island chunk: a named hydrate export (or defineIsland({ props, hydrate }))
  export const hydrate = defineIsland({
    async hydrate(element, { injector, scope, signal }) {
      const button = element.querySelector('[data-copy]')!;
      scope.listen(button, 'click', () => copy(element));     // everything in the island scope
      return ok();
    },
  }).hydrate;

  // boot: one hydrator for the page, islands load through the chunk loader (gated)
  createIslandHydrator({ loader, telemetry }).start(document.body, { injector: app.injector });
`, { file: 'site/src/client (abridged)' })}
${list([
  'Strategies: `visible` (default), `idle`, `interaction` (preloaded on hover / focus, hydrated on first input), `eager` (requires a `reason`), `never`.',
  '**Event replay**: clicks, input and submits before hydration are queued and replayed on the original targets afterwards.',
  'The island gate and `loader.check` run before any fetch; a denied island is `skipped` and its chunk never requested.',
  'Static markup is the first render; hydration is “interactive” — both are feature marks, and a size mismatch after hydration is reported as a layout-shift risk.',
])}

${h2('State rehydration')}
<p>${md('`createSnapshotRegistry` persists store and resource snapshots to an `AsyncStore` and restores them at boot before the network — versioned, identity-bound (opaque hashes), budgeted and time-boxed (default 200 ms). Restored data is tagged `snapshot` and revalidated (SWR); a restore never bumps the epoch, so old-epoch responses are still discarded. Snapshot failures never fail boot.')}</p>
${callout('note', 'This site is built this way', 'Every page here is prerendered static HTML. The header theme switch, the copy buttons, the package filter and the boot waterfall are islands, declared as logical chunks for the StaticFlux Vite plugin.')}
${readMore('pwa', 'hydrate', 'loader')}
`,
};

// ------------------------------------------------------------------ AI

const ai: Guide = {
  slug: 'ai',
  title: 'AI, capabilities, WebMCP, advisors & sandbox',
  short: 'AI & capabilities',
  summary: 'Typed capabilities with one gated pipeline for UI, palette and agents; WebMCP publishing; one model-provider port; advisors that only tune performance; sandboxed plugins.',
  packages: ['capabilities', 'webmcp', 'ai', 'advisors', 'sandbox'],
  lede: 'Agents are first-class callers, not a side channel: the same typed capabilities, the same gates and confirmations, the same meters and traces as a user clicking a button.',
  body: () => html`
${h2('Capabilities: one pipeline for every caller')}
${code(`
  export const InsertImageCapability = defineCapability({
    id: 'agent/insert-image',
    title: 'Insert image',
    description: 'Insert an image block into the open document.',
    input: s.object({ src: s.string({ minLength: 1 }), alt: s.optional(s.string()) }),
    output: s.object({ blockId: s.string() }),
    policy: { resource: 'agent/insert-image' },
    requiresConfirmation: false,
    destructive: false,
    costEstimate: () => ({ meter: CreditsMeter.id, amount: 2 }),
  });

  const insertImage = implementCapability(InsertImageCapability, async (input) => {
    const blockId = await doc.insertImage(input.src, input.alt);         // Result<string>
    return blockId.ok ? ok({ blockId: blockId.value }) : blockId;        // output is validated too
  });
  const result = await registry.invoke(InsertImageCapability, { src }, { subject: 'agent', signal });
`)}
<p>${md('Every invocation: validate input → authorize (decide port) → confirm (confirm port) → ensure the owning feature is active → reserve the meter → run → validate output → commit or release — a typed `capabilities/invocation` machine and a `capability.invoke` span. Destructive actions by non-user subjects always need confirmation, and the default confirm port **fails closed**.')}</p>

${h2('WebMCP: capabilities as agent tools')}
<p>${md('Register `webMcpUnits` and every capability declared with `exposeToAgents` is published as a WebMCP tool (JSON Schemas from the capability schemas, `destructiveHint` from `destructive`). Tool calls go through `registry.invoke(…, { subject: \'agent\' })` — no per-feature WebMCP code. The experimental API is isolated in one adapter; unsupported browsers get a no-op.')}</p>

${h2('One model-provider port')}
<p>${md('`@staticflux/ai` wraps browser built-in AI (Prompt, Summarizer, Translator, Language Detector), decision models (closed options → probabilities), remote LLMs and a mock behind `ModelProvider`, routed per task by `createModelRouter`. Availability, including download state and progress, is a reactive fact features gate on. Requests never start a model download implicitly — `prepare(task)` runs from a user gesture — and AI is never on the critical path: every call is async, cancellable, returns a `Result`, and has a non-AI fallback.')}</p>

${h2('Advisors suggest; the framework decides')}
${code(`
  export const NextChunk = defineDecisionPoint({
    id: 'loader/next-chunk',
    purpose: 'warmup',
    options: ['feature:agent-chat', 'feature:settings', 'feature:billing'],
    latency: 'sync',
    heuristic: () => 'feature:agent-chat',      // deterministic default
  });
  const advice = advisors.decide(NextChunk, { route: 'studio/doc' });   // never blocks
`)}
<p>${md('Decision points (warmup, retention, scheduling, prefetch, messaging timing, sampling) consult heuristic, statistical (a bounded Markov model in a user-data slice), on-device model or remote advisors — time-boxed, clamped by budgets and gates, with the overridden default and outcome recorded. Remote advisors receive only declared, minimized feature vectors.')}</p>
${callout('warn', 'Never for authorization', 'Advisors change performance, never correctness. `AdvisoryPurpose` is a closed set and there is no API to ask an advisor about access, entitlements or security.')}

${h2('Sandboxed third-party plugins')}
<p>${md('`createPluginHost` runs untrusted plugins in a sandboxed iframe (opaque origin, strict CSP, `allow-scripts` only) or a worker, talking typed RPC over a `MessagePort`. A plugin can only invoke the capabilities granted to it (through the same `registry.invoke`, as subject `plugin`), receive declared events and render into a host slot. Every message is rate-, size- and shape-checked; violations beyond a budget kill the plugin.')}</p>
${callout('warn', 'Client gating is UX, not security', 'The sandbox limits what a plugin can ask the app to do; it does not authorize anything. Capability implementations call servers that re-check every request.')}
${readMore('capabilities', 'webmcp', 'ai', 'advisors', 'sandbox')}
`,
};

// ------------------------------------------------------------------ tooling

const tooling: Guide = {
  slug: 'tooling',
  title: 'Build tooling: Vite, Rspack & the sf CLI',
  short: 'Build tooling',
  summary: 'Logical chunks to bundler chunks, sf-manifest.json, per-profile preloads, budgets, Module Federation 2.0, and the CLI that enforces the rules.',
  packages: ['vite-plugin', 'rspack-plugin', 'sf', 'loader'],
  lede: 'Packages are bundler-agnostic plain ESM. The only build contract is the loader’s `sf-manifest/1`; the plugins produce it, and the CLI keeps everyone honest.',
  body: () => html`
${h2('Vite 8 (default)')}
${code(`
  import { defineConfig } from 'vite';
  import { staticflux } from '@staticflux/vite-plugin';
  import { chunkDeclarations } from './src/app/chunks.js';

  export default defineConfig({
    plugins: [staticflux({
      chunks: chunkDeclarations,
      bootEntries: ['src/boot-browser.ts'],
      budgets: { onViolation: process.env.CI ? 'error' : 'warn', bootKb: 150 },
      isolation: 'preferred', coep: 'credentialless',
    })],
  });
`, { file: 'vite.config.ts' })}
<p>${md('Each declaration with an `entry` becomes a stable, readable chunk (`assets/feature.studio-desktop-<hash>.js`). The plugin emits `sf-manifest.json`, `sf-preloads.json` (per profile), `sf-precache.json` (critical tier, Workbox format) and `sf-build-report.json`, injects boot-plan `modulepreload` tags, serves COOP / COEP / CORP in dev and preview, and checks chunk, eager and boot budgets. App code imports chunks by logical id through `virtual:sf-chunks`.')}</p>
${code(`
  import { chunks } from 'virtual:sf-chunks';
  defineFeature({ id: 'studio/desktop', weight: 'heavy', modes: ['expanded'],
    load: () => chunks['feature:studio-desktop']!() as Promise<FeatureModule> });
`)}

${h2('Rspack + Module Federation 2.0')}
<p>${md('`staticfluxRspack(options)` emits the same files from the compilation’s chunk groups for organizations deploying independently. It maps remotes’ exposed modules to logical chunk ids and validates host-owned shared singletons and versions at build time (P9: one version per app); the loader re-checks the ranges before a remote’s `init`. Any other bundler works by producing the same manifest with `createManifest` from `@staticflux/loader`.')}</p>

${h2('The sf CLI')}
<div class="prose-table"><table>
  <thead><tr><th>Command</th><th>What it checks</th></tr></thead>
  <tbody>
    <tr><td><code>sf graph &lt;entry&gt;</code></td><td>DI graph: cycles, scope rules, fan-in / fan-out, duplicate and unused providers, boot order, critical set</td></tr>
    <tr><td><code>sf lint</code></td><td><code>no-direct-flag-reads</code>, <code>no-bare-listener</code>, <code>inheritance-depth</code>, <code>no-string-tokens</code>, <code>no-default-export</code></td></tr>
    <tr><td><code>sf errors</code></td><td>Collects every <code>defineError</code> into <code>docs/errors.json</code>; <code>--check</code> fails on stale or conflicting codes</td></tr>
    <tr><td><code>sf budgets</code></td><td>Limit vs actual; proposes tightening (ratchet), never loosens</td></tr>
    <tr><td><code>sf agents</code></td><td>Regenerates the “Budgets” and “Allowed dependencies” sections of every AGENTS.md</td></tr>
    <tr><td><code>sf routes &lt;entry&gt;</code></td><td>Route × profile completeness: every capability-bound route has a feature for every mode</td></tr>
    <tr><td><code>sf manifest &lt;file&gt;</code></td><td>Validates an <code>sf-manifest.json</code>: shapes, dangling deps, budgets, eager reasons</td></tr>
  </tbody>
</table></div>
${code(`
  pnpm lint:sf            # sf lint over packages/*/src
  pnpm errors:check       # catalog is current
  pnpm budgets            # size-limit --json → sf budgets (ratchet proposals)
  pnpm agents:check       # generated AGENTS.md sections are current
  pnpm sf graph dist/units.js --max-fan-out 12    # any module exporting \`units\`
`, { lang: 'sh' })}
${readMore('vite-plugin', 'rspack-plugin', 'sf', 'loader')}
`,
};

// ------------------------------------------------------------------ testing

const testing: Guide = {
  slug: 'testing',
  title: 'Testing with @staticflux/testkit',
  short: 'Testing',
  summary: 'Test injector with overrides and recorded telemetry, deterministic fake time, fake sessions, bootTestApp, shared contract suites.',
  packages: ['testkit'],
  lede: 'DI makes everything testable: no global singletons to patch, every browser API behind an injectable port, and telemetry you can assert on.',
  body: () => html`
${h2('Test a unit')}
${code(`
  const t = createTestInjector({
    units: [docsUnit, dataClientUnit, epochSourceUnit, pauseControlUnit],
    overrides: [mockTransportUnit((m) => m.route(DocGet, ({ id }) => ({ id, title: 'Draft' })))],
  });
  const docs = await t.get(DocsToken);
  expect((await docs.load('42')).ok).toBe(true);
  expect(t.spans({ name: 'data/request', attrs: { endpoint: 'docs/get' } })).toHaveLength(1);
  t.expectChildSpan({ name: 'di.resolve', attrs: { unit: 'docs/unit' } }, { name: 'di.resolve', attrs: { unit: 'data/client-unit' } });
  t.expectNoViolations();
  await t.dispose();
`, { file: 'packages/testkit/AGENTS.md' })}
<p>${md('Overrides bind at `experiment` precedence, so they beat app bindings and variants; `provideValue(Token, fake)` for plain values. Telemetry defaults to `debug` so `verbose` DI spans are visible. Assert span **structure** and attributes, never durations.')}</p>

${h2('Test a feature: boot, routing, session')}
${code(`
  const t = await bootTestApp({
    units: [...runtimeUnits, ...studioUnits],
    routes: [home, doc],
    initialUrl: '/doc/42',
    session: { initial: { user: 'ada', roles: ['editor'], plan: 'pro' } },
    time: true,                              // fake time: frames, back-offs, session expiry
  });
  expect(t.router?.current?.route).toBe(doc);
  await t.session?.switchAccount('bob');     // principalChanged + requiresEpochRefresh
  await t.time?.advance(1_000);              // timers only elapse here
  t.expectChildSpan('app.boot', 'boot.critical');
  await t.shutdown();
`)}

${h2('Fake time, fake platform, fake everything')}
${list([
  '`createFakeClock`, `createFakeFrames`, `createFakeIdle`, `createFakeTime()` (with `schedulerEnv` for the runtime frame scheduler) — `flush()`, `advance(ms)`, `runAll()` with runaway detection.',
  '`createFakeSession` over the real session store: `login`, `logout`, `expire`, `switchAccount`, `revoke`; multi-tab with a shared `createMemoryChannelHub()`.',
  'Re-exported fakes from their packages: mock transport, memory / fake IndexedDB / OPFS / cookie stores, fake platform env, in-memory worker port pairs (`freeze`, `thaw`, `crash`), memory histories.',
  'Components: `@staticflux/ui/testing` (`mountTestRoot`, `manualVisibility`, `settle`) with a test injector.',
])}

${h2('Contract suites')}
${code(`
  runTransportContract('fetch', (fixture) => createFetchTransport({ baseUrl: '/api', fetch: fakeFetch(fixture) }), { describe, it });
  runHistoryContract('router memory', (url) => createRouterMemoryHistory({ initial: url }), { describe, it }, { level: 'adapter' });
  runStoreContract('memory', () => createMemoryStore(), { describe, it });
`)}
<p>${md('Every implementation of a contract runs the same shared suite; a new adapter is not done until it passes. Never import testkit from app or package source — only from `*.test.ts`.')}</p>
${code(`
  for (const medium of availablePipeMedia()) runDeltaStreamContract(medium, { describe, it });   // local · shared · message
  runRasterBackendContract('memory', () => ({ backend: createMemoryRasterBackend({ tileSize: 64 }), scene, tolerance: 0 }), { describe, it });
  runTextInputContract('hidden textarea', subject, { describe, it });
`)}
<p>${md('The same holds for the newer ports: pipes on every medium and link transport, `runDocumentCrdtContract` (N-peer convergence), `runDocumentRepoContract`, `runUndoServiceContract`, `runBlobStoreContract`, `runSpecRuntimeContract`, `runThemeContract`, and `runSequencingOracleContract` for a whole editor ↔ render pipeline in every topology.')}</p>
${code(`
  npx vitest run packages/router     # one package
  npx vitest run apps/studio         # boots the whole example app per test (happy-dom)
  pnpm test                          # everything
`, { lang: 'sh' })}
${readMore('testkit', 'ui')}
`,
};

export const GUIDES: readonly Guide[] = [coreDi, lifecycles, routing, authGating, dataStorage, threads, editors, performance, uiShell, pwaHydration, ai, tooling, testing];

const sidebar: readonly SidebarGroup[] = [
  { title: 'Foundations', links: [{ label: 'All guides', path: 'guides/' }, ...[coreDi, lifecycles].map((g) => ({ label: g.short, path: `guides/${g.slug}/` }))] },
  { title: 'Verticals', links: [routing, authGating, dataStorage, threads, editors, performance].map((g) => ({ label: g.short, path: `guides/${g.slug}/` })) },
  { title: 'Experience', links: [uiShell, pwaHydration, ai].map((g) => ({ label: g.short, path: `guides/${g.slug}/` })) },
  { title: 'Workflow', links: [tooling, testing].map((g) => ({ label: g.short, path: `guides/${g.slug}/` })) },
];

export const guidePages: readonly Page[] = GUIDES.map((g) => ({
  path: `guides/${g.slug}/`,
  title: g.title,
  description: g.summary,
  nav: 'guides',
  layout: 'doc',
  sidebar,
  toc: true,
  hero: { eyebrow: `Guide · ${g.packages.map((p) => `@staticflux/${p}`).join(' · ')}`, title: g.title, lede: g.lede },
  body: g.body,
}));

export const guidesIndexPage: Page = {
  path: 'guides/',
  title: 'Guides',
  description: 'Concise guides to every area of StaticFlux: core & DI, lifecycles, routing, auth & gating, data & storage, workers, editors & canvases, performance, UI & shell, PWA & hydration, AI & capabilities, tooling and testing.',
  nav: 'guides',
  layout: 'doc',
  sidebar,
  hero: {
    eyebrow: 'Guides',
    title: 'One guide per area.',
    lede: 'Short, accurate tours of each part of the framework — the ideas, the main APIs and the rules — with links to every package’s AGENTS.md for the full surface.',
  },
  body: () => html`
<ul class="cards">${GUIDES.map(
    (g) => html`<li><a class="card" href="${href(`guides/${g.slug}/`)}"><h3>${g.title}</h3><p>${g.summary}</p>${g.packages.map((p) => html`<span class="chip">${p}</span>`)}</a></li>`,
  )}</ul>
${callout('note', 'Reading order', html`<p>New to StaticFlux? Start with <strong>Core &amp; DI</strong> and <strong>Lifecycles</strong> — every other package is written in their vocabulary. The <a href="${href('philosophy/')}">philosophy</a> explains why.</p>`)}
`,
};
