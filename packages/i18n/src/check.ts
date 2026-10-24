/**
 * Catalog checks for CI (`sf i18n check`, R14.6): missing keys, unused keys,
 * placeholder mismatches and ICU syntax errors. Pure function over data.
 */
import { type ArgKind, collectArgs, parseMessage } from './icu.js';
import { type AnyMessages, CATALOG, type TranslationBundle } from './messages.js';

export type CatalogIssueCode =
  | 'missing-key'
  | 'unused-key'
  | 'unknown-key'
  | 'unknown-namespace'
  | 'placeholder-mismatch'
  | 'syntax-error';

export interface CatalogIssue {
  readonly code: CatalogIssueCode;
  readonly severity: 'error' | 'warning';
  readonly namespace: string;
  /** Undefined for source-level issues (unused keys, source syntax). */
  readonly locale: string | undefined;
  readonly key: string | undefined;
  readonly message: string;
}

export interface CheckCatalogsInput {
  readonly catalogs: readonly AnyMessages[];
  readonly translations: readonly TranslationBundle[];
  /** Locales that must be complete. Default: every locale that has at least one bundle. */
  readonly locales?: readonly string[];
  /** Message ids (`namespace/key`) referenced by code; enables the unused-key check. */
  readonly usedIds?: Iterable<string>;
}

export interface CheckCatalogsReport {
  readonly ok: boolean;
  readonly issues: readonly CatalogIssue[];
  readonly errors: number;
  readonly warnings: number;
}

type ArgGroup = 'plain' | 'numeric' | 'temporal' | 'select' | 'list';

function groupOf(kind: ArgKind): ArgGroup {
  switch (kind) {
    case 'number':
    case 'plural':
    case 'selectordinal':
      return 'numeric';
    case 'date':
    case 'time':
      return 'temporal';
    default:
      return kind;
  }
}

function describeArgs(args: ReadonlyMap<string, ArgKind>): string {
  return [...args.entries()].map(([name, kind]) => `${name}:${kind}`).sort().join(', ') || '(none)';
}

/** Compare placeholder sets; plain args are compatible with any kind. */
function placeholdersMatch(source: ReadonlyMap<string, ArgKind>, target: ReadonlyMap<string, ArgKind>): boolean {
  if (source.size !== target.size) return false;
  for (const [name, kind] of source) {
    const other = target.get(name);
    if (other === undefined) return false;
    const a = groupOf(kind);
    const b = groupOf(other);
    if (a !== b && a !== 'plain' && b !== 'plain') return false;
  }
  return true;
}

export function checkCatalogs(input: CheckCatalogsInput): CheckCatalogsReport {
  const issues: CatalogIssue[] = [];
  const add = (issue: CatalogIssue): void => {
    issues.push(issue);
  };
  const sources = new Map(input.catalogs.map((c) => [c[CATALOG].namespace, c[CATALOG]]));
  const sourceArgs = new Map<string, ReadonlyMap<string, ArgKind>>();

  for (const catalog of sources.values()) {
    for (const key of catalog.keys) {
      const parsed = parseMessage(catalog.messages[key] ?? '');
      if (!parsed.ok) {
        add({ code: 'syntax-error', severity: 'error', namespace: catalog.namespace, locale: undefined, key, message: parsed.error.message });
        continue;
      }
      sourceArgs.set(`${catalog.namespace}/${key}`, collectArgs(parsed.value));
    }
  }

  const locales = input.locales ?? [...new Set(input.translations.map((t) => t.locale))];
  const bundles = new Map<string, Record<string, string>>(); // `${ns}@${locale}` → merged
  for (const bundle of input.translations) {
    if (!sources.has(bundle.namespace)) {
      add({
        code: 'unknown-namespace',
        severity: 'error',
        namespace: bundle.namespace,
        locale: bundle.locale,
        key: undefined,
        message: `Translations for "${bundle.namespace}" (${bundle.locale}) have no catalog; declare it with defineMessages().`,
      });
      continue;
    }
    const id = `${bundle.namespace}@${bundle.locale.toLowerCase()}`;
    bundles.set(id, { ...bundles.get(id), ...bundle.messages });
  }

  for (const catalog of sources.values()) {
    for (const locale of locales) {
      if (locale.toLowerCase() === catalog.sourceLocale.toLowerCase()) continue;
      const texts = bundles.get(`${catalog.namespace}@${locale.toLowerCase()}`) ?? {};
      for (const key of catalog.keys) {
        const text = texts[key];
        if (text === undefined) {
          add({ code: 'missing-key', severity: 'error', namespace: catalog.namespace, locale, key, message: `Missing translation "${catalog.namespace}/${key}" for ${locale}.` });
          continue;
        }
        const parsed = parseMessage(text);
        if (!parsed.ok) {
          add({ code: 'syntax-error', severity: 'error', namespace: catalog.namespace, locale, key, message: parsed.error.message });
          continue;
        }
        const expected = sourceArgs.get(`${catalog.namespace}/${key}`);
        const actual = collectArgs(parsed.value);
        if (expected !== undefined && !placeholdersMatch(expected, actual)) {
          add({
            code: 'placeholder-mismatch',
            severity: 'error',
            namespace: catalog.namespace,
            locale,
            key,
            message: `Placeholders differ for "${catalog.namespace}/${key}" (${locale}): expected ${describeArgs(expected)}, got ${describeArgs(actual)}.`,
          });
        }
      }
      for (const key of Object.keys(texts)) {
        if (!catalog.keys.includes(key)) {
          add({ code: 'unknown-key', severity: 'warning', namespace: catalog.namespace, locale, key, message: `Translation "${catalog.namespace}/${key}" (${locale}) has no source message; remove it.` });
        }
      }
    }
  }

  if (input.usedIds !== undefined) {
    const used = new Set(input.usedIds);
    for (const catalog of sources.values()) {
      for (const key of catalog.keys) {
        if (!used.has(`${catalog.namespace}/${key}`)) {
          add({ code: 'unused-key', severity: 'warning', namespace: catalog.namespace, locale: undefined, key, message: `Message "${catalog.namespace}/${key}" is never used; remove it.` });
        }
      }
    }
  }

  const errors = issues.filter((i) => i.severity === 'error').length;
  return { ok: errors === 0, issues, errors, warnings: issues.length - errors };
}
