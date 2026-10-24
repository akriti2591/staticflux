/**
 * Module Federation 2.0 support (R12.5): map remotes' exposed modules to logical chunk ids
 * (manifest `remote` entries consumed by the loader's `federationStrategy`) and validate the
 * host's shared singletons/versions at build time — the same check the loader repeats at
 * runtime (`checkShared`, SF-LOAD-004), moved left so mismatches fail CI instead of users.
 *
 * Inputs are the same objects passed to `ModuleFederationPlugin` from
 * `@module-federation/enhanced/rspack` or Rspack's built-in `rspack.container.ModuleFederationPlugin`
 * (`remotes`, `shared`), plus the remotes' `mf-manifest.json` when available.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { err, ok, type Result } from '@staticflux/core';
import { type ManifestRemote, satisfiesRange } from '@staticflux/loader';
import { FederationEntryError, FederationRemoteError, FederationSharedMismatchError } from './errors.js';

/** MF `remotes` value: `"name@url"`, a bare URL, or an object form. */
export type MfRemoteConfig = string | { readonly entry?: string; readonly external?: string | readonly string[]; readonly name?: string };

/** MF `shared` value: a `requiredVersion` string or a config object. */
export type MfSharedConfig =
  | string
  | {
      readonly singleton?: boolean;
      readonly requiredVersion?: string | false;
      readonly version?: string | false;
      readonly eager?: boolean;
      readonly strictVersion?: boolean;
    };

/** The subset of a remote's MF 2.0 `mf-manifest.json` the plugin reads. */
export interface MfManifestLike {
  readonly name?: string;
  readonly metaData?: {
    readonly publicPath?: string;
    readonly remoteEntry?: { readonly name: string; readonly path?: string; readonly type?: string };
  };
  readonly shared?: readonly {
    readonly name: string;
    readonly version?: string;
    readonly requiredVersion?: string;
    readonly singleton?: boolean;
  }[];
  readonly exposes?: readonly { readonly name?: string; readonly path: string }[];
}

/** Logical chunk id → `"remote/Exposed"` or `{ remote, module: './Exposed' }`. */
export type ExposeMapping = string | { readonly remote: string; readonly module: string };

export interface FederationOptions {
  /** The `remotes` passed to ModuleFederationPlugin. */
  readonly remotes: Readonly<Record<string, MfRemoteConfig>>;
  /** The `shared` passed to ModuleFederationPlugin (object or array of names). */
  readonly shared?: Readonly<Record<string, MfSharedConfig>> | readonly string[];
  /** Logical chunk id → exposed module of a remote. */
  readonly exposes: Readonly<Record<string, ExposeMapping>>;
  /** Remote name → its mf-manifest.json content (exposes, shared and remoteEntry). */
  readonly manifests?: Readonly<Record<string, MfManifestLike>>;
  /** Remote name → shared ranges it requires (when no mf-manifest is available). */
  readonly remoteShared?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Installed host version of a shared package (default: `<context>/node_modules/<name>/package.json`). */
  readonly resolveVersion?: (name: string) => string | undefined;
}

export interface HostShared {
  readonly name: string;
  readonly version: string | undefined;
  readonly requiredVersion: string | undefined;
  readonly singleton: boolean;
}

export interface FederationPlan {
  /** Manifest remotes keyed by logical chunk id (pass to `createManifest({ remotes })`). */
  readonly remotes: Readonly<Record<string, ManifestRemote>>;
  /** Host shared packages with resolved versions (for the runtime share scope). */
  readonly shared: readonly HostShared[];
}

/** Default version resolver: read the installed package.json under `context`. */
export function packageVersionResolver(context: string): (name: string) => string | undefined {
  return (name) => {
    try {
      const pkg = JSON.parse(readFileSync(join(context, 'node_modules', name, 'package.json'), 'utf8')) as { version?: unknown };
      return typeof pkg.version === 'string' ? pkg.version : undefined;
    } catch {
      return undefined;
    }
  };
}

