import { type BeforeAfter, beforeAfter } from '../components.js';
import { html, md, slug, type Raw } from '../html.js';
import type { Page } from '../layout.js';
import { href } from '../site.js';

/**
 * Ten everyday problems. "After" snippets use the real StaticFlux APIs (names checked
 * against packages/*\/src); app-level names (DocRoute, DocumentStoreToken, …) are the
 * kind of declarations an app writes in its contracts file — see apps/studio/src/app.
 */
const EXAMPLES: readonly BeforeAfter[] = [
  {
    title: 'God object → granular units',
    lede: 'One `AppServices` singleton that constructs everything at startup and that every file imports.',
    beforeFile: 'services.ts',
    before: `
      export class AppServices {
        static readonly instance = new AppServices();
        api = new ApiClient('/api');
        session = new SessionManager(this.api);
        docs = new DocsService(this.api, this.session);
        analytics = new Analytics(this.api);
        flags = new FeatureFlags(this.api, this.session);
        // … 40 more, all built at boot, all in the first bundle
      }

      // anywhere in the app:
      const page = await AppServices.instance.docs.list();
      // tests: monkey-patch the singleton and hope nothing cached it
    `,
    afterFile: 'docs/units.ts',
    after: `
      import { type Result, token, unit } from '@staticflux/core';
      import { DataClientToken } from '@staticflux/data';

      export interface DocsService {
        list(signal: AbortSignal): Promise<Result<DocsPage>>;
      }
      export const DocsServiceToken = token('docs/service').type<DocsService>();

      export const docsServiceUnit = unit({
        id: 'docs/service-unit',
        provides: DocsServiceToken,
        scope: 'session',                     // disposed on logout, with what it holds
        deps: { required: { client: DataClientToken } },
        create: ({ client }): DocsService => ({
          list: (signal) => client.call(DocsListEndpoint, { cursor: undefined }, { signal }),
        }),
      });

      // consumers declare the token; nothing is built until something asks for it
      const docs = await injector.get(DocsServiceToken);
    `,
    benefit:
      'Each unit is one small thing with a typed identity, so it is lazy (built on first use, in dependency order), testable alone (`createTestInjector` with overrides — no singletons to patch) and replaceable alone. The graph tool measures fan-in and fan-out and flags god units, and scopes make lifetimes explicit: session-scoped units die on logout.',
    packages: ['core', 'data', 'testkit'],
  },
  {
    title: 'Prop-drilled dependencies → self-injected component deps',
    lede: 'Parents pass services down through components that never use them, and every child invents its own loading state.',
    beforeFile: 'doc-toolbar.ts',
    before: `
      // <doc-page> passes .doc .presence .exporter to <doc-toolbar>,
      // which passes .exporter to <export-button>, which …
      class DocToolbar extends LitElement {
        static properties = { doc: {}, presence: {}, exporter: {} };

        render() {
          if (!this.doc) return html\`<spinner-el></spinner-el>\`;   // layout shift
          return html\`
            <h2>\${this.doc.title}</h2>
            <span>\${this.presence?.count ?? 0} editing</span>
            <button @click=\${() => this.exporter.exportPdf(this.doc.id)}>PDF</button>\`;
        }
      }
      // the PDF exporter (and its library) ships in the boot bundle, for everyone
    `,
    afterFile: 'doc-toolbar.ts',
    after: `
      import { component, defineComponent, SfElement } from '@staticflux/ui';
      import { html } from 'lit';

      const toolbarSpec = component({
        tag: 'doc-toolbar',
        deps: {
          render: { doc: DocumentStoreToken },                               // placeholder until ready
          lazy: { presence: { token: PresenceToken, init: 'on-visible' } }, // reactive, arrives later
          functional: { exportPdf: { token: ExportPdfToken, init: 'on-intent' } }, // loads on hover/focus
        },
        size: { block: '48px' },                                             // reserved: no layout shift
      });

      export class DocToolbar extends SfElement<typeof toolbarSpec> {
        static override readonly spec = toolbarSpec;
        override render() {
          const { doc, presence, exportPdf } = this.deps;
          return html\`
            <h2>\${doc.title}</h2>
            <span>\${presence.value?.count ?? 0} editing</span>
            <button data-sf-intent=\${this.intent('exportPdf')} @click=\${async () => {
              const exporter = await exportPdf.get();
              if (exporter.ok) await exporter.value.run(doc.docId);
            }}>PDF</button>\`;
        }
      }
      defineComponent(DocToolbar);
    `,
    benefit:
      'The component declares what it needs and resolves it from the nearest `<sf-scope>` (the Lit Context protocol carries the injector), so parents stay ignorant of their children’s dependencies. The three kinds encode intent: `render` deps block on a size-stable placeholder with `aria-busy`, `lazy` deps re-render when they arrive, and `functional` deps — and their code — load only on interaction, pre-warmed on hover or focus.',
    packages: ['ui', 'core'],
  },
  {
    title: 'Flag if/else → variant bindings',
    lede: 'Experiment flags read by string key inside feature code, with the same branch repeated everywhere the variant matters.',
    beforeFile: 'onboarding.ts',
    before: `
      function OnboardingHeadline() {
        const variant = flags.get('onboarding_variant');  // magic string, untyped
        if (variant === 'B') {
          return 'Three steps to your first document';
        } else {
          return 'Let’s set up your studio';
        }
      }
      // … and again in the wizard, the email, the coach mark, the tests.
      // Removing the experiment means finding every branch.
    `,
    afterFile: 'compose.ts',
    after: `
      // contracts.ts — typed declarations
      export const OnboardingVariantFlag = defineFlag({
        key: 'onboarding/variant', type: flagType.enum(['A', 'B']), default: 'A',
        owner: 'onboarding', preAuthSafe: true, description: 'Onboarding copy experiment.',
      });
      export const OnboardingCopyToken = token('onboarding/copy').type<OnboardingCopy>();

      // compose.ts — one unit per variant; the binder turns the flag into bindings
      const copyA = unit({ id: 'onboarding/copy-a-unit', provides: OnboardingCopyToken, scope: 'app',
        create: () => ({ headline: 'Let’s set up your studio' }) });
      const copyB = unit({ id: 'onboarding/copy-b-unit', provides: OnboardingCopyToken, scope: 'app',
        create: () => ({ headline: 'Three steps to your first document' }) });

      const binder = createFlagBinder();
      const units = [
        flagResolverUnit({ initTimeoutMs: 1500 }), flagBinderUnit(binder), copyA,
        ...binder.variants({ flag: OnboardingVariantFlag, of: OnboardingCopyToken, variants: { B: copyB } }),
      ];

      // feature code injects the token — it never sees the flag
      deps: { render: { copy: OnboardingCopyToken } }   // → html\`<h1>\${this.deps.copy.headline}</h1>\`
    `,
    benefit:
      'Feature code has one path; the experiment lives in the composition as alternate bindings at `experiment` precedence, visible in devtools. Each variant is a unit you can test on its own, and ending the experiment means deleting one unit and one line. The `no-direct-flag-reads` lint rule keeps flag reads out of feature code for good.',
    packages: ['config', 'core'],
  },
  {
    title: 'Leaked listeners and timers → scopes',
    lede: 'Start/stop pairs that drift apart: a listener nobody removes, an interval nobody clears, a fetch that lands after unmount.',
    beforeFile: 'minimap.ts',
    before: `
      class Minimap {
        start() {
          window.addEventListener('resize', this.fit);
          this.timer = setInterval(() => this.poll(), 5000);
          this.unsubscribe = store.subscribe(this.redraw);
          fetch(\`/api/thumbs/\${this.id}\`)
            .then((r) => r.json())
            .then((t) => this.draw(t));          // lands after unmount → writes a dead canvas
        }
        stop() {
          window.removeEventListener('resize', this.fit);
          // forgot clearInterval, forgot unsubscribe
        }
      }
    `,
    afterFile: 'minimap.ts',
    after: `
      import { effect, type Scope, sleep, task } from '@staticflux/core';

      export function startMinimap(owner: Scope, view: MinimapView): void {
        const scope = owner.child('minimap');               // disposed with its owner

        scope.listen(window, 'resize', () => view.fit());  // removed on dispose
        effect(() => view.redraw(store.blocks), scope);    // reactive; stops on dispose

        void (async () => {                                 // abortable polling loop
          while (!scope.disposed) {
            await view.poll(scope.signal);
            if (!(await sleep(5_000, scope.signal)).ok) return;
          }
        })();

        const thumbs = task((signal) => fetch(\`/api/thumbs/\${view.id}\`, { signal }).then((r) => r.json()));
        void thumbs(scope.signal).then((r) => { if (r.ok) view.draw(r.value); }); // aborted, never late
      }
      // the feature's UI scope is the owner: unmount → dispose → all of the above stops
    `,
    benefit:
      'A scope is the single owner of everything a lifecycle state starts. Disposing it removes listeners, stops effects, aborts its `AbortSignal` (so in-flight requests and sleeps end) and runs cleanups in reverse order — children first. Features get logic, UI and visible scopes from the runtime, so cleanup is never a separate code path, and the `no-bare-listener` lint rule flags listeners without a signal or scope.',
    packages: ['core', 'runtime'],
  },
  {
    title: 'A dialog that outlives its page → scope-bound routable surfaces',
    lede: 'An overlay appended to `<body>` with no owner: Back leaves it open over a page it no longer belongs to.',
    beforeFile: 'share.ts',
    before: `
      async function share(docId: string) {
        const dialog = document.createElement('share-dialog');
        dialog.docId = docId;
        document.body.append(dialog);              // global overlay, no owner, no focus trap
        dialog.addEventListener('close', () => dialog.remove());
        history.pushState({}, '', '?share=1');     // ad-hoc URL; a deep link shows nothing
      }
      // Back to the doc list → the dialog is still open, for a doc that is gone.
      // A toast fires at the same time and covers the dialog's buttons.
    `,
    afterFile: 'routes.ts · surfaces.ts',
    after: `
      // the dialog is part of the doc route's URL: /studio/doc/42/d/share
      export const ShareDialogRoute = defineDialog({
        id: 'studio/share', key: 'share', owner: DocRoute, requires: { auth: 'required' },
      });

      // declared once; the surface manager renders, stacks, traps and restores focus
      export const ShareDialog = defineSurface<{ readonly docId: string }>({
        id: 'studio/share-dialog',
        kind: 'dialog',
        scope: 'route',                  // can never outlive its route (invariant I-7)
        label: 'Share document',
        routable: { key: 'share', params: (raw) => ok({ docId: raw['id'] ?? '' }) },
        render: ({ props, dismiss, titleId }) => html\`
          <h2 id=\${titleId}>Share document \${props.docId}</h2>
          <button @click=\${() => dismiss('completed')}>Done</button>\`,
      });
      export const shareDialogUnit = contribution({
        id: 'studio/share-dialog-surface-unit', provides: RoutableSurfacesToken, scope: 'app',
        create: () => ShareDialog,
      });

      // open it like a route: availability → authorize → load → enter
      html\`<button @click=\${() => void router.openDialogRoute(ShareDialogRoute)}>Share</button>\`
    `,
    benefit:
      'Every surface — dialog, sheet, popover, tooltip, toast, banner, coach mark — belongs to a scope and is dismissed when that scope ends, so a dialog can never outlive its page. Routable dialogs get real URLs: a deep link opens them after the auth check, Back closes them, and their content lazy-loads only when allowed. One manager arbitrates attention, so toasts and coach marks wait while a modal is up.',
    packages: ['messaging', 'router', 'urlstate'],
  },
  {
    title: 'Ad-hoc retries and try/catch → Task + Result + retry',
    lede: 'A hand-rolled loop that retries 404s, never times out, cannot be cancelled and throws an untyped `Error` at callers who may not catch it.',
    beforeFile: 'load-doc.ts',
    before: `
      async function loadDoc(id: string) {
        for (let i = 0; i < 3; i++) {
          try {
            const res = await fetch(\`/api/docs/\${id}\`);      // no timeout, no abort
            if (!res.ok) throw new Error('HTTP ' + res.status); // 404 retried 3×
            return await res.json();
          } catch (e) {
            await new Promise((r) => setTimeout(r, 1000 * i)); // synchronized retry storm
          }
        }
        throw new Error('failed');      // callers: try/catch … or an unhandled rejection
      }
    `,
    afterFile: 'load-doc.ts',
    after: `
      import { attemptAsync, defineError, err, retry, type Task, timeout } from '@staticflux/core';

      export const DocNotFound = defineError('APP-DOC-001', 'not-found',
        'The document does not exist.', 'Check the id; offer to create a new document.');
      export const DocUnavailable = defineError('APP-DOC-002', 'unavailable',
        'The document service is unavailable.', 'Keep the cached copy read-only and retry later.');

      const fetchDoc = (id: string): Task<Doc> => async (signal) => {
        const res = await attemptAsync(() => fetch(\`/api/docs/\${id}\`, { signal }));
        if (!res.ok) return res;
        if (res.value.status === 404) return err(DocNotFound({ details: { id } }));  // never retried
        if (!res.value.ok) return err(DocUnavailable({ details: { status: res.value.status } }));
        return attemptAsync(() => res.value.json() as Promise<Doc>);
      };

      // 5 s per attempt, 3 attempts, full-jitter backoff; aborting the signal stops everything
      const loadDoc = (id: string) => retry(timeout(fetchDoc(id), 5_000), { attempts: 3, baseDelayMs: 200 });

      const result = await loadDoc('42')(scope.signal);
      if (!result.ok) showError(result.error.code, result.error.fix);
    `,
    benefit:
      'A `Task` is a function of an `AbortSignal` that resolves to a `Result` — it never throws for expected failures, so combinators (`retry`, `timeout`, `createSingleFlight`, `createCircuitBreaker`, `createLimiter`) compose and every error has a stable code, a kind and a fix. Retries use full jitter and only retry retryable kinds. In apps, `@staticflux/data` endpoints do this for you: the data client is the one and only retry layer.',
    packages: ['core', 'data'],
  },
  {
    title: 'Hand-wired perf logging → declarative metrics and journeys',
    lede: '`performance.now()` sprinkled through feature code, string metric names, one vendor SDK, and nobody notices when the number doubles.',
    beforeFile: 'editor.ts',
    before: `
      const t0 = performance.now();
      await loadEditor();
      const ms = performance.now() - t0;
      console.log('editor ready', ms);           // only on the developer's laptop
      analytics.track('editor_ready_ms', ms);    // string name, one vendor
      if (ms > 2500) Sentry.captureMessage('slow editor');
      // cold or warm start? cached code or network? which chunk was slow? unknown.
    `,
    afterFile: 'export.ts · features.ts',
    after: `
      import { metric, unit } from '@staticflux/core';
      import { defineMarkBudget, markBudgetUnit, perfUnits } from '@staticflux/perf';
      import { defineFeature } from '@staticflux/runtime';

      // typed metric; producers declare informs, consumers reads (checked by the graph tool)
      export const ExportDuration = metric.histogram('studio/export-duration', { unit: 'ms' });

      export const exportUnit = unit({
        id: 'studio/export-unit', provides: ExportToken, scope: 'feature', informs: [ExportDuration],
        create: (_deps, ctx) => ({
          async run(id: string) {
            const start = ctx.telemetry.now();
            const result = await exportPdf(id, ctx.signal);
            ctx.telemetry.record(ExportDuration, ctx.telemetry.now() - start, { ok: result.ok });
            return result;
          },
        }),
      });

      // feature marks are framework-measured; declare who reports which
      defineFeature({ id: Features.studioDesktop.id, weight: 'heavy', load,
        readiness: { firstRender: 'framework', interactive: 'feature', complete: 'feature' } });

      // opt in once: a journey trace per navigation, budgets per mark × start × device tier
      const units = [...perfUnits, markBudgetUnit(defineMarkBudget({
        feature: 'studio/desktop', mark: 'interactive', maxMs: 700, starts: ['warm'], reason: 'R12.7' }))];
    `,
    benefit:
      'Framework primitives already emit spans for boot, DI resolution, every navigation stage, chunk loads and requests, so registering `perfUnits` yields a journey trace from first input to feature complete — classified cold / warm / soft, with code source (network, HTTP cache, SW) and critical path. Your own metrics are typed declarations; sinks are pluggable, so the vendor is a plugin, and budget overruns land in one conformance stream that CI can fail on.',
    packages: ['perf', 'core', 'runtime', 'devtools'],
  },
  {
    title: 'Synchronous localStorage → one AsyncStore',
    lede: 'Synchronous reads on the main thread, JSON parsing everywhere, quota errors nobody catches — and a rewrite of every call site when you move to IndexedDB.',
    beforeFile: 'prefs.ts',
    before: `
      // throws in some private modes and sandboxed iframes
      const prefs = JSON.parse(localStorage.getItem('prefs') ?? '{}');
      prefs.theme = 'dark';
      localStorage.setItem('prefs', JSON.stringify(prefs));  // QuotaExceededError → ?

      // other tabs? a 'storage' listener somewhere, maybe.
      // moving to IndexedDB later = making every call site async.
    `,
    afterFile: 'prefs.ts',
    after: `
      import { createIndexedDbStore, createLocalStorageStore, createMemoryStore, createStore } from '@staticflux/storage';

      // first available backend wins; failures at runtime fail over (reported)
      const prefs = createStore<Prefs>({
        backend: [createIndexedDbStore({ namespace: 'prefs' }), createLocalStorageStore({ prefix: 'app:' }),
          () => createMemoryStore()],
      });
      if (!prefs.ok) return prefs;                 // only when no backend is available at all

      const theme = await prefs.value.get('theme', { signal });   // Promise<Result<Prefs | undefined>>
      if (!theme.ok && theme.error.code === 'SF-STORE-001') warnQuotaFull();  // typed errors
      await prefs.value.set('theme', { mode: 'dark' });

      prefs.value.watch((change) => {             // cross-tab changes, same interface
        if (change.type === 'set' && change.origin === 'external') reload(change.key);
      });
    `,
    benefit:
      'One async interface — `get`, `set`, `delete`, `has`, `clear`, `seek`, `batch`, `watch` — over memory, Web Storage, cookies, IndexedDB, OPFS or a remote store, every call returning a typed `Result`. Middleware (namespace, TTL, codecs, AES-GCM encryption, budgets, telemetry, tiered local ⇄ remote) returns the same interface, so you can change the backend later without touching a single consumer.',
    packages: ['storage', 'data', 'handoff'],
  },
  {
    title: 'Manual auth refresh races → single-flight session + epoch refresh',
    lede: 'Tokens in localStorage, ten parallel 401s triggering ten refreshes, tabs out of sync, and the previous user’s data still on screen after an account switch.',
    beforeFile: 'api.ts',
    before: `
      let token = localStorage.getItem('token');   // readable by any script on the page

      async function api(path: string) {
        let res = await fetch(path, { headers: { Authorization: \`Bearer \${token}\` } });
        if (res.status === 401) {
          token = await refreshToken();              // 10 parallel 401s → 10 refreshes,
          localStorage.setItem('token', token);      // 9 of them rotate a revoked token
          res = await fetch(path, { headers: { Authorization: \`Bearer \${token}\` } });
        }
        return res.json();
      }
      // other tabs keep the old token; caches keep the old user's data
    `,
    afterFile: 'compose.ts',
    after: `
      import { authorizedTransportUnit, bffCookieProviderUnit, createSessionUnit,
        fetchAuthTransportUnit } from '@staticflux/auth';

      const auth = [
        // recommended: tokens stay in the BFF; the browser sees a session endpoint + CSRF header
        bffCookieProviderUnit({ endpoints: BFF_ENDPOINTS, csrf: { header: 'x-csrf' } }),
        createSessionUnit({ channelName: 'app/session' }), // one session model, synced across tabs
        fetchAuthTransportUnit,
        authorizedTransportUnit,   // grant headers in; 401 → ONE single-flight refresh → one retry
        epochRefreshListenerUnit,  // session change → supervisor.refresh(): the epoch bumps
      ];

      // data that must follow the user re-initializes on the epoch; stale responses are dropped
      export const docsUnit = unit({
        id: 'docs/list-unit', provides: DocsToken, scope: 'session', refreshOn: ['epoch'],
        deps: { required: { resources: ResourcesToken } },
        create: ({ resources }) => createDocsList(resources),
      });
    `,
    benefit:
      'Refresh is single-flight (optionally under a Web Lock across tabs), so concurrent 401s coalesce into one refresh and one retry each. Raw tokens never leave the auth package by default, never touch Web Storage, BroadcastChannel or telemetry. A session change bumps the app epoch — units with `refreshOn` refresh, responses tagged with an old epoch are discarded (I-10) — and logout disposes the whole session scope. No page reload.',
    packages: ['auth', 'runtime', 'data'],
  },
  {
    title: 'Synchronous navigation → an async pipeline with exit guards',
    lede: 'A click handler that pushes history and renders immediately, a blocking `confirm()` for unsaved work, and a Back button that skips the guard.',
    beforeFile: 'nav.ts',
    before: `
      link.addEventListener('click', (e) => {
        e.preventDefault();
        if (editor.dirty && !confirm('Leave without saving?')) return; // blocking; can't save first
        history.pushState({}, '', '/docs');
        render(routes['/docs']());   // renders before any auth check; code already in the bundle
      });                            // a second click races the first
      window.onpopstate = () => render(routes[location.pathname]());   // Back skips the guard
    `,
    afterFile: 'routes.ts · editor.ts',
    after: `
      // typed route; the feature binds to a capability and the router picks the per-mode variant
      export const DocRoute = defineRoute({
        id: 'studio/doc', parent: StudioRoute, path: 'doc/:id',
        search: { tab: searchParam.enum(['content', 'comments', 'history'], { default: 'content', kind: 'view' }) },
        feature: bindCapability('studio/editor', [
          { feature: Features.studioDesktop, modes: ['expanded', 'medium'] },
          { feature: Features.studioMobile, modes: ['compact'] },
        ]),
      });

      // leaving the editor waits for the save: async, uninterruptible, bound to the UI scope
      router.guardExit(DocRoute, guard(async (_navigation, signal) => {
        const flushed = await doc.flush(signal);
        return flushed.ok ? proceed() : err(flushed.error);
      }, { uninterruptible: true, name: 'studio/save-before-leave' }), uiScope);

      // typed params; newest navigation cancels older ones; Back runs the same pipeline
      const result = await router.navigate({ to: DocRoute, params: { id: '42' } });
    `,
    benefit:
      'Navigation runs thirteen named stages — resolve, exit, availability, auth, authorize, load, enter, render, commit and more — each a span, each able to redirect, block or cancel. Guards can await real work, code for a route loads only after auth and authorization pass, concurrent navigations cancel the older one, and Back/Forward go through the very same pipeline (reverted if blocked). `?tab=` changes run a light view pipeline without reactivating the feature.',
    packages: ['router', 'urlstate', 'runtime'],
  },
];

