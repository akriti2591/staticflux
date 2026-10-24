/**
 * Boundary rules for StaticFlux. See docs/ARCHITECTURE.md §1.
 * Layers (low → high): core < runtime < vertical < ui < shell < feature < app.
 * Each package declares its layer in package.json "staticflux.layer".
 */
module.exports = {
  forbidden: [
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
    {
      name: 'no-deep-imports',
      comment: 'Import packages through their exports map only (no /src/ reach-ins).',
      severity: 'error',
      from: { path: '^(packages|tooling|apps)/([^/]+)/' },
      to: { path: '^packages/([^/]+)/src/', pathNot: '^packages/$2/src/' },
    },
    {
      name: 'core-depends-on-nothing-internal',
      severity: 'error',
      from: { path: '^packages/core/' },
      to: { path: '^packages/(?!core/)' },
    },
    {
      name: 'features-do-not-import-features',
      severity: 'error',
      from: { path: '^apps/[^/]+/src/features/([^/]+)/' },
      to: { path: '^apps/[^/]+/src/features/([^/]+)/', pathNot: '^apps/[^/]+/src/features/$1/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(dist|node_modules|\\.test\\.ts$)' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
  },
};