export function normalizeShared(
  shared: FederationOptions['shared'],
  resolveVersion: (name: string) => string | undefined,
): readonly HostShared[] {
  if (shared === undefined) return [];
  const entries: [string, MfSharedConfig][] = Array.isArray(shared)
    ? (shared as readonly string[]).map((name) => [name, {}])
    : Object.entries(shared as Readonly<Record<string, MfSharedConfig>>);
  return entries.map(([name, cfg]) => {
    const config = typeof cfg === 'string' ? { requiredVersion: cfg } : cfg;
    const declared = typeof config.version === 'string' ? config.version : undefined;
    return {
      name,
      version: declared ?? resolveVersion(name),
      requiredVersion: typeof config.requiredVersion === 'string' ? config.requiredVersion : undefined,
      singleton: config.singleton === true,
    };
  });
}

/** `"name@url"` → url; object forms → entry/external. */
export function remoteUrlOf(config: MfRemoteConfig): string | undefined {
  const raw = typeof config === 'string' ? config : (config.entry ?? (Array.isArray(config.external) ? config.external[0] : config.external));
  if (typeof raw !== 'string' || raw === '') return undefined;
  if (/^([a-z]+:)?\/\//i.test(raw) || raw.startsWith('/')) return raw;
  const at = raw.indexOf('@', 1);
  return at === -1 ? raw : raw.slice(at + 1);
}

/** Remote entry (container) URL; an mf-manifest.json URL is resolved through its manifest. */
export function remoteEntryUrl(remote: string, url: string, manifest: MfManifestLike | undefined): Result<string> {
  if (!/\.json(\?|$)/.test(url)) return ok(url);
  const entry = manifest?.metaData?.remoteEntry;
  if (entry === undefined) {
    return err(FederationEntryError({ message: `Remote "${remote}" points at ${url} (an mf-manifest.json) but no manifest content was given in federation.manifests["${remote}"].`, details: { remote, url } }));
  }
  const declared = manifest?.metaData?.publicPath;
  const publicPath = declared === undefined || declared === 'auto' ? url.replace(/[^/]*$/, '') : declared;
  const path = entry.path === undefined || entry.path === '' ? '' : `${entry.path.replace(/\/$/, '')}/`;
  return ok(`${publicPath.endsWith('/') ? publicPath : `${publicPath}/`}${path}${entry.name}`);
}

export function parseExpose(mapping: ExposeMapping): { remote: string; module: string } | undefined {
  if (typeof mapping !== 'string') return { remote: mapping.remote, module: mapping.module.startsWith('./') ? mapping.module : `./${mapping.module}` };
  const slash = mapping.indexOf('/', mapping.startsWith('@') ? mapping.indexOf('/') + 1 : 0);
  if (slash <= 0 || slash === mapping.length - 1) return undefined;
  return { remote: mapping.slice(0, slash), module: `./${mapping.slice(slash + 1)}` };
}

/**
 * Shared requirements of a remote that the host must satisfy: singletons (on either side — a
 * non-singleton shared package falls back to the remote's own copy, which MF allows) from the
 * mf-manifest, plus explicit `remoteShared` ranges (always enforced).
 */
function requiredByRemote(
  remote: string,
  options: FederationOptions,
  hostSingletons: ReadonlySet<string>,
): { readonly ranges: Record<string, string>; readonly singletons: Set<string> } {
  const ranges: Record<string, string> = {};
  const singletons = new Set<string>();
  for (const s of options.manifests?.[remote]?.shared ?? []) {
    if (s.singleton === true) singletons.add(s.name);
    const enforced = s.singleton === true || hostSingletons.has(s.name);
    if (enforced && typeof s.requiredVersion === 'string' && s.requiredVersion !== '') ranges[s.name] = s.requiredVersion;
  }
  Object.assign(ranges, options.remoteShared?.[remote] ?? {});
  return { ranges, singletons };
}

/**
 * Validate the host's shared singletons and the remotes' requirements, then build the
 * manifest remotes. `declared` = logical chunk ids declared in `chunks`.
 */
export function planFederation(options: FederationOptions, declared: ReadonlySet<string>, context: string): Result<FederationPlan> {
  const shared = normalizeShared(options.shared, options.resolveVersion ?? packageVersionResolver(context));
  const byName = new Map(shared.map((s) => [s.name, s]));
  const hostSingletons = new Set(shared.filter((s) => s.singleton).map((s) => s.name));
  const mismatch = (message: string, details: Record<string, unknown>): Result<FederationPlan> => err(FederationSharedMismatchError({ message, details }));

  for (const s of shared) {
    if (s.singleton && s.version === undefined) {
      return mismatch(`Host shared singleton "${s.name}" has no resolvable version; install it or set shared["${s.name}"].version.`, { shared: s.name });
    }
    if (s.version !== undefined && s.requiredVersion !== undefined && !satisfiesRange(s.version, s.requiredVersion)) {
      return mismatch(`Host shares ${s.name}@${s.version}, which does not satisfy its own requiredVersion "${s.requiredVersion}".`, { shared: s.name, version: s.version, required: s.requiredVersion });
    }
  }

  const remotes: Record<string, ManifestRemote> = {};
  const checkedRemotes = new Set<string>();
  for (const [id, mapping] of Object.entries(options.exposes)) {
    const target = parseExpose(mapping);
    if (target === undefined) {
      return err(FederationRemoteError({ message: `federation.exposes["${id}"] = ${JSON.stringify(mapping)} is not "<remote>/<exposed>".`, details: { chunk: id } }));
    }
    if (!declared.has(id)) {
      return err(FederationRemoteError({ message: `Federated chunk "${id}" is not declared; add chunk('${id}', …) to \`chunks\`.`, details: { chunk: id } }));
    }
    const config = options.remotes[target.remote];
    if (config === undefined) {
      return err(FederationRemoteError({ message: `Chunk "${id}" maps to remote "${target.remote}", which is not in ModuleFederationPlugin remotes (${Object.keys(options.remotes).join(', ') || 'none'}).`, details: { chunk: id, remote: target.remote } }));
    }
    const manifest = options.manifests?.[target.remote];
    if (manifest?.exposes !== undefined && !manifest.exposes.some((e) => e.path === target.module || `./${e.name ?? ''}` === target.module)) {
      return err(FederationRemoteError({ message: `Remote "${target.remote}" does not expose "${target.module}" (exposes: ${manifest.exposes.map((e) => e.path).join(', ') || 'none'}).`, details: { chunk: id, remote: target.remote, module: target.module } }));
    }
    const url = remoteUrlOf(config);
    if (url === undefined) {
      return err(FederationEntryError({ message: `Remote "${target.remote}" has no entry URL in its ModuleFederationPlugin config.`, details: { remote: target.remote } }));
    }
    const entry = remoteEntryUrl(target.remote, url, manifest);
    if (!entry.ok) return err(entry.error);

    const required = requiredByRemote(target.remote, options, hostSingletons);
    if (!checkedRemotes.has(target.remote)) {
      checkedRemotes.add(target.remote);
      for (const name of required.singletons) {
        const host = byName.get(name);
        if (host === undefined || !host.singleton) {
          return mismatch(`Remote "${target.remote}" uses ${name} as a singleton, but the host ${host === undefined ? 'does not share it' : 'does not share it as a singleton'} (host owns singletons, P9).`, { remote: target.remote, shared: name });
        }
      }
      for (const [name, range] of Object.entries(required.ranges)) {
        const host = byName.get(name);
        if (host === undefined) {
          if (required.singletons.has(name)) continue; // reported above
          return mismatch(`Remote "${target.remote}" requires shared ${name}@${range}, which the host does not share.`, { remote: target.remote, shared: name, required: range });
        }
        if (host.version === undefined || !satisfiesRange(host.version, range)) {
          return mismatch(`Remote "${target.remote}" requires ${name}@${range}; host provides ${host.version ?? 'an unknown version'}.`, { remote: target.remote, shared: name, required: range, provided: host.version ?? null });
        }
      }
    }
    const singletonRanges = Object.fromEntries(Object.entries(required.ranges).filter(([name]) => byName.get(name)?.singleton === true));
    remotes[id] = {
      entry: entry.value,
      module: target.module,
      ...(Object.keys(singletonRanges).length > 0 ? { shared: singletonRanges } : {}),
    };
  }
  return ok({ remotes, shared });
}
