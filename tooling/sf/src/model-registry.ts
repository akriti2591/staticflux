/**
 * Model-weights registry (IF-2.11): one JSON file that records every ML model
 * an app may ship or download — source, license text, commercial-use flag and
 * pinned files. `sf licenses` classifies each entry and fails when a **denied**
 * (or unknown) model is **referenced** from app or package code; denied entries
 * that nothing references are reported but pass (they document a decision, such
 * as "RMBG is non-commercial, do not use").
 */
import { err, ok, type Result } from '@staticflux/core';
import { classifyLicense, type LicenseClassification } from './license-classify.js';
import { InvalidJson } from './errors.js';

export const MODEL_REGISTRY_FORMAT = 'sf-model-registry/1';

export interface ModelFile {
  readonly url: string;
  readonly sha256?: string;
  /** Runs on ORT WebGPU without graph fixes (S9: stock BiRefNet needs `webgpu_safe`). */
  readonly webgpuSafe?: boolean;
}

export interface ModelEntry {
  /** Stable id, e.g. `birefnet-lite`. Also searched for as a reference. */
  readonly id: string;
  readonly name: string;
  /** Where the weights come from (repo, release or model card). */
  readonly sourceUrl: string;
  /** SPDX id, or a custom id such as `bria-rmbg-1.4`. */
  readonly license: string;
  /** Verbatim license statement, quoted from the source. */
  readonly licenseText: string;
  readonly licenseUrl?: string;
  /** May the weights be used in a commercial product? `false` always denies. */
  readonly commercialUse: boolean;
  /** Extra strings that mean "this model is used" when found in code (case-insensitive). */
  readonly references?: readonly string[];
  readonly files?: readonly ModelFile[];
  readonly notes?: string;
}

export interface ModelRegistry {
  readonly format: typeof MODEL_REGISTRY_FORMAT;
  readonly models: readonly ModelEntry[];
}

const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);

function entryProblem(value: unknown, index: number): string | undefined {
  if (typeof value !== 'object' || value === null) return `models[${index}] must be an object`;
  const e = value as Record<string, unknown>;
  for (const key of ['id', 'name', 'sourceUrl', 'license', 'licenseText'] as const) {
    if (!isString(e[key])) return `models[${index}].${key} must be a non-empty string`;
  }
  if (typeof e['commercialUse'] !== 'boolean') return `models[${index}].commercialUse must be true or false`;
  if (e['references'] !== undefined && !isStringArray(e['references'])) return `models[${index}].references must be an array of strings`;
  if (e['files'] !== undefined) {
    if (!Array.isArray(e['files'])) return `models[${index}].files must be an array`;
    for (const [i, f] of (e['files'] as unknown[]).entries()) {
      const file = f as Record<string, unknown> | null;
      if (typeof file !== 'object' || file === null || !isString(file['url'])) return `models[${index}].files[${i}].url must be a string`;
      if (file['sha256'] !== undefined && !(isString(file['sha256']) && /^[0-9a-f]{64}$/.test(file['sha256']))) {
        return `models[${index}].files[${i}].sha256 must be 64 lowercase hex characters`;
      }
    }
  }
  return undefined;
}

/** Validate a parsed registry JSON. All problems are reported together. */
export function parseModelRegistry(json: unknown, source = 'model registry'): Result<ModelRegistry> {
  if (typeof json !== 'object' || json === null) return err(InvalidJson({ message: `${source} must be an object.` }));
  const obj = json as Record<string, unknown>;
  if (obj['format'] !== MODEL_REGISTRY_FORMAT) return err(InvalidJson({ message: `${source}: "format" must be "${MODEL_REGISTRY_FORMAT}".` }));
  if (!Array.isArray(obj['models'])) return err(InvalidJson({ message: `${source}: "models" must be an array.` }));
  const problems = (obj['models'] as unknown[]).map(entryProblem).filter((p): p is string => p !== undefined);
  const ids = (obj['models'] as { id?: unknown }[]).map((m) => m?.id);
  const duplicate = ids.find((id, i) => isString(id) && ids.indexOf(id) !== i);
  if (duplicate !== undefined) problems.push(`duplicate model id "${String(duplicate)}"`);
  if (problems.length > 0) return err(InvalidJson({ message: `${source}: ${problems.join('; ')}.` }));
  return ok({ format: MODEL_REGISTRY_FORMAT, models: obj['models'] as ModelEntry[] });
}

/** License verdict for a model: `commercialUse: false` denies even a permissive license. */
export function classifyModel(entry: ModelEntry): LicenseClassification {
  const license = classifyLicense(entry.license);
  if (!entry.commercialUse) {
    return { verdict: 'denied', reason: `commercial use not permitted${license.verdict === 'denied' ? ` (${license.reason})` : ''}` };
  }
  return license;
}

/** Every string whose presence in code means the model is used: the id, `references`, file URLs and file names. */
export function referenceNeedles(entry: ModelEntry): string[] {
  const needles = [entry.id, ...(entry.references ?? [])];
  for (const file of entry.files ?? []) {
    needles.push(file.url);
    const name = file.url.split(/[?#]/, 1)[0]?.split('/').filter((s) => s.length > 0).at(-1);
    if (name !== undefined && name.includes('.')) needles.push(name);
  }
  return [...new Set(needles.map((n) => n.toLowerCase()))];
}

export interface SourceText {
  readonly path: string;
  readonly text: string;
}

/** Map of model id → paths whose text contains one of the model's needles (case-insensitive). */
export function findModelReferences(models: readonly ModelEntry[], sources: readonly SourceText[]): Map<string, string[]> {
  const lowered = sources.map((s) => ({ path: s.path, text: s.text.toLowerCase() }));
  const out = new Map<string, string[]>();
  for (const model of models) {
    const needles = referenceNeedles(model);
    const paths = lowered.filter((s) => needles.some((n) => s.text.includes(n))).map((s) => s.path);
    out.set(model.id, paths.sort());
  }
  return out;
}
