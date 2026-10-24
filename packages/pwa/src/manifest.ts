/**
 * Typed web app manifest builder (R18.11). Write the declaration in camelCase; get a
 * validated, spec-shaped (snake_case) JSON object back. Invalid declarations are
 * `SF-PWA-007` with `details.field` naming the offending field. Pure: usable at build time.
 *
 * ```ts
 * const manifest = defineWebAppManifest({
 *   name: 'Studio', shortName: 'Studio', startUrl: '/studio', scope: '/',
 *   display: 'standalone', displayOverride: ['window-controls-overlay'],
 *   icons: [{ src: '/icons/192.png', sizes: '192x192', type: 'image/png' }],
 *   shareTarget: { action: '/share', method: 'POST', enctype: 'multipart/form-data',
 *     params: { title: 'title', text: 'text', url: 'url', files: [{ name: 'files', accept: ['image/*'] }] } },
 *   launchHandler: { clientMode: 'focus-existing' },
 * });
 * if (manifest.ok) emitFile('manifest.webmanifest', webAppManifestJson(manifest.value));
 * ```
 */
import { err, ok, type Result } from '@staticflux/core';
import { InvalidWebAppManifestError } from './errors.js';

export type ManifestDisplay = 'fullscreen' | 'standalone' | 'minimal-ui' | 'browser';
export type ManifestDisplayOverride = ManifestDisplay | 'window-controls-overlay' | 'tabbed';
export type ManifestOrientation = 'any' | 'natural' | 'landscape' | 'portrait' | 'portrait-primary' | 'portrait-secondary' | 'landscape-primary' | 'landscape-secondary';
export type IconPurpose = 'any' | 'maskable' | 'monochrome';
export type LaunchClientMode = 'auto' | 'navigate-new' | 'navigate-existing' | 'focus-existing';

export interface ManifestIcon {
  readonly src: string;
  /** `192x192`, `512x512 1024x1024`, or `any` (SVG). */
  readonly sizes: string;
  readonly type?: string;
  readonly purpose?: IconPurpose | readonly IconPurpose[];
}

export interface ManifestShortcut {
  readonly name: string;
  readonly shortName?: string;
  readonly description?: string;
  readonly url: string;
  readonly icons?: readonly ManifestIcon[];
}

export interface ShareTargetFiles {
  readonly name: string;
  /** MIME types or extensions (`image/*`, `.png`). */
  readonly accept: readonly string[];
}

export interface ShareTargetDeclaration {
  readonly action: string;
  readonly method?: 'GET' | 'POST';
  readonly enctype?: 'application/x-www-form-urlencoded' | 'multipart/form-data';
  readonly params: {
    readonly title?: string;
    readonly text?: string;
    readonly url?: string;
    readonly files?: readonly ShareTargetFiles[];
  };
}

export interface FileHandlerDeclaration {
  readonly action: string;
  /** MIME type → extensions, e.g. `{ 'application/x-studio': ['.studio'] }`. */
  readonly accept: Readonly<Record<string, readonly string[]>>;
  readonly name?: string;
  readonly icons?: readonly ManifestIcon[];
  readonly launchType?: 'single-client' | 'multiple-clients';
}

export interface ProtocolHandlerDeclaration {
  /** `web+studio` or a safelisted scheme (`mailto`, …). */
  readonly protocol: string;
  /** Must contain `%s`, e.g. `/open?url=%s`. */
  readonly url: string;
}

export interface WebAppManifestDeclaration {
  readonly id?: string;
  readonly name: string;
  readonly shortName?: string;
  readonly description?: string;
  /** Default: `scope`. */
  readonly startUrl?: string;
  /** Default `/`. */
  readonly scope?: string;
  readonly display?: ManifestDisplay;
  readonly displayOverride?: readonly ManifestDisplayOverride[];
  readonly orientation?: ManifestOrientation;
  readonly themeColor?: string;
  readonly backgroundColor?: string;
  readonly lang?: string;
  readonly dir?: 'ltr' | 'rtl' | 'auto';
  readonly categories?: readonly string[];
  readonly icons: readonly ManifestIcon[];
  readonly shortcuts?: readonly ManifestShortcut[];
  readonly shareTarget?: ShareTargetDeclaration;
  readonly fileHandlers?: readonly FileHandlerDeclaration[];
  readonly protocolHandlers?: readonly ProtocolHandlerDeclaration[];
  readonly launchHandler?: { readonly clientMode: LaunchClientMode | readonly LaunchClientMode[] };
}

export interface ManifestIconJson {
  readonly src: string;
  readonly sizes: string;
  readonly type?: string;
  readonly purpose?: string;
}

