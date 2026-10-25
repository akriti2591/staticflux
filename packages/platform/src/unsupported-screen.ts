/**
 * The unsupported screen (SF-Δ26, R18.16), subpath `@staticflux/platform/unsupported-screen`.
 * One calm page: a title, "use Chrome", then each missing capability with its stable code and
 * fix. Plain DOM (text only, never HTML strings) through an injected document, no framework and
 * no runtime imports, so the unsupported boot plan stays tiny. Copy is data: pass translated
 * strings (`copy`) from the app's catalog; the defaults are English.
 */
import type { ErrorCode } from '@staticflux/core';
import type { BaselineVerdict } from './baseline.js';

export interface UnsupportedScreenCopy {
  readonly title: string;
  /** The "use Chrome" line. */
  readonly lead: string;
  readonly missingHeading: string;
  readonly helpLabel?: string;
  readonly helpUrl?: string;
}

export const DEFAULT_UNSUPPORTED_COPY: UnsupportedScreenCopy = Object.freeze({
  title: 'This browser cannot run this app',
  lead: 'Use Chrome on desktop (current version).',
  missingHeading: 'Missing in this browser',
});

export interface UnsupportedScreenItem {
  readonly label: string;
  readonly code: ErrorCode;
  readonly fix: string;
}

export interface UnsupportedScreenModel {
  readonly title: string;
  readonly lead: string;
  readonly missingHeading: string;
  /** Headline code (first missing requirement), or undefined when nothing is missing. */
  readonly code: ErrorCode | undefined;
  readonly items: readonly UnsupportedScreenItem[];
  readonly help: { readonly label: string; readonly url: string } | undefined;
}

/** Pure: what the screen shows for a verdict. */
export function unsupportedScreenModel(verdict: BaselineVerdict, copy: Partial<UnsupportedScreenCopy> = {}): UnsupportedScreenModel {
  const text = { ...DEFAULT_UNSUPPORTED_COPY, ...copy };
  return {
    title: text.title,
    lead: text.lead,
    missingHeading: text.missingHeading,
    code: verdict.codes[0],
    items: verdict.missing.map((miss) => ({ label: miss.label, code: miss.code, fix: miss.fix })),
    help: text.helpUrl === undefined ? undefined : { label: text.helpLabel ?? text.helpUrl, url: text.helpUrl },
  };
}

/** Minimal DOM surface (a real `Document` / `Element` satisfies it). */
export interface ScreenElement {
  textContent: string | null;
  setAttribute(name: string, value: string): void;
  append(...nodes: unknown[]): void;
  remove(): void;
}
export interface ScreenDocument {
  createElement(tagName: string): ScreenElement;
}
/** Where the screen is appended (e.g. `document.body`). */
export interface ScreenContainer {
  append(...nodes: unknown[]): void;
}

export interface MountedUnsupportedScreen {
  readonly root: ScreenElement;
  /** Removes the screen. */
  dispose(): void;
}

export const UNSUPPORTED_SCREEN_ID = 'sf-unsupported';

const ROOT_STYLE = 'box-sizing:border-box;max-width:40rem;margin:10vh auto;padding:0 16px;font:16px/1.5 system-ui,sans-serif';

/** Render the model into `container` (e.g. `document.body`). */
export function mountUnsupportedScreen(
  container: ScreenContainer,
  model: UnsupportedScreenModel,
  doc: ScreenDocument,
): MountedUnsupportedScreen {
  const el = (tag: string, text?: string): ScreenElement => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const root = el('main');
  root.setAttribute('id', UNSUPPORTED_SCREEN_ID);
  root.setAttribute('aria-labelledby', `${UNSUPPORTED_SCREEN_ID}-title`);
  root.setAttribute('style', ROOT_STYLE);
  if (model.code !== undefined) root.setAttribute('data-code', model.code);
  const title = el('h1', model.title);
  title.setAttribute('id', `${UNSUPPORTED_SCREEN_ID}-title`);
  root.append(title, el('p', model.lead));
  if (model.items.length > 0) {
    const list = el('ul');
    for (const item of model.items) {
      const entry = el('li');
      entry.setAttribute('data-code', item.code);
      entry.append(el('strong', item.label), el('span', ' · '), el('code', item.code), el('p', item.fix));
      list.append(entry);
    }
    root.append(el('h2', model.missingHeading), list);
  }
  if (model.help !== undefined) {
    const link = el('a', model.help.label);
    link.setAttribute('href', model.help.url);
    const line = el('p');
    line.append(link);
    root.append(line);
  }
  container.append(root);
  return { root, dispose: () => root.remove() };
}
