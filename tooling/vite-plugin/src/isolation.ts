/**
 * Cross-origin isolation for dev/preview (R11.16a/b): COOP/COEP (+ CORP) headers and the
 * `crossorigin` attribute the build puts on injected preload tags.
 */

/** App isolation choice (R11.16a). */
export type IsolationMode = 'required' | 'preferred' | 'off';
/** COEP flavour (R11.16b). */
export type CoepMode = 'require-corp' | 'credentialless';
export type CorpMode = 'same-origin' | 'same-site' | 'cross-origin';

export interface IsolationOptions {
  readonly isolation: IsolationMode;
  readonly coep: CoepMode;
  readonly corp: CorpMode;
}

/**
 * Headers served by the dev and preview servers. `required` and `preferred` both
 * serve them (preferred means "use isolation when the host can"); `off` serves none.
 */
export function isolationHeaders(options: IsolationOptions): Readonly<Record<string, string>> {
  if (options.isolation === 'off') return {};
  return {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': options.coep,
    'Cross-Origin-Resource-Policy': options.corp,
  };
}

/** `crossorigin` attribute value for injected `modulepreload`/`preload` tags. */
export type CrossOriginAttr = true | 'anonymous' | 'use-credentials';

/**
 * With isolation off, a bare `crossorigin` mirrors Vite's own `<script type="module" crossorigin>`
 * (same credentials mode, so the preloaded response is reused). Under isolation the value is
 * explicit (`anonymous` unless the app asks for `use-credentials`), as the isolation policy
 * does at runtime (loader `crossOriginPolicy`).
 */
export function crossOriginFor(isolation: IsolationMode, override?: 'anonymous' | 'use-credentials'): CrossOriginAttr {
  if (override !== undefined) return override;
  return isolation === 'off' ? true : 'anonymous';
}
