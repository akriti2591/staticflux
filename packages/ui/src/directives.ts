/**
 * Isolation-aware template helpers (R11.16b, ui part).
 *
 * Under cross-origin isolation (COEP), cross-origin `img`/`video`/`audio`/`script`/`link`
 * must load in CORS mode, or they are blocked (require-corp) / taint canvases. The
 * injected `IsolationPolicy` decides; templates never branch on the mode.
 *
 * ```ts
 * html`<img ${sfSrc(url)} alt="">`                         // sets crossorigin (before src) + src
 * html`<img src=${url} crossorigin=${this.crossOrigin(url)}>` // SfElement helper
 * html`<video crossorigin=${crossOriginAttr(policy, url, 'video')} src=${url}>`
 * ```
 */
import { nothing } from 'lit';
import { Directive, directive, type ElementPart, type PartInfo, PartType } from 'lit/directive.js';
import { type CrossOriginElementKind, type IsolationPolicy, noIsolationPolicy } from './ports.js';

/** `crossorigin` attribute value (or `nothing` to omit the attribute). */
export function crossOriginAttr(
  policy: IsolationPolicy | undefined,
  url: string,
  kind: CrossOriginElementKind = 'img',
): string | typeof nothing {
  return (policy ?? noIsolationPolicy).crossOriginFor(url, kind) ?? nothing;
}

/** Anything exposing the policy of its scope (SfElement does). */
export interface IsolationAware {
  readonly isolationPolicy: IsolationPolicy | undefined;
}

function policyOf(host: unknown): IsolationPolicy {
  if (typeof host === 'object' && host !== null && 'isolationPolicy' in host) {
    return (host as IsolationAware).isolationPolicy ?? noIsolationPolicy;
  }
  return noIsolationPolicy;
}

const KINDS = new Set<string>(['img', 'video', 'audio', 'script', 'link']);

class SfSrcDirective extends Directive {
  constructor(part: PartInfo) {
    super(part);
    if (part.type !== PartType.ELEMENT) throw new Error('sfSrc() must be used in element position: <img ${sfSrc(url)}>');
  }

  render(_url: string, _kind?: CrossOriginElementKind): typeof nothing {
    return nothing;
  }

  override update(part: ElementPart, [url, kind]: [string, CrossOriginElementKind?]): typeof nothing {
    const element = part.element;
    const name = element.localName;
    const resolvedKind: CrossOriginElementKind = kind ?? (KINDS.has(name) ? (name as CrossOriginElementKind) : 'img');
    const value = policyOf(part.options?.host).crossOriginFor(url, resolvedKind);
    // crossorigin must be set before src/href, otherwise the fetch starts in no-cors mode.
    if (value === undefined) element.removeAttribute('crossorigin');
    else if (element.getAttribute('crossorigin') !== value) element.setAttribute('crossorigin', value);
    const attribute = resolvedKind === 'link' ? 'href' : 'src';
    if (element.getAttribute(attribute) !== url) element.setAttribute(attribute, url);
    return nothing;
  }
}

/** Element directive: sets `crossorigin` per the host's IsolationPolicy, then `src` (or `href` for link). */
export const sfSrc = directive(SfSrcDirective);
