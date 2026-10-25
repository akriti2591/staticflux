# @staticflux/browser-test — AGENTS.md

**Layer:** tooling (test-only, private, never published). **Budget:** none.

## Purpose
The minimal real-browser harness (R16.1, R16.5): correctness tests that need real browser APIs (OPFS, sync access
handles in workers, Web Locks across tabs, BroadcastChannel, renderer crashes) run in Chromium through Playwright.
Logic stays in Vitest + happy-dom; only what a fake cannot prove goes here.

## How it works
- `src/run.ts` (Node, run directly with type stripping) starts a Vite dev server at the repo root (TypeScript from
  source, `@staticflux/*` aliased to `packages/<pkg>/src` like `vitest.config.ts`, module workers via
  `new Worker(new URL('./x.ts', import.meta.url), { type: 'module' })`), launches Chromium (background throttling
  off, so multi-tab scenarios keep their timers), then:
  - loads each `packages/*/src/**/*.browser.ts` in a fresh browser context; the file registers tests with
    `describe`/`it` and the page reports `runRegistered()` results;
  - imports each `**/*.scenario.ts` in Node and calls its exported `scenario(ctx)` (Playwright-driven: several
    pages in one context, CDP crashes, …).
- `src/index.ts` — the in-page API: `describe`, `it(name, fn, { timeoutMs })`, `expect` (`toBe`, `toEqual`,
  `toBeTruthy`, `toBeFalsy`, `toBeGreaterThan[OrEqual]`, `toBeLessThanOrEqual`, `toContain`, `toHaveLength`),
  `runRegistered()` (also inside a dedicated worker: post its result to the page), `ScenarioContext`
  (`browser`, `newContext`, `pageUrl(entry, query)`, `log`, `env`), and Playwright's `Browser`/`BrowserContext`/`Page` types.
- Pages: `/__sf/suite?file=<repo path>` (a suite) and `/__sf/page?entry=<repo path>&…` (a scenario page).

## Usage
`pnpm test:browser` · `pnpm test:browser --only=<path substring>` · `--headed` · `--timeout=<s>` · explicit files.
Locally Playwright needs Chromium (`pnpm --filter @staticflux/browser-test exec playwright install chromium`; this
container has it under `PLAYWRIGHT_BROWSERS_PATH`). CI runs it in the `browser` job.

## Rules
- Name browser suites `*.browser.ts` and scenarios `*.scenario.ts`; keep their helpers (workers, pages, fixtures)
  in a folder or with a suffix the package build excludes (blob: `src/browser-tests/`; testkit: `*.browser.ts`,
  `*.worker.ts`, `*.opfs.ts`).
- Assert correctness, never wall-clock numbers (4 shared cores); log timings instead.
- Scenario files may import only types at the top level (they run in Node without a bundler).
