import { callout, code, h3, readMore, sh, step } from '../components.js';
import { html, md, paras, type Raw } from '../html.js';
import type { Page } from '../layout.js';
import { GITHUB, gh, href } from '../site.js';
import { loadAdapters } from './example.js';

function body(): Raw {
  return html`
${paras(
  'This tutorial builds a tiny app the StaticFlux way: a unit, a boot, a lazily loaded feature, a typed route, a self-injecting component and a test. Every API below is the real one — the same ones the Studio example uses at scale.',
)}
${callout('note', 'Status', 'StaticFlux is developed as a pnpm monorepo. Packages build to plain ESM with `tsc` and are consumed from the workspace (`workspace:*`); the Studio example and this site import them straight from source.')}

${step(
  1,
  'Install',
  html`
  <p>${md('You need **Node ≥ 22** and **pnpm 10** (`corepack enable` gives you the pinned version).')}</p>
  ${sh(`
    git clone ${GITHUB}.git
    cd staticflux
    pnpm install
    pnpm build        # tsc -b: every package → dist/ (+ Wasm engines when Rust is installed)
    pnpm test         # vitest (happy-dom), tests import packages from source
  `)}
  <p>${md('Rust is optional: without it the Wasm build is skipped with a warning (`SF_REQUIRE_RUST=1` makes it required, as in CI). Run the full gate the CI runs — build, typecheck, tests, boundaries, StaticFlux lint, error catalog, size budgets and licenses — with `pnpm check`; `pnpm test:browser` runs the real-Chromium suites (Playwright). Then boot the example app:')}</p>
  ${sh(`
    cd apps/studio
    npx vite          # http://localhost:5173 — packages resolve from source, no build needed
  `)}`,
)}

${step(
  2,
  'Compose an app',
  html`
  <p>${md('Everything starts with a **token** (a typed identity) and a **unit** (what it provides, what it requires, how to create it). Units are data; nothing runs until something asks.')}</p>
  ${code(
    `
    import { token, unit } from '@staticflux/core';

    export interface Greeter {
      greet(name: string): string;
    }
    // The id is namespaced and type-checked; the type parameter is what injection returns.
    export const GreeterToken = token('hello/greeter').type<Greeter>();

    export const greeterUnit = unit({
      id: 'hello/greeter-unit',
      provides: GreeterToken,
      scope: 'app',
      create: (): Greeter => ({ greet: (name) => \`Hello, \${name}!\` }),
    });
    `,
    { file: 'src/app/greeter.ts' },
  )}
  <p>${md('`bootApp` creates the injector and the app supervisor, resolves the **critical** units in dependency order (traced as `app.boot` → `boot.core` → `boot.critical`), and moves the app lifecycle `starting → core-ready → running`. It returns a `Result` — boot never throws at you.')}</p>
  ${code(
    `
    import { createTelemetry } from '@staticflux/core';
    import { bootApp, runtimeUnits } from '@staticflux/runtime';
    import { greeterUnit, GreeterToken } from './app/greeter.js';

    const booted = await bootApp({
      units: [...runtimeUnits, greeterUnit],
      telemetry: createTelemetry({ defaultLevel: 'standard' }),
    });
    if (!booted.ok) throw booted.error;             // an SfError with a stable code and a fix

    const greeter = await booted.value.injector.get(GreeterToken);   // Promise<Result<Greeter>>
    if (greeter.ok) console.log(greeter.value.greet('Ada'));
    `,
    { file: 'src/main.ts' },
  )}
  ${h3('Just the injector')}
  <p>${md('Libraries, workers and tests can use the injector on its own — no supervisor, no lifecycle:')}</p>
  ${code(
    `
    import { composeUnits, createInjector } from '@staticflux/core';

    // compile-time completeness: if a unit requires a token nobody provides, this line
    // fails to type-check and the error names the missing token id.
    const units = composeUnits([greeterUnit]);

    const injector = createInjector({ units });
    const greeter = await injector.get(GreeterToken);
    await injector.dispose();                        // disposes every instance's scope
    `,
  )}`,
)}

${step(
  3,
  'Add a feature',
  html`
  <p>${md('A **feature** is a manifest (data: id, weight, modes, budgets) plus a module (hooks: `activate`, `mount`, `hide`, `unmount`, …) that lives in its own chunk. The runtime’s feature host drives its lifecycle — `declared → loading → loaded → activating → activated → mounting → mounted` — and gives every state its own scope.')}</p>
  ${code(
    `
    import { ok } from '@staticflux/core';
    import { defineFeatureModule } from '@staticflux/runtime';
    import { html, nothing, render } from 'lit';
    import { GreeterToken, greeterUnit } from '../../app/greeter.js';

    export const helloModule = defineFeatureModule({
      units: [greeterUnit],                  // registered in the feature injector on activation
      async mount(context) {
        const greeter = await context.injector.get(GreeterToken, context.signal);
        if (!greeter.ok) return greeter;
        const target = context.target;                  // the outlet the router passed in
        if (!(target instanceof HTMLElement)) return ok(); // headless (tests): nothing to paint
        render(html\`<p>\${greeter.value.greet('Ada')}</p>\`, target);
        context.uiScope.defer(() => render(nothing, target));   // unmount cleans up
        return ok();
      },
    });
    `,
    { file: 'src/features/hello/module.ts' },
  )}
  ${code(
    `
    import { contribution } from '@staticflux/core';
    import { defineFeature, FeatureManifestsToken, featureRef } from '@staticflux/runtime';

    export const HelloFeature = featureRef('hello/greeting');

    export const helloManifest = defineFeature({
      id: HelloFeature.id,
      weight: 'cheap',               // cheap: recreate · warm: keep logic alive · heavy: archive
      load: async () => (await import('../features/hello/module.js')).helloModule,  // own chunk
      description: 'Greets the visitor.',
    });

    export const helloFeatureUnit = contribution({
      id: 'hello/feature-manifest',
      provides: FeatureManifestsToken,   // a multi token: every contribution joins the list
      scope: 'app',
      create: () => helloManifest,
    });
    `,
    { file: 'src/app/features.ts' },
  )}`,
)}

${step(
  4,
  'Add a route',
  html`
  <p>${md('Routes are typed values. A route binds a **capability** to candidate features; the pipeline’s availability stage picks the one that matches the current mode, and the load stage activates it — only after the auth and authorize stages passed.')}</p>
  ${code(
    `
    import { bindCapability, defineRoute } from '@staticflux/router';
    import { HelloFeature } from './features.js';

    export const HomeRoute = defineRoute({ id: 'app/home', path: '/' });

    export const HelloRoute = defineRoute({
      id: 'hello/page',
      path: '/hello/:name',                 // params are inferred: { name: string }
      feature: bindCapability('hello/page', [{ feature: HelloFeature }]),
    });
    `,
    { file: 'src/app/routes.ts' },
  )}
  ${code(
    `
    import { allModesProfileUnit, browserHistoryUnit, featureHostDriverUnitWith, routerSubsystemUnit,
      routerUnitWith, routeUnit, RouterToken } from '@staticflux/router';

    const outlet = document.querySelector<HTMLElement>('#outlet')!;

    const units = [
      ...runtimeUnits,
      routerUnitWith({ notFound: HomeRoute }),
      routerSubsystemUnit,                                    // runs the first navigation on start
      browserHistoryUnit,                                     // Navigation API → History API
      allModesProfileUnit,
      featureHostDriverUnitWith({ targetFor: () => outlet }), // where route features mount
      routeUnit(HomeRoute),
      routeUnit(HelloRoute),
      helloFeatureUnit,
    ];

    // later, anywhere that injected the router:
    const result = await router.navigate({ to: HelloRoute, params: { name: 'ada' } });
    if (result.outcome !== 'committed') console.warn(result.outcome);  // cancelled | blocked | failed
    `,
    { file: 'src/main.ts' },
  )}`,
)}

${step(
  5,
  'Add a component',
  html`
  <p>${md('Components are Lit elements that **self-inject** their dependencies from the nearest `<sf-scope>`. Declare them as `render` (block on a placeholder), `lazy` (arrive any time, reactive) or `functional` (resolved — and loaded — on first use).')}</p>
  ${code(
    `
    import { isMatchOf, RouterToken } from '@staticflux/router';
    import { component, defineComponent, SfElement } from '@staticflux/ui';
    import { html } from 'lit';

    const helloSpec = component({
      tag: 'hello-card',
      deps: { render: { greeter: GreeterToken, router: RouterToken } },
      size: { block: '64px' },        // the placeholder reserves this: no layout shift
    });

    export class HelloCard extends SfElement<typeof helloSpec> {
      static override readonly spec = helloSpec;

      override render() {
        const { greeter, router } = this.deps;   // typed, ready, reactive (MobX)
        const match = router.current;
        const name = isMatchOf(match, HelloRoute) ? match.params.name : 'world';
        return html\`<p>\${greeter.greet(name)}</p>\`;
      }
    }
    defineComponent(HelloCard);
    `,
    { file: 'src/ui/hello-card.ts' },
  )}
  <p>${md('Provide the root scope once — the app injector and the UI environment (one render pass per frame through the runtime frame scheduler). Register `uiUnits` alongside `runtimeUnits`.')}</p>
  ${code(
    `
    import { defineUiElements, uiUnits, UiEnvironmentToken } from '@staticflux/ui';
    import { html, render } from 'lit';

    defineUiElements();                                   // <sf-scope>, <sf-skeleton>
    const environment = await app.injector.get(UiEnvironmentToken);
    if (!environment.ok) throw environment.error;
    render(
      html\`<sf-scope .injector=\${app.injector} .environment=\${environment.value}><hello-card></hello-card></sf-scope>\`,
      document.querySelector<HTMLElement>('#app')!,
    );
    `,
  )}`,
)}

${step(
  6,
  'Test it',
  html`
  <p>${md('`@staticflux/testkit` gives you a test injector with top-precedence overrides and recorded telemetry, deterministic fake time, a fake session and `bootTestApp` for routing and boot paths. Assert on values **and** on span structure.')}</p>
  ${code(
    `
    import { describe, expect, it } from 'vitest';
    import { bootTestApp, createTestInjector } from '@staticflux/testkit';

    describe('greeter', () => {
      it('greets', async () => {
        const t = createTestInjector({ units: [greeterUnit] });
        const greeter = await t.get(GreeterToken);          // throws SF-TEST-002 if it can't resolve
        expect(greeter.greet('Ada')).toBe('Hello, Ada!');
        expect(t.spans({ name: 'di.resolve', attrs: { unit: 'hello/greeter-unit' } })).toHaveLength(1);
        t.expectNoViolations();
        await t.dispose();
      });

      it('routes to the feature', async () => {
        const t = await bootTestApp({
          units: [...runtimeUnits, helloFeatureUnit],
          routes: [HomeRoute, HelloRoute],                   // adds router + memory history
          initialUrl: '/hello/ada',
          time: true,                                        // fake time for the scheduler
        });
        expect(t.router?.current?.route).toBe(HelloRoute);
        t.expectChildSpan('app.boot', 'boot.critical');
        await t.shutdown();
      });
    });
    `,
    { file: 'src/app.test.ts' },
  )}
  ${sh(`
    npx vitest run packages/core        # one package
    pnpm test                           # everything
  `)}`,
)}

<h2 id="next">Next steps</h2>
<ul class="cards">
  <li><a class="card" href="${href('guides/core-di/')}"><h3>Core &amp; DI</h3><p>Dependency kinds, init timing, hooks, scopes, variants and the compile-time checks.</p></a></li>
  <li><a class="card" href="${href('guides/lifecycles/')}"><h3>Lifecycles</h3><p>App, subsystem, feature and unit state machines, and their invariants.</p></a></li>
  <li><a class="card" href="${href('example/')}"><h3>The Studio example</h3><p>Six features and ${loadAdapters().length} adapters composing every package.</p></a></li>
  <li><a class="card" href="${gh('CONTRIBUTING.md')}"><h3>Contributing</h3><p>Repo layout, rules, adding a package, the <code>pnpm check</code> gate.</p></a></li>
</ul>
${readMore('core', 'runtime', 'router', 'ui', 'testkit')}
`;
}

export const gettingStartedPage: Page = {
  path: 'getting-started/',
  title: 'Get started',
  description: 'Install the StaticFlux monorepo, compose an app from tokens and units with createInjector and bootApp, then add a lazily loaded feature, a typed route, a self-injecting Lit component and tests.',
  nav: 'start',
  layout: 'doc',
  toc: true,
  hero: {
    eyebrow: 'Get started',
    title: 'From one unit to a running app.',
    lede: 'Six steps: install, compose, add a feature, a route and a component, and test them — with the real APIs.',
  },
  body,
};
