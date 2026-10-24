/** Site-wide constants shared by the build-time renderer. */

/** GitHub Pages project base (the repo is `akriti2591/staticflux`). */
export const BASE = '/staticflux/';
export const REPO = 'akriti2591/staticflux';
export const GITHUB = `https://github.com/${REPO}`;
export const SITE_URL = `https://akriti2591.github.io${BASE}`;

/** Site-relative link: `href('guides/')` → `/staticflux/guides/`. */
export function href(path: string): string {
  return `${BASE}${path.replace(/^\//, '')}`;
}

/** Link to a file on GitHub (main branch). */
export function gh(path: string): string {
  return `${GITHUB}/blob/main/${path.replace(/^\//, '')}`;
}

export function agentsMd(pkg: string): string {
  const group = ['sf', 'vite-plugin', 'rspack-plugin'].includes(pkg) ? 'tooling' : 'packages';
  return gh(`${group}/${pkg}/AGENTS.md`);
}

export type NavId = 'home' | 'philosophy' | 'before-after' | 'start' | 'guides' | 'packages' | 'example';

export const NAV: readonly { readonly id: NavId; readonly label: string; readonly path: string }[] = [
  { id: 'philosophy', label: 'Philosophy', path: 'philosophy/' },
  { id: 'before-after', label: 'Before / After', path: 'before-after/' },
  { id: 'start', label: 'Get started', path: 'getting-started/' },
  { id: 'guides', label: 'Guides', path: 'guides/' },
  { id: 'packages', label: 'Packages', path: 'packages/' },
  { id: 'example', label: 'Example app', path: 'example/' },
];
