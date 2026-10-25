/**
 * Golden render snapshots (Node only: reads and writes PNG files).
 *
 * A golden is a small PNG committed next to the test (`__goldens__/<name>.png`). `check` compares a
 * rendered image against it with `compareImages` (SSIM + max channel delta + optional blurred SSIM).
 * Goldens are written or rewritten **only** in update mode, which is an explicit command:
 *
 *   pnpm goldens:update <vitest filter>        # = SF_UPDATE_GOLDENS=1 vitest run <filter>
 *
 * In update mode a golden that still matches is left untouched (no churn from sub-threshold noise);
 * a missing one is written and a mismatching one is replaced. Outside update mode a missing golden is
 * an error (SF-TEST-008), so CI never creates goldens silently. On a mismatch the actual image and a
 * diff heatmap are written to `__failures__/` (gitignored) and their paths are in the error's details.
 *
 * Keep goldens small and few: names are slugs and size is capped (default 65,536 pixels, 32 KiB PNG).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { err, ok, type Result, type SfError } from '@staticflux/core';
import { compareImages, diffHeatmap, RENDER_THRESHOLDS, type ImageComparison, type ImageThresholds } from './compare.js';
import { GoldenMismatchError, GoldenMissingError, GoldenRejectedError } from './errors.js';
import { validateImage, type RgbaImage } from './image.js';
import { decodePng, encodePng } from './png.js';
import type { SsimOptions } from './ssim.js';

/** Environment variable that turns on update mode (`'1'` or `'true'`). Set by `pnpm goldens:update`. */
export const UPDATE_GOLDENS_ENV = 'SF_UPDATE_GOLDENS';

export const GOLDEN_LIMITS = { maxPixels: 256 * 256, maxBytes: 32 * 1024 } as const;

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface GoldenStoreOptions {
  /** Directory holding `<name>.png`; a path or a `file:` URL (`new URL('./__goldens__', import.meta.url)`). */
  readonly dir: string | URL;
  /** Update mode. Default: `goldenUpdateRequested()` (the `SF_UPDATE_GOLDENS` env var). */
  readonly update?: boolean;
  /** Default thresholds for `check`. Default `RENDER_THRESHOLDS.sameBackend`. */
  readonly thresholds?: ImageThresholds;
  readonly ssim?: SsimOptions;
  readonly maxPixels?: number;
  readonly maxBytes?: number;
  /** Where mismatch artifacts go. Default `<dir>/__failures__`. */
  readonly failureDir?: string | URL;
}

export type GoldenStatus = 'match' | 'written' | 'updated';

export interface GoldenOutcome {
  readonly name: string;
  readonly path: string;
  readonly status: GoldenStatus;
  /** Absent when the golden was just written (nothing to compare against). */
  readonly comparison: ImageComparison | undefined;
}

export interface GoldenStore {
  readonly dir: string;
  readonly update: boolean;
  /** Absolute path of `<name>.png`. */
  path(name: string): string;
  /** Compare (and in update mode, write). Errors: SF-TEST-008 missing, 009 mismatch, 010 rejected, 006/007 bad image or file. */
  check(name: string, image: RgbaImage, thresholds?: ImageThresholds): Result<GoldenOutcome, SfError>;
  /** `check`, throwing the error (test helpers fail loudly). */
  assert(name: string, image: RgbaImage, thresholds?: ImageThresholds): GoldenOutcome;
  /** Read a stored golden. */
  read(name: string): Result<RgbaImage, SfError>;
}

/** True when `SF_UPDATE_GOLDENS` is `1` or `true` in `env` (default `process.env`). */
export function goldenUpdateRequested(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const value = env[UPDATE_GOLDENS_ENV]?.toLowerCase();
  return value === '1' || value === 'true';
}

