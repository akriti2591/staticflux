/**
 * The page frame: document head, skip link, header navigation, the theme island,
 * the footer (with the live boot-trace island) and an optional docs sidebar + "on this page" TOC.
 */
import { Islands, island } from './components.js';
import { html, md, raw, type Raw } from './html.js';
import { themeCss } from '../shared/theme-tokens.js';
import { GITHUB, href, NAV, type NavId, SITE_URL } from './site.js';

export interface SidebarGroup {
  readonly title: string;
  readonly links: readonly { readonly label: string; readonly path: string }[];
}

export interface Page {
  /** Output path relative to the site root: '' (home), 'philosophy/', … */
  readonly path: string;
  readonly title: string;
  readonly description: string;
  readonly nav: NavId;
  /** `landing` = full-bleed sections; `doc` = prose column (+ sidebar/TOC). */
  readonly layout: 'landing' | 'doc';
  readonly sidebar?: readonly SidebarGroup[];
  /** Wider content column (side-by-side code). */
  readonly wide?: boolean;
  /** Show an "On this page" table of contents built from the page's h2s. */
  readonly toc?: boolean;
  /** Eyebrow + title + lede rendered above doc content. */
  readonly hero?: { readonly eyebrow: string; readonly title: string; readonly lede: Raw | string };
  readonly body: () => Raw;
}

/** Pre-paint theme: the only synchronous storage read on the site. It mirrors the
 * async `AsyncStore` (`@staticflux/storage`, JSON codec, prefix `sf-site:`) that the
 * shell ThemeController persists to, so the first paint already uses the chosen theme. */
const PREPAINT = `try{var p=JSON.parse(localStorage.getItem('sf-site:shell/theme')||'null');if(p==='light'||p==='dark'||p==='high-contrast')document.documentElement.dataset.theme='site/'+p}catch(e){}`;

const LOGO = raw(`<svg class="logo" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><circle cx="16" cy="16" r="5.5" fill="currentColor"/><ellipse cx="16" cy="16" rx="13" ry="5.2" fill="none" stroke="var(--site-flux)" stroke-width="2" transform="rotate(-28 16 16)"/><ellipse cx="16" cy="16" rx="13" ry="5.2" fill="none" stroke="var(--site-flux-2)" stroke-width="2" transform="rotate(32 16 16)"/></svg>`);

const ICONS = {
  system: raw(`<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><rect x="2.5" y="3.5" width="15" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M7 17h6M10 13.5V17" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`),
  light: raw(`<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><circle cx="10" cy="10" r="3.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 1.8v2M10 16.2v2M1.8 10h2M16.2 10h2M4.2 4.2l1.4 1.4M14.4 14.4l1.4 1.4M4.2 15.8l1.4-1.4M14.4 5.6l1.4-1.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`),
  dark: raw(`<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M16.5 12.6A7 7 0 0 1 7.4 3.5a7 7 0 1 0 9.1 9.1Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`),
  github: raw(`<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>`),
  menu: raw(`<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M3 6h14M3 10h14M3 14h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`),
};

function themeSwitch(): Raw {
  const button = (pref: 'system' | 'light' | 'dark', label: string): Raw =>
    html`<button type="button" class="theme-switch__btn" data-theme-pref="${pref}" aria-pressed="${pref === 'system' ? 'true' : 'false'}" title="${label}">${ICONS[pref]}<span class="vh">${label}</span></button>`;
  return island(
    Islands.theme,
    html`<div class="theme-switch" role="group" aria-label="Color theme">${button('system', 'Match system theme')}${button('light', 'Light theme')}${button('dark', 'Dark theme')}</div>`,
    { hydrate: 'idle', attributes: { class: 'island-inline' } },
  );
}

function navLinks(current: NavId): Raw {
  return html`${NAV.map((item) => html`<li><a href="${href(item.path)}"${raw(item.id === current ? ' aria-current="page"' : '')}>${item.label}</a></li>`)}`;
}

function header(current: NavId): Raw {
  return html`<header class="site-header">
  <div class="site-header__inner">
    <a class="brand" href="${href('')}" aria-label="StaticFlux home">${LOGO}<span class="brand__name">Static<span>Flux</span></span></a>
    <nav class="nav nav--desktop" aria-label="Main"><ul>${navLinks(current)}</ul></nav>
    <div class="site-header__tools">
      ${themeSwitch()}
      <a class="icon-link" href="${GITHUB}" aria-label="StaticFlux on GitHub">${ICONS.github}</a>
      <details class="menu">
        <summary aria-label="Menu">${ICONS.menu}</summary>
        <nav class="nav nav--mobile" aria-label="Main (mobile)"><ul>${navLinks(current)}<li><a href="${GITHUB}">GitHub</a></li></ul></nav>
      </details>
    </div>
  </div>
</header>`;
}

