/** Errors raised by testkit helpers (thrown — test helpers fail the test loudly). */
import { defineError } from '@staticflux/core';

export const TestBootFailedError = defineError(
  'SF-TEST-001',
  'invariant',
  '`bootTestApp` could not boot the app.',
  'Inspect `cause` (usually a missing provider or a failing critical unit) and add the unit or an override.',
);

export const TestResolveFailedError = defineError(
  'SF-TEST-002',
  'invariant',
  'A token requested through a testkit helper did not resolve.',
  'Register a unit (or an override) that provides the token; see `cause` for the injector error.',
);

export const UnexpectedViolationsError = defineError(
  'SF-TEST-003',
  'invariant',
  'The code under test emitted conformance `violation` events.',
  'Fix the reported violations (each carries a code and a fix), or assert them explicitly with `violations()`.',
);

export const RunawayTimersError = defineError(
  'SF-TEST-004',
  'invariant',
  '`runAll` exceeded its iteration limit (a timer keeps rescheduling itself).',
  'Use `advance(ms)` for intervals and self-rescheduling timers, or raise `limit` with a reason.',
);

export const SpanAssertionError = defineError(
  'SF-TEST-005',
  'invariant',
  'A span structure assertion failed.',
  'Compare against `formatSpanTree()` output; check the `parent` option where the child span is started.',
);

// ── Render, GPU and media testing (Instaflow M1 / A9) ─────────────────────────────────────────

export const InvalidImageError = defineError(
  'SF-TEST-006',
  'validation',
  'An RGBA image is malformed, two images differ in size, or an image is smaller than the SSIM window.',
  'Pass `{ width, height, data }` with `data.length === width * height * 4`, compare images of equal size, and use images at least as large as `window.size` (default 11).',
);

export const PngDecodeError = defineError(
  'SF-TEST-007',
  'validation',
  'A PNG could not be decoded (corrupt, or a variant the testkit codec does not read).',
  'Store goldens as 8-bit, non-interlaced PNGs (what `encodePng` writes); re-create the file with `pnpm goldens:update`.',
);

export const GoldenMissingError = defineError(
  'SF-TEST-008',
  'not-found',
  'A golden image does not exist yet.',
  'Run `pnpm goldens:update <test filter>` to write it, review the PNG, and commit it with the test.',
);

export const GoldenMismatchError = defineError(
  'SF-TEST-009',
  'invariant',
  'A rendered image does not match its golden within the thresholds.',
  'Open the `actual` and `diff` PNGs listed in `details`. If the change is intended, run `pnpm goldens:update <test filter>`; never loosen thresholds to make a test pass.',
);

export const GoldenRejectedError = defineError(
  'SF-TEST-010',
  'validation',
  'A golden was rejected: its name is not a lowercase slug, or it exceeds the size limits.',
  'Name goldens `[a-z0-9-]+`; render a smaller crop (goldens are small and few: default ≤ 65,536 pixels and ≤ 32 KiB as PNG).',
);

export const GpuRunnerUnavailableError = defineError(
  'SF-TEST-011',
  'unavailable',
  'The real-GPU test runner could not start Chromium (Playwright missing or the browser failed to launch).',
  'Install Playwright with Chromium (`npx playwright install chromium`) or set `NODE_PATH` to a directory that has it; see `cause`.',
);

export const GpuPageFailedError = defineError(
  'SF-TEST-012',
  'invariant',
  'A page under the GPU runner reported a failure or published a malformed result.',
  'Read `details.message`, `details.console` and `details.pageErrors`; in SwiftShader runs check that the ANGLE flags are present (presenting to a canvas loses the device without them).',
);

export const GpuPageTimeoutError = defineError(
  'SF-TEST-013',
  'timeout',
  'A page under the GPU runner did not publish its result before the timeout.',
  'Make sure the page always sets `globalThis.__sfGpuResult` (also on failure, via try/catch); read `details.pageErrors` for uncaught errors.',
);

export const GpuReadbackError = defineError(
  'SF-TEST-014',
  'validation',
  'A GPU texture could not be read back (unsupported format, missing usage flag, or the map failed).',
  'Read back 8-bit RGBA/BGRA textures created with `COPY_SRC` usage; for canvas textures configure the context with `usage: RENDER_ATTACHMENT | COPY_SRC`.',
);

export const MediaLeakError = defineError(
  'SF-TEST-015',
  'invariant',
  'VideoFrame or AudioData handles were left open.',
  'Close every frame and clone you create or receive (`frame.close()`), typically in a `finally` or a scope `defer`; `details.open` lists the leaked handles.',
);

export const GpuCliUsageError = defineError(
  'SF-TEST-016',
  'validation',
  '`sf-gpu-run` was called with invalid arguments.',
  'Run `sf-gpu-run <dir> [page.html] [--query=…] [--real-gpu] [--headed] [--timeout=<s>] [--out=<dir>]` or `sf-gpu-run --url=<url> …`.',
);
