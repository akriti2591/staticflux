# Idea (parked): projectional "code lens" for humans

**Status:** parked — revisit after Instaflow V1, when the codebase's shape is clearer. Do not pursue yet.

**The idea.** StaticFlux code is deliberately verbose and declarative so agents and tooling can rely on it. An editor
extension could, when a file is opened (on demand, never the whole codebase), show humans a sugar-coated *projection*
that keeps only the logical parts — e.g. a `unit({...})` rendered as
`unit sessionUnit · app · critical / provides Session / needs transport, telemetry / create → …`. The source stays
the single truth; only the view changes.

**Why it fits.** Same pattern as Instaflow's agent views (canonical model + projections), reversed: canonical code
for agents/tooling, projection for humans. The verbose parts (tokens, units, capabilities, routes, machines, errors)
are regular and typed, so the projection can be exact.

**Prior art.** Projectional editing (JetBrains MPS), IntelliJ folding of boilerplate, Unison (AST-stored code),
VS Code inlay hints / code lenses / virtual documents.

**Hard parts.** Editing through the projection with lossless round-trip (comments, formatting); mapping errors,
stack traces, debuggers and diffs back to real lines; reviewers on GitHub still see raw source; keeping the
projection generated from the same type definitions so the dialects cannot drift.

**Suggested first step (when revisited).** Read-only VS Code lens (folding + virtual document + hovers) for units,
tokens and capabilities; editing of the regular parts later.