function footer(): Raw {
  return html`<footer class="site-footer">
  <div class="site-footer__inner">
    <div class="site-footer__brand">
      <a class="brand" href="${href('')}">${LOGO}<span class="brand__name">Static<span>Flux</span></span></a>
      <p>Static core, flux implementations. A client-side TypeScript framework for large web apps, built from building blocks that work best together.</p>
    </div>
    <nav class="site-footer__links" aria-label="Footer">
      <div><p class="site-footer__heading">Learn</p><ul><li><a href="${href('philosophy/')}">Philosophy</a></li><li><a href="${href('before-after/')}">Before / After</a></li><li><a href="${href('getting-started/')}">Get started</a></li><li><a href="${href('guides/')}">Guides</a></li></ul></div>
      <div><p class="site-footer__heading">Reference</p><ul><li><a href="${href('packages/')}">Packages</a></li><li><a href="${href('example/')}">Example app</a></li><li><a href="${GITHUB}/blob/main/docs/REQUIREMENTS.md">Requirements</a></li><li><a href="${GITHUB}/blob/main/docs/LIFECYCLES.md">Lifecycles</a></li></ul></div>
      <div><p class="site-footer__heading">Project</p><ul><li><a href="${GITHUB}">GitHub</a></li><li><a href="${GITHUB}/blob/main/CONTRIBUTING.md">Contributing</a></li><li><a href="${GITHUB}/blob/main/AGENTS.md">AGENTS.md</a></li><li><a href="${GITHUB}/blob/main/docs/errors.json">Error catalog</a></li></ul></div>
    </nav>
    ${island(
      Islands.bootTrace,
      html`<div class="boot-trace"><p class="boot-trace__title">This page runs on StaticFlux</p><p class="boot-trace__text">It boots a small app — injector, theme controller, announcer, URL sync — and hydrates its interactive islands on demand. With JavaScript on, the live boot waterfall appears here.</p><site-boot-trace></site-boot-trace></div>`,
      { hydrate: 'visible', attributes: { class: 'site-footer__trace' } },
    )}
  </div>
  <p class="site-footer__legal">Built with <code>@staticflux/core</code>, <code>runtime</code>, <code>ui</code>, <code>shell</code>, <code>a11y</code>, <code>urlstate</code>, <code>storage</code>, <code>loader</code>, <code>hydrate</code> and the Vite plugin.</p>
</footer>`;
}

function sidebar(groups: readonly SidebarGroup[], path: string): Raw {
  const items = html`${groups.map(
    (group) => html`<div class="sidebar__group"><p class="sidebar__title">${group.title}</p><ul>${group.links.map(
      (link) => html`<li><a href="${href(link.path)}"${raw(link.path === path ? ' aria-current="page"' : '')}>${link.label}</a></li>`,
    )}</ul></div>`,
  )}`;
  // Two renderings, one shown per breakpoint: a sticky list on wide screens, a collapsed disclosure on small ones.
  return html`<aside class="sidebar" aria-label="Section navigation"><nav class="sidebar__wide" aria-label="Guides">${items}</nav><details class="sidebar__details"><summary>Guides in this section</summary><nav aria-label="Guides (compact)">${items}</nav></details></aside>`;
}

function toc(body: string): Raw {
  const entries = [...body.matchAll(/<h2 id="([^"]+)"[^>]*>(?:<a class="anchor"[^>]*>#<\/a>)?([\s\S]*?)<\/h2>/g)].map((m) => ({ id: m[1] ?? '', label: (m[2] ?? '').replace(/<[^>]+>/g, '') }));
  if (entries.length < 2) return raw('');
  return html`<nav class="toc" aria-label="On this page"><p class="toc__title">On this page</p><ol>${entries.map((e) => html`<li><a href="#${e.id}">${raw(e.label)}</a></li>`)}</ol></nav>`;
}

export function renderPage(page: Page): string {
  const body = page.body().__raw;
  const title = page.path === '' ? `StaticFlux — ${page.title}` : `${page.title} · StaticFlux`;
  const hero =
    page.hero === undefined
      ? ''
      : html`<header class="doc-hero"><p class="eyebrow">${page.hero.eyebrow}</p><h1>${page.hero.title}</h1><p class="doc-hero__lede">${typeof page.hero.lede === 'string' ? md(page.hero.lede) : page.hero.lede}</p></header>`.__raw;
  const content =
    page.layout === 'landing'
      ? body
      : html`<div class="doc-shell${page.sidebar === undefined ? '' : ' doc-shell--sidebar'}${page.toc === true ? ' doc-shell--toc' : ''}${page.wide === true ? ' doc-shell--wide' : ''}">
  ${page.sidebar === undefined ? '' : sidebar(page.sidebar, page.path)}
  <div class="doc-main">${raw(hero)}<div class="prose">${raw(body)}</div></div>
  ${page.toc === true ? toc(body) : ''}
</div>`.__raw;

  return `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${html`${title}`.__raw}</title>
<meta name="description" content="${html`${page.description}`.__raw}">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f5f1ea" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0d0f12" media="(prefers-color-scheme: dark)">
<meta property="og:title" content="${html`${title}`.__raw}">
<meta property="og:description" content="${html`${page.description}`.__raw}">
<meta property="og:type" content="website">
<meta property="og:url" content="${SITE_URL}${page.path}">
<link rel="canonical" href="${SITE_URL}${page.path}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght,SOFT@0,9..144,500..800,0..100;1,9..144,500..800,0..100&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style id="sf-theme">${themeCss()}</style>
<script>${PREPAINT}</script>
<script type="module" src="/src/client/main.ts"></script>
</head>
<body class="page page--${page.nav} layout--${page.layout}">
<a class="skip-link" href="#main">Skip to content</a>
${header(page.nav).__raw}
<main id="main" tabindex="-1">
${content}
</main>
${footer().__raw}
</body>
</html>
`;
}
