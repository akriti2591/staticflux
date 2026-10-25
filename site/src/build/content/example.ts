import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { callout, code, h2, readMore, sh } from '../components.js';
import { html, md, paras, type Raw } from '../html.js';
import type { Page } from '../layout.js';
import { gh, href } from '../site.js';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

interface Adapter {
  readonly file: string;
  readonly bridges: string;
  readonly what: string;
}

/** The adapter table is read from apps/studio/README.md at build time, so it always matches the app. */
export function loadAdapters(): readonly Adapter[] {
  const readme = readFileSync(`${repoRoot}apps/studio/README.md`, 'utf8');
  const start = readme.indexOf('| File | Bridges | What |');
  if (start === -1) return [];
  const rows: Adapter[] = [];
  for (const line of readme.slice(start).split('\n').slice(2)) {
    if (!line.startsWith('|')) break;
    const [file, bridges, what] = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (file !== undefined && bridges !== undefined && what !== undefined) rows.push({ file, bridges, what });
  }
  return rows;
}

/** The measured boot JS, read from apps/studio/AGENTS.md (`**Budget (R12.7):** … — **149.1 KB**`). */
function bootJs(): string {
  const agents = readFileSync(`${repoRoot}apps/studio/AGENTS.md`, 'utf8');
  const measured = /^\*\*Budget[^\n]*?\*\*(\d+(?:\.\d+)?) KB\*\*/m.exec(agents)?.[1];
  return measured === undefined ? 'see the build report' : `${measured} KB at the last measurement`;
}

const FEATURES: readonly { readonly id: string; readonly kind: string; readonly weight: string; readonly text: string }[] = [
  { id: 'studio-desktop · studio-mobile', kind: 'UI + logic', weight: 'heavy (archive)', text: 'The editor, as two per-mode features sharing one document store. The document lives in a supervised worker (ECS + Yjs); the main thread renders a read-only projection and sends edits as intents. Co-editing with a mock peer and presence.' },
  { id: 'agent-chat', kind: 'headless logic + panel', weight: 'warm', text: 'Agentic chat over a streamed resource. Its tools are capabilities — insert text, insert image, summarize, clear — gated per subject, confirmed when destructive, metered in credits.' },
  { id: 'onboarding', kind: 'wizard', weight: 'cheap', text: 'Steps as view sub-routes, progress in a user-data slice, a coach mark on the AI button, copy from an experiment variant binding.' },
  { id: 'settings', kind: 'UI', weight: 'cheap', text: 'Theme and locale slices (Arabic included, for RTL), and the expert workspace switch.' },
  { id: 'billing', kind: 'UI + dialogs', weight: 'cheap', text: 'The routable upsell dialog `/d/upgrade`, the low-credit banner and plan facts.' },
];

