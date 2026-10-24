/**
 * Build-time building blocks of the docs pages. Interactive parts are emitted as
 * `@staticflux/hydrate` island markers (`renderIslandMarker`), so the HTML is complete
 * and readable without JavaScript and each island hydrates lazily in the browser.
 */
import { renderIslandMarker } from '@staticflux/hydrate';
import { dedent, highlight, type Lang } from './highlight.js';
import { html, md, raw, type Interpolation, type Raw, slug } from './html.js';
import { agentsMd } from './site.js';

/** Island chunk ids — the same logical ids the client declares with `chunk()` (src/client/chunks.ts). */
export const Islands = {
  theme: 'island:theme',
  code: 'island:code',
  packages: 'island:packages',
  bootTrace: 'island:boot-trace',
} as const;

type IslandChunk = (typeof Islands)[keyof typeof Islands];

export function island(
  chunk: IslandChunk,
  inner: Raw,
  options: {
    readonly hydrate: 'visible' | 'idle' | 'interaction' | 'never';
    readonly props?: Readonly<Record<string, unknown>>;
    readonly attributes?: Readonly<Record<string, string>>;
  },
): Raw {
  const marker = renderIslandMarker({
    chunk,
    hydrate: options.hydrate,
    html: inner.__raw,
    ...(options.props === undefined ? {} : { props: options.props }),
    ...(options.attributes === undefined ? {} : { attributes: options.attributes }),
  });
  if (!marker.ok) throw marker.error; // fail the build: a malformed island is a bug
  return raw(marker.value);
}

const LANG_LABEL: Readonly<Record<Lang, string>> = { ts: 'TypeScript', sh: 'Shell', json: 'JSON', yaml: 'YAML', html: 'HTML', text: 'Text' };

export interface CodeOptions {
  readonly lang?: Lang;
  readonly file?: string;
  /** Visual tone: neutral (default), `before` (muted) or `after` (accent). */
  readonly tone?: 'before' | 'after';
}

/** A highlighted code block with a copy button (an `interaction` island: hydrates on first click, the click is replayed). */
export function code(source: string, options: CodeOptions = {}): Raw {
  const lang = options.lang ?? 'ts';
  const text = dedent(source);
  const tone = options.tone === undefined ? '' : ` code--${options.tone}`;
  const figure = html`<figure class="code${tone}" data-lang="${lang}">
<figcaption class="code__bar"><span class="code__file">${options.file ?? LANG_LABEL[lang]}</span><button class="code__copy" type="button" data-copy aria-label="Copy code to clipboard"><svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14"><rect x="5" y="5" width="9" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M11 3.5V3a1.5 1.5 0 0 0-1.5-1.5h-6A1.5 1.5 0 0 0 2 3v6A1.5 1.5 0 0 0 3.5 10.5H4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg><span data-copy-label>Copy</span></button></figcaption>
<pre tabindex="0"><code>${raw(highlight(text, lang))}</code></pre>
</figure>`;
  return island(Islands.code, figure, { hydrate: 'interaction' });
}

/** Shell one-liners. */
export function sh(source: string, file?: string): Raw {
  return code(source, { lang: 'sh', ...(file === undefined ? {} : { file }) });
}

export function callout(kind: 'note' | 'rule' | 'warn', title: string, body: Interpolation): Raw {
  return html`<aside class="callout callout--${kind}" role="note"><p class="callout__title">${title}</p>${typeof body === 'string' ? md(body) : body}</aside>`;
}

export function h2(text: string, id = slug(text)): Raw {
  return html`<h2 id="${id}"><a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${text}</h2>`;
}

export function h3(text: string, id = slug(text)): Raw {
  return html`<h3 id="${id}">${text}</h3>`;
}

export function pkgLink(name: string, label = `@staticflux/${name}`): Raw {
  return html`<a class="pkg-link" href="${agentsMd(name)}"><code>${label}</code></a>`;
}

/** "Read the package docs" footer for a guide section. */
export function readMore(...packages: readonly string[]): Raw {
  return html`<p class="read-more"><span>AGENTS.md on GitHub:</span> ${packages.map((p, i) => html`${i === 0 ? '' : ' · '}${pkgLink(p)}`)}</p>`;
}

export function list(items: readonly string[], className = ''): Raw {
  return html`<ul class="${className}">${items.map((item) => html`<li>${md(item)}</li>`)}</ul>`;
}

export interface BeforeAfter {
  readonly title: string;
  readonly lede: string;
  readonly before: string;
  readonly beforeFile?: string;
  readonly after: string;
  readonly afterFile?: string;
  readonly benefit: string;
  readonly packages: readonly string[];
}

export function beforeAfter(item: BeforeAfter, index: number): Raw {
  const id = slug(item.title);
  return html`<article class="ba" id="${id}" aria-labelledby="${id}-title">
  <header class="ba__head">
    <span class="ba__index" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span>
    <div>
      <h2 class="ba__title" id="${id}-title"><a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${item.title}</h2>
      <p class="ba__lede">${md(item.lede)}</p>
    </div>
  </header>
  <div class="ba__grid">
    <section class="ba__col" aria-label="Before">
      <p class="ba__label ba__label--before">Before</p>
      ${code(item.before, { file: item.beforeFile ?? 'the usual way', tone: 'before' })}
    </section>
    <section class="ba__col" aria-label="After, with StaticFlux">
      <p class="ba__label ba__label--after">After · StaticFlux</p>
      ${code(item.after, { file: item.afterFile ?? 'with StaticFlux', tone: 'after' })}
    </section>
  </div>
  <div class="ba__benefit"><p><strong>Why it is better.</strong> ${md(item.benefit)}</p>${readMore(...item.packages)}</div>
</article>`;
}

/** A numbered step for tutorials. */
export function step(n: number, title: string, body: Raw): Raw {
  const id = slug(title);
  return html`<section class="step" aria-labelledby="${id}">
  <div class="step__num" aria-hidden="true">${n}</div>
  <div class="step__body"><h2 id="${id}"><a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${title}</h2>${body}</div>
</section>`;
}
