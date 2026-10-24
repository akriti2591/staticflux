# Changesets

Every PR that changes a published package adds a changeset: `pnpm changeset`, pick the bump, write one line for the changelog.
All `@staticflux/*` packages are in one **fixed** group, so they always release together with the same version (one version per app, P9).
On `main`, the Release workflow opens a "Version packages" PR; merging it publishes to npm.
