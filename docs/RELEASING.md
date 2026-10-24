# Releasing StaticFlux to npm

Owner checklist. Day-to-day releases are automatic (see CONTRIBUTING → Releasing).

## One-time setup

1. **npm org** `staticflux` exists, with 2FA enforcement on. ✅
2. **First publish (0.1.0)** — packages must exist on npm before trusted publishers can be attached:
   1. npmjs.com → your avatar → *Access Tokens* → *Generate New Token* → **Granular Access Token**:
      - Packages and scopes: **Read and write**, scope **@staticflux** (organization `staticflux`).
      - Expiration: **7 days** (it is only for the first publish).
   2. GitHub → repo *Settings → Secrets and variables → Actions* → *New repository secret*: name `NPM_TOKEN`, value = the token.
   3. GitHub → *Actions → Release → Run workflow* (or push to `main`). With no pending changesets it publishes all 34 packages at `0.1.0`.
3. **Switch to trusted publishing** (no stored token):
   1. For each package on npmjs.com → *Settings → Trusted publishing* → *GitHub Actions*: owner `akriti2591`, repository `staticflux`, workflow `release.yml`, environment empty.
   2. Delete the `NPM_TOKEN` GitHub secret and revoke the token on npm.
   3. Optional hardening per package: *Settings → Publishing access → Require two-factor authentication and disallow tokens*.

## Every release after that

Merge the **"chore: version packages"** PR that the Release workflow keeps open. That's it.

## What gets published

The 34 packages under `packages/*` and `tooling/*`, each with `dist/`, `src/` (for source maps), `README.md`, `AGENTS.md` and `LICENSE`. `apps/studio` and `site` are private. `lit`, `@lit/context` and `mobx` are **peer dependencies** so an app has exactly one copy of each.