function body(): Raw {
  const adapters = loadAdapters();
  return html`
${paras(
  '**Studio** is an AI-assisted mixed-media document editor that composes **every StaticFlux vertical** into one app, against mock services only: a mock data transport, a mock BFF session endpoint, a mock collaboration network in the document worker, a mock AI provider and memory / IndexedDB storage. It is the integration proof for the framework — and the place every API was designed against first (`docs/FEATURE-NEEDS.md`).',
)}
${sh(`
  cd apps/studio
  npx vite                                # dev server — packages resolve from source
  npx vite build                          # dist/ + sf-manifest.json, sf-precache.json, sf-build-report.json
  cd ../.. && npx vitest run apps/studio  # headless integration tests: boots the whole app per test
`)}

${h2('Try it')}
<ul>
  <li>${md('`/` — the guest welcome (guest and logged-in are the same app; boot never waits on auth).')}</li>
  <li>${md('`/studio/doc/1?panel=chat&prompt=Add%20an%20image` — redirects to `/login` with the intent held; sign in as *Ada (free)* or *Grace (pro)*, return to the editor with the chat prompt prefilled — never auto-sent.')}</li>
  <li>${md('`/onboarding/step/1` — wizard steps as view sub-routes.')}</li>
  <li>${md('`/settings` — theme, language incl. Arabic / RTL, the expert workspace.')}</li>
  <li>${md('`?sf-mode=web:compact` — the mobile editor variant · `?sf-flag=studio/ai-suggestions:false` — a local flag override · `?sf-debug` — the console telemetry sink.')}</li>
  <li>${md('`Ctrl/⌘+K` — the capability palette from `@staticflux/kit` · `/settings` density Focus / Standard / Pro — the kit restyled through the theme contract.')}</li>
</ul>

${h2('Six features')}
<div class="prose-table"><table>
  <thead><tr><th>Feature</th><th>Kind</th><th>Weight</th><th>What it exercises</th></tr></thead>
  <tbody>${FEATURES.map((f) => html`<tr><td><code>${f.id}</code></td><td>${f.kind}</td><td>${f.weight}</td><td>${md(f.text)}</td></tr>`)}</tbody>
</table></div>
<p>${md('Each feature is a manifest plus a lazily loaded module in its own chunk. Features never import each other: they talk through `src/app/contracts.ts` — tokens, capabilities, intents, URL bindings, slices, surfaces, flags, meters and chunk ids.')}</p>

${h2('Architecture')}
<div class="arch">
  <div class="arch__row"><strong>Entry</strong><span>${md('`index.html` → `main.ts` (inline mode detector) → `boot-browser.ts` → `bootStudio` → `mountStudioUi`')}</span></div>
  <div class="arch__row"><strong>app/</strong><span>${md('`compose.ts` (THE composition) · `contracts.ts` · `routes.ts` · `policies.ts` · `endpoints.ts` · `surfaces.ts` · `features.ts` · `chunks.ts` · `document.ts` · `late.ts` · `shell.ts` · `telemetry.ts`')}</span></div>
  <div class="arch__row"><strong>adapters/</strong><span>${md(`one file per package pair — ${adapters.length} in total`)}</span></div>
  <div class="arch__row"><strong>features/</strong><span>${md('`studio-desktop` · `studio-mobile` · `agent-chat` · `onboarding` · `settings` · `billing` — one chunk each')}</span></div>
  <div class="arch__row"><strong>worker/</strong><span>${md('the document worker: protocol, engine + presence + mock co-editor, spawners')}</span></div>
  <div class="arch__row"><strong>mocks/</strong><span>${md('mock server: BFF session, docs, credits, flags; data routes; shared memory storage')}</span></div>
</div>
${code(
  `
  bootApp
    → critical units: platform facts, app profile, flag resolver
      (+ what they need: session store, data client, storage registry, handoff)
    → core-ready
    → subsystems: router first navigation, meter sync, workspace restore,
      locale ⇄ ?lang, perf marks, post-boot
    → running
  off the boot path: feature chunks, the document runtime (+ worker), the late units chunk (AI, WebMCP, warmup)
  `,
  { lang: 'text', file: 'boot sequence' },
)}

${h2(`${adapters.length} adapters: where packages meet`)}
${paras(
  'Packages never import their siblings; they expose **ports** (tokens, multi tokens, stage plugins, structural interfaces) and stay ignorant of each other. The app bridges them with one small adapter file per package pair, each with a header comment stating what it bridges. When a package has a gap, the workaround lives in the adapter with a `PACKAGE GAP` comment — never as a patch to the package.',
)}
${code(
  `
  // adapters/gate-loader.ts — gate → loader: denied chunks are never fetched (I-8)
  // adapters/auth-router.ts — auth → router: the auth-boundary stage sends guests to /login with returnTo
  // adapters/urlstate-router.ts — urlstate ⇄ router: one shared history, intent capture/authorize plugins
  // adapters/capabilities-gate.ts — gate → capabilities: decide port (agent subject distinct) + meter port
  `,
  { file: 'apps/studio/src/adapters/' },
)}
<ul class="adapters">${adapters.map((a) => html`<li><a href="${gh(`apps/studio/src/adapters/${a.file}.ts`)}"><code>${a.file}.ts</code></a> — ${a.bridges}<span>${md(a.what)}</span></li>`)}</ul>

${h2('What it proves')}
<ul>
  <li>${md('**Every experience type without special cases** — chat (headless agent + UI + streamed resources), wizard (sub-routes, exit guards, persisted progress), complex editor (document worker, projection UI, lazy panels, archive) and co-editing (CRDT + collaboration transport + presence).')}</li>
  <li>${md('**Free vs premium, guest vs logged-in, expert workspace, embedded mode** — all as policies, bindings and per-mode features; no feature reads a flag or a mode.')}</li>
  <li>${md('**Mock services only.** No network, no real auth. Client gating is UX, not security: the mock backend re-checks plan and credits.')}</li>
</ul>
${callout('note', 'Budgets, honestly', `Studio’s \`AGENTS.md\` records its boot JS against the 150 KB gzip budget from the build report — ${bootJs()}, and CI fails the build on a regression. Feature chunks are budgeted beyond the boot set; the heavy editor is exempted up to 200 KB, loaded only after authorize.`)}
<ul class="cards">
  <li><a class="card" href="${gh('apps/studio/README.md')}"><h3>Studio README</h3><p>Run commands, architecture map and the full adapter table.</p></a></li>
  <li><a class="card" href="${gh('apps/studio/src/app/compose.ts')}"><h3>compose.ts</h3><p>The single place every package is wired.</p></a></li>
  <li><a class="card" href="${href('before-after/')}"><h3>Before / After</h3><p>Patterns lifted from Studio, side by side.</p></a></li>
</ul>
${readMore('runtime', 'router', 'gate', 'worker', 'document')}
`;
}

export const examplePage: Page = {
  path: 'example/',
  title: 'Example app: Studio',
  description: 'Studio, the StaticFlux example app: an AI-assisted document editor composing every package against mock services, with six lazily loaded features and one adapter per package pair.',
  nav: 'example',
  layout: 'doc',
  toc: true,
  hero: {
    eyebrow: 'Example app',
    title: 'Studio: every vertical, one app.',
    lede: 'An AI-assisted mixed-media document editor — agentic chat, a document worker, co-editing, gating, credits, a canvas minimap — wired in one composition file and a set of tiny adapters.',
  },
  body,
};