/** Spec-shaped manifest (snake_case keys). */
export interface WebAppManifestJson {
  readonly id?: string;
  readonly name: string;
  readonly short_name?: string;
  readonly description?: string;
  readonly start_url: string;
  readonly scope: string;
  readonly display?: ManifestDisplay;
  readonly display_override?: readonly ManifestDisplayOverride[];
  readonly orientation?: ManifestOrientation;
  readonly theme_color?: string;
  readonly background_color?: string;
  readonly lang?: string;
  readonly dir?: string;
  readonly categories?: readonly string[];
  readonly icons: readonly ManifestIconJson[];
  readonly shortcuts?: readonly {
    readonly name: string;
    readonly short_name?: string;
    readonly description?: string;
    readonly url: string;
    readonly icons?: readonly ManifestIconJson[];
  }[];
  readonly share_target?: {
    readonly action: string;
    readonly method: 'GET' | 'POST';
    readonly enctype: string;
    readonly params: {
      readonly title?: string;
      readonly text?: string;
      readonly url?: string;
      readonly files?: readonly { readonly name: string; readonly accept: readonly string[] }[];
    };
  };
  readonly file_handlers?: readonly {
    readonly action: string;
    readonly accept: Readonly<Record<string, readonly string[]>>;
    readonly name?: string;
    readonly icons?: readonly ManifestIconJson[];
    readonly launch_type?: string;
  }[];
  readonly protocol_handlers?: readonly { readonly protocol: string; readonly url: string }[];
  readonly launch_handler?: { readonly client_mode: LaunchClientMode | readonly LaunchClientMode[] };
}

export const SAFELISTED_PROTOCOLS: readonly string[] = [
  'bitcoin', 'ftp', 'ftps', 'geo', 'im', 'irc', 'ircs', 'magnet', 'mailto', 'matrix', 'mms', 'news', 'nntp',
  'openpgp4fpr', 'sftp', 'sip', 'sms', 'smsto', 'ssh', 'tel', 'urn', 'webcal', 'wtai', 'xmpp',
];

const BASE = 'https://manifest.invalid';
const SIZES = /^(any|\d+x\d+)( \d+x\d+)*$/;

type Problem = { readonly field: string; readonly reason: string };

function within(url: string, scope: string): boolean {
  try {
    const target = new URL(url, BASE);
    const root = new URL(scope, BASE);
    return target.origin === root.origin && target.pathname.startsWith(root.pathname);
  } catch {
    return false;
  }
}

function iconJson(icons: readonly ManifestIcon[], field: string, problems: Problem[]): readonly ManifestIconJson[] {
  return icons.map((icon, i) => {
    if (icon.src === '') problems.push({ field: `${field}[${i}].src`, reason: 'empty src' });
    if (!SIZES.test(icon.sizes)) problems.push({ field: `${field}[${i}].sizes`, reason: 'use "WxH" (space-separated) or "any"' });
    const purpose = icon.purpose === undefined ? undefined : typeof icon.purpose === 'string' ? icon.purpose : icon.purpose.join(' ');
    return {
      src: icon.src,
      sizes: icon.sizes,
      ...(icon.type === undefined ? {} : { type: icon.type }),
      ...(purpose === undefined ? {} : { purpose }),
    };
  });
}

function opt<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

