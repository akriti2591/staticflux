# Instaflow model-weights registry — AGENTS.md

`registry.json` (`sf-model-registry/1`) records every ML model Instaflow may ship or download (IF-2.11): source
URL, verbatim license text, `commercialUse`, pinned files (`url`, `sha256`, `webgpuSafe`) and notes.

## Rules
- Register a model **before** any code references it. `pnpm licenses:check` (`sf licenses`) scans
  `packages/*/src`, `apps/*/src`, `apps/*/public` and `apps/*/engine/crates` (tests excluded; see
  `/license-policy.json`) for each model's id, `references`, file URLs and file names.
- A model is allowed only with `commercialUse: true` **and** an allowlisted license. A denied or unknown model
  that is referenced fails the check. Denied entries that nothing references are kept on purpose: they record a
  decision (for example RMBG-1.4/2.0 are non-commercial; never use them).
- `references` must be specific enough not to match other models (`RMBG-1.4`, not `rmbg`, which also matches the
  `sts-rmbg-modnet` re-host).
- Quote license text verbatim and mark secondary sources. Seeded from `spikes/s9-matte/README.md`; its Hugging
  Face cells are secondary and must be re-verified before shipping.