export function createGoldenStore(options: GoldenStoreOptions): GoldenStore {
  const dir = toPath(options.dir);
  const failureDir = options.failureDir === undefined ? join(dir, '__failures__') : toPath(options.failureDir);
  const update = options.update ?? goldenUpdateRequested();
  const defaults = options.thresholds ?? RENDER_THRESHOLDS.sameBackend;
  const maxPixels = options.maxPixels ?? GOLDEN_LIMITS.maxPixels;
  const maxBytes = options.maxBytes ?? GOLDEN_LIMITS.maxBytes;

  const pathOf = (name: string): string => join(dir, `${name}.png`);

  const read = (name: string): Result<RgbaImage, SfError> => {
    const named = checkName(name);
    if (!named.ok) return named;
    const file = pathOf(name);
    if (!existsSync(file)) {
      return err(GoldenMissingError({ message: `Golden "${name}" does not exist (${file}).`, details: { name, path: file, command: `pnpm goldens:update` } }));
    }
    return decodePng(new Uint8Array(readFileSync(file)));
  };

  const write = (name: string, image: RgbaImage, status: GoldenStatus, comparison: ImageComparison | undefined): Result<GoldenOutcome, SfError> => {
    const bytes = encodePng(image);
    if (bytes.length > maxBytes) {
      return err(
        GoldenRejectedError({
          message: `Golden "${name}" would be ${bytes.length} bytes as PNG (limit ${maxBytes}); render a smaller or simpler crop.`,
          details: { name, bytes: bytes.length, maxBytes },
        }),
      );
    }
    const file = pathOf(name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    return ok({ name, path: file, status, comparison });
  };

  const check = (name: string, image: RgbaImage, thresholds: ImageThresholds = defaults): Result<GoldenOutcome, SfError> => {
    const named = checkName(name);
    if (!named.ok) return named;
    const valid = validateImage(image, 'actual');
    if (!valid.ok) return valid;
    if (image.width * image.height > maxPixels) {
      return err(
        GoldenRejectedError({
          message: `Golden "${name}" is ${image.width}×${image.height} (${image.width * image.height} px, limit ${maxPixels}); goldens stay small — compare a crop.`,
          details: { name, width: image.width, height: image.height, maxPixels },
        }),
      );
    }
    const stored = read(name);
    if (!stored.ok) {
      if (update && stored.error.code === GoldenMissingError.code) return write(name, image, 'written', undefined);
      return stored;
    }
    const sameSize = stored.value.width === image.width && stored.value.height === image.height;
    if (!sameSize) {
      if (update) return write(name, image, 'updated', undefined);
      const failure = `size ${image.width}×${image.height} ≠ golden ${stored.value.width}×${stored.value.height}`;
      const artifacts = writeFailureArtifacts(failureDir, name, image, undefined);
      return err(
        GoldenMismatchError({
          message: `Golden "${name}" mismatch: ${failure}. Actual: ${artifacts.actual}.`,
          details: { name, path: pathOf(name), failures: [failure], ...artifacts },
        }),
      );
    }
    const comparison = compareImages(image, stored.value, thresholds, options.ssim);
    if (!comparison.ok) return comparison;
    if (comparison.value.pass) return ok({ name, path: pathOf(name), status: 'match', comparison: comparison.value });
    if (update) return write(name, image, 'updated', comparison.value);
    const artifacts = writeFailureArtifacts(failureDir, name, image, stored.value);
    return err(
      GoldenMismatchError({
        message: `Golden "${name}" mismatch: ${comparison.value.failures.join('; ')}. Actual: ${artifacts.actual}. Diff: ${artifacts.diff}.`,
        details: { name, path: pathOf(name), failures: comparison.value.failures, ssim: comparison.value.ssim, maxChannelDelta: comparison.value.diff.maxChannelDelta, ...artifacts },
      }),
    );
  };

  return {
    dir,
    update,
    path: pathOf,
    read,
    check,
    assert(name, image, thresholds) {
      const result = check(name, image, thresholds);
      if (!result.ok) throw result.error;
      return result.value;
    },
  };
}

function writeFailureArtifacts(failureDir: string, name: string, actual: RgbaImage, expected: RgbaImage | undefined): { actual: string; diff: string | undefined } {
  mkdirSync(failureDir, { recursive: true });
  const actualPath = join(failureDir, `${name}.actual.png`);
  writeFileSync(actualPath, encodePng(actual));
  if (expected === undefined) return { actual: actualPath, diff: undefined };
  const diffPath = join(failureDir, `${name}.diff.png`);
  const heatmap = diffHeatmap(actual, expected);
  if (!heatmap.ok) return { actual: actualPath, diff: undefined };
  writeFileSync(diffPath, encodePng(heatmap.value));
  return { actual: actualPath, diff: diffPath };
}

function checkName(name: string): Result<void, SfError> {
  if (NAME.test(name)) return ok();
  return err(GoldenRejectedError({ message: `Golden name "${name}" must match ${String(NAME)}.`, details: { name } }));
}

function toPath(value: string | URL): string {
  return value instanceof URL ? fileURLToPath(value) : value;
}