export function defineWebAppManifest(declaration: WebAppManifestDeclaration): Result<WebAppManifestJson> {
  const problems: Problem[] = [];
  const d = declaration;
  if (d.name.trim() === '') problems.push({ field: 'name', reason: 'required' });
  const scope = d.scope ?? '/';
  const startUrl = d.startUrl ?? scope;
  if (!within(startUrl, scope)) problems.push({ field: 'startUrl', reason: `must be within scope "${scope}"` });
  if (d.icons.length === 0) problems.push({ field: 'icons', reason: 'at least one icon is required to be installable' });
  const icons = iconJson(d.icons, 'icons', problems);

  const shortcuts = d.shortcuts?.map((s, i) => {
    if (!within(s.url, scope)) problems.push({ field: `shortcuts[${i}].url`, reason: 'must be within scope' });
    return {
      name: s.name,
      url: s.url,
      ...opt('short_name', s.shortName),
      ...opt('description', s.description),
      ...opt('icons', s.icons === undefined ? undefined : iconJson(s.icons, `shortcuts[${i}].icons`, problems)),
    };
  });

  let shareTarget: WebAppManifestJson['share_target'];
  if (d.shareTarget !== undefined) {
    const st = d.shareTarget;
    const method = st.method ?? 'GET';
    const files = st.params.files;
    const enctype = st.enctype ?? (method === 'POST' && files !== undefined ? 'multipart/form-data' : 'application/x-www-form-urlencoded');
    if (!within(st.action, scope)) problems.push({ field: 'shareTarget.action', reason: 'must be within scope' });
    if (files !== undefined && files.length > 0 && (method !== 'POST' || enctype !== 'multipart/form-data')) {
      problems.push({ field: 'shareTarget.params.files', reason: 'files require method POST and enctype multipart/form-data' });
    }
    if (method === 'GET' && enctype !== 'application/x-www-form-urlencoded') {
      problems.push({ field: 'shareTarget.enctype', reason: 'GET share targets use application/x-www-form-urlencoded' });
    }
    if (st.params.title === undefined && st.params.text === undefined && st.params.url === undefined && files === undefined) {
      problems.push({ field: 'shareTarget.params', reason: 'declare at least one of title/text/url/files' });
    }
    shareTarget = {
      action: st.action,
      method,
      enctype,
      params: {
        ...opt('title', st.params.title),
        ...opt('text', st.params.text),
        ...opt('url', st.params.url),
        ...opt('files', files?.map((f) => ({ name: f.name, accept: [...f.accept] }))),
      },
    };
  }

  const fileHandlers = d.fileHandlers?.map((h, i) => {
    if (!within(h.action, scope)) problems.push({ field: `fileHandlers[${i}].action`, reason: 'must be within scope' });
    const entries = Object.entries(h.accept);
    if (entries.length === 0) problems.push({ field: `fileHandlers[${i}].accept`, reason: 'declare at least one MIME type' });
    for (const [mime, exts] of entries) {
      if (!mime.includes('/')) problems.push({ field: `fileHandlers[${i}].accept`, reason: `"${mime}" is not a MIME type` });
      for (const ext of exts) if (!ext.startsWith('.')) problems.push({ field: `fileHandlers[${i}].accept`, reason: `extension "${ext}" must start with "."` });
    }
    return {
      action: h.action,
      accept: h.accept,
      ...opt('name', h.name),
      ...opt('icons', h.icons === undefined ? undefined : iconJson(h.icons, `fileHandlers[${i}].icons`, problems)),
      ...opt('launch_type', h.launchType),
    };
  });

  const protocolHandlers = d.protocolHandlers?.map((p, i) => {
    const protocol = p.protocol.toLowerCase();
    if (!/^web\+[a-z]+$/.test(protocol) && !SAFELISTED_PROTOCOLS.includes(protocol)) {
      problems.push({ field: `protocolHandlers[${i}].protocol`, reason: 'use "web+<letters>" or a safelisted scheme' });
    }
    if (!p.url.includes('%s')) problems.push({ field: `protocolHandlers[${i}].url`, reason: 'must contain %s' });
    else if (!within(p.url.replace('%s', 'x'), scope)) problems.push({ field: `protocolHandlers[${i}].url`, reason: 'must be within scope' });
    return { protocol, url: p.url };
  });

  if (problems.length > 0) {
    const first = problems[0] as Problem;
    return err(InvalidWebAppManifestError({ message: `Invalid web app manifest: ${first.field} ${first.reason}.`, details: { field: first.field, problems } }));
  }
  return ok({
    ...opt('id', d.id),
    name: d.name,
    ...opt('short_name', d.shortName),
    ...opt('description', d.description),
    start_url: startUrl,
    scope,
    ...opt('display', d.display),
    ...opt('display_override', d.displayOverride),
    ...opt('orientation', d.orientation),
    ...opt('theme_color', d.themeColor),
    ...opt('background_color', d.backgroundColor),
    ...opt('lang', d.lang),
    ...opt('dir', d.dir),
    ...opt('categories', d.categories),
    icons,
    ...opt('shortcuts', shortcuts),
    ...opt('share_target', shareTarget),
    ...opt('file_handlers', fileHandlers),
    ...opt('protocol_handlers', protocolHandlers),
    ...opt('launch_handler', d.launchHandler === undefined ? undefined : { client_mode: d.launchHandler.clientMode }),
  });
}

/** Serialized manifest (`manifest.webmanifest`). */
export function webAppManifestJson(manifest: WebAppManifestJson, space = 2): string {
  return JSON.stringify(manifest, null, space);
}

/** Share-target field names for the SW plugin / page receiver, from the declaration. */
export function shareTargetParamsOf(declaration: ShareTargetDeclaration): {
  readonly title?: string;
  readonly text?: string;
  readonly url?: string;
  readonly files?: string;
} {
  return {
    ...opt('title', declaration.params.title),
    ...opt('text', declaration.params.text),
    ...opt('url', declaration.params.url),
    ...opt('files', declaration.params.files?.[0]?.name),
  };
}
