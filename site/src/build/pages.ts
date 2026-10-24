/** Every page of the site, in navigation order. Each becomes `<path>index.html` at build time. */
import { html } from './html.js';
import type { Page } from './layout.js';
import { href } from './site.js';
import { beforeAfterPage } from './content/before-after.js';
import { examplePage } from './content/example.js';
import { gettingStartedPage } from './content/getting-started.js';
import { guidePages, guidesIndexPage } from './content/guides.js';
import { homePage } from './content/home.js';
import { packagesPage } from './content/packages.js';
import { philosophyPage } from './content/philosophy.js';

const notFound: Page = {
  path: '404',
  title: 'Page not found',
  description: 'This page does not exist.',
  nav: 'home',
  layout: 'doc',
  hero: { eyebrow: '404 · SF-NAV-001', title: 'This route did not resolve.', lede: 'The navigation pipeline ran, and no route matched. It happens to the best of us.' },
  body: () => html`<p><a class="btn btn--primary" href="${href('')}">Back to the home page</a> <a class="btn btn--ghost" href="${href('guides/')}">Browse the guides</a></p>`,
};

export const pages: readonly Page[] = [
  homePage,
  philosophyPage,
  beforeAfterPage,
  gettingStartedPage,
  guidesIndexPage,
  ...guidePages,
  packagesPage,
  examplePage,
  notFound,
];