function body(): Raw {
  return html`
<div class="ba-intro">
  <p class="lead">${md('Every large app runs into the same handful of problems. Here are ten of them, written the usual way and then the StaticFlux way — with the real APIs. Each “after” is lifted from, or modelled on, the Studio example app.')}</p>
  <ol class="ba-index">${EXAMPLES.map((e, i) => html`<li><a href="#${slug(e.title)}"><span>${String(i + 1).padStart(2, '0')}</span>${e.title}</a></li>`)}</ol>
</div>
${EXAMPLES.map((e, i) => beforeAfter(e, i))}
<section class="cta" aria-labelledby="ba-cta">
  <h2 id="ba-cta" class="display">Most of these “afters” come straight from the Studio example.</h2>
  <p>Six features, thirty-eight adapters, every vertical — against mock services.</p>
  <div class="hero__cta hero__cta--center"><a class="btn btn--primary" href="${href('example/')}">Tour the example app</a><a class="btn btn--ghost" href="${href('getting-started/')}">Get started</a></div>
</section>`;
}

export const beforeAfterPage: Page = {
  path: 'before-after/',
  title: 'Before / After',
  description: 'Ten everyday problems in large web apps, side by side: the usual way, and the StaticFlux way with real code — units, component deps, variant bindings, scopes, surfaces, Tasks, metrics, AsyncStore, sessions and the navigation pipeline.',
  nav: 'before-after',
  layout: 'doc',
  wide: true,
  hero: {
    eyebrow: 'Before / After',
    title: 'The same problems. A different shape.',
    lede: 'Ten side-by-side examples — from god objects to navigation races — and why the StaticFlux version holds up as the app and the team grow.',
  },
  body,
};
