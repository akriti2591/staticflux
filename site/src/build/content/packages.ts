import { fileURLToPath } from 'node:url';
import { Islands, island } from '../components.js';
import { html, md, type Raw } from '../html.js';
import type { Page } from '../layout.js';
import { LAYER_BLURBS, LAYER_LABELS, LAYER_ORDER, loadPackages, type PackageInfo } from '../packages-data.js';
import { gh } from '../site.js';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

function shortName(pkg: PackageInfo): string {
  return pkg.name.replace('@staticflux/', '');
}

function firstSentence(text: string): string {
  const cut = text.search(/[.;](\s|$)/);
  return cut === -1 ? text : text.slice(0, cut + 1);
}

function card(pkg: PackageInfo): Raw {
  const exportsList = [...new Set(pkg.api.flatMap((a) => a.names))].slice(0, 9);
  const search = [pkg.name, pkg.description, pkg.purpose, ...exportsList, pkg.layer].join(' ').toLowerCase();
  const agents = gh(`${pkg.group}/${pkg.dir}/AGENTS.md`);
  return html`<li data-pkg data-layer="${pkg.layer}" data-search="${search}">
  <article class="pkg" aria-labelledby="pkg-${pkg.dir}">
    <header class="pkg__head"><h3 class="pkg__name" id="pkg-${pkg.dir}"><a href="${agents}">${pkg.name}</a></h3><span class="chip pkg__layer">${pkg.layer}</span></header>
    <p class="pkg__purpose">${md(pkg.description || firstSentence(pkg.purpose))}</p>
    ${exportsList.length === 0 ? '' : html`<p class="pkg__api" aria-label="Key exports">${exportsList.map((name) => html`<code>${name}</code>`)}</p>`}
    <dl class="pkg__meta">
      <dt>Budget</dt>
      <dd>${
        pkg.budgets.length > 0
          ? pkg.budgets.map((b, i) => html`${i === 0 ? '' : ' · '}<code>${b.limit}</code> ${b.name}`)
          : md(firstSentence(pkg.budgetNote ?? 'No size budget (not shipped to browsers).'))
      }</dd>
      ${pkg.internalDeps.length === 0 ? '' : html`<dt>Depends on</dt><dd>${pkg.internalDeps.map((d, i) => html`${i === 0 ? '' : ', '}<code>${d.replace('@staticflux/', '')}</code>`)}</dd>`}
    </dl>
  </article>
</li>`;
}

function body(): Raw {
  const packages = loadPackages(repoRoot);
  const byLayer = LAYER_ORDER.map((layer) => ({ layer, items: packages.filter((p) => p.layer === layer) })).filter((g) => g.items.length > 0);
  const counts: Record<string, number> = { all: packages.length };
  for (const group of byLayer) counts[group.layer] = group.items.length;

  const inner = html`
<div class="pkg-toolbar"><site-package-filter></site-package-filter><p class="pkg-count" data-pkg-count aria-live="polite">${packages.length} packages</p></div>
${byLayer.map(
  (group) => html`<section class="layer-group" data-layer-group aria-labelledby="layer-${group.layer}">
  <header class="layer-group__head"><h2 id="layer-${group.layer}">${LAYER_LABELS[group.layer]}</h2><p>${LAYER_BLURBS[group.layer]}</p></header>
  <ul class="pkg-grid">${group.items.map(card)}</ul>
</section>`,
)}`;

  return html`
<p class="lead">${md('Generated at build time from the repository: names, descriptions and layers from each `package.json`, public API from each `AGENTS.md`, budgets from `.size-limit.json`. Every name links to the package’s `AGENTS.md` on GitHub.')}</p>
<div class="layer-map" aria-label="Packages by layer">
  ${byLayer.map((g) => html`<div class="layer-map__row"><strong>${LAYER_LABELS[g.layer]}</strong><span>${g.items.map((p) => html`<a class="chip" href="#pkg-${p.dir}">${shortName(p)}</a>`)}</span></div>`)}
</div>
<p>${md('A package may import only lower layers (`core < runtime < vertical < ui < shell < feature < app`), checked through each package’s declared dependencies and `pnpm lint:boundaries` (no cycles, no deep imports); same-layer packages talk through ports the app wires together.')}</p>
${island(Islands.packages, inner, { hydrate: 'visible', props: { counts } })}
`;
}

export const packagesPage: Page = {
  path: 'packages/',
  title: 'Packages',
  description: 'Reference index of every StaticFlux package and tool — layer, purpose, key exports, size budgets and dependencies — generated from the repository at build time.',
  nav: 'packages',
  layout: 'doc',
  wide: true,
  hero: {
    eyebrow: 'Reference',
    title: 'Every building block.',
    lede: 'Thirty-one packages and three tools, grouped by layer. Filter by layer or search by name, purpose or export.',
  },
  body,
};
