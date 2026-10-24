# Releasing StaticFlux to npm

Owner checklist. Day-to-day releases are automatic (see CONTRIBUTING → Releasing).

## One-time setup

1. **npm org** `staticflux` exists, with 2FA enforcement on. ✅
2. **First publish (0.1.0)** — packages must exist on npm before trusted publishers can be attached:
   1. npmjs.com → your avatar → *Access Tokens* → *Generate New Token* → **Granular Access Token**:
      - Packages and scopes: **Read and write**, scope **@staticflux** (organization `staticflux`).
      - Expiration: **7 days** (it is only for the first publish).
   2. GitHub → repo *Settings → Secrets and variables → Actions* → *New repository secret*: name `NPM_TOKEN`, value = the token.
   3. GitHub → *Actions → Release → Run workflow*. It publishes every version not yet on npm.
3. **Switch to trusted publishing** (no stored token):
   1. For each package on npmjs.com → *Settings → Trusted publishing* → *GitHub Actions*: owner `akriti2591`, repository `staticflux`, workflow `release.yml`, environment empty.
   2. Delete the `NPM_TOKEN` GitHub secret and revoke the token on npm.
   3. Optional hardening per package: *Settings → Publishing access → Require two-factor authentication and disallow tokens*.

## Every release after that (on demand)

1. PRs that change packages include a changeset (`pnpm changeset`).
2. The **Version** workflow keeps a **"chore: version packages"** PR open with the bumps and changelogs. Merge it when you want to cut a release — merging does **not** publish.
3. **Actions → Release → Run workflow** publishes whatever versions are not yet on npm. Nothing is ever published by a merge.

## How publishing works

`pnpm release` runs `sf publish` (tooling/sf), not `changeset publish`:
- publishes only versions not yet on npm, **one package at a time**, in dependency order, with a 10 s pause between packages;
- on npm rate limits (HTTP 429) it waits and retries with exponential backoff (60 s, doubling, capped at 15 min, 6 attempts);
- a version that already exists (published or staged) is skipped, never bumped;
- prints `New tag: <name>@<version>` and creates the git tag, so changesets/action makes GitHub releases.

Preview without publishing: `pnpm build && node tooling/sf/dist/cli.js publish --dry-run`.
Changesets is still used for versions and changelogs (`changeset publish` is not used because it publishes 10 packages in parallel with no throttle).

## What gets published

The 34 packages under `packages/*` and `tooling/*`, each with `dist/`, `src/` (for source maps), `README.md`, `AGENTS.md` and `LICENSE`. `apps/studio` and `site` are private. `lit`, `@lit/context` and `mobx` are **peer dependencies** so an app has exactly one copy of each.
