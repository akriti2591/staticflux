# AGENTS.md — StaticFlux

Instructions for humans and AI agents working in this repo. Keep this file short; details live in `docs/`.

## Read first
- `docs/REQUIREMENTS.md` — what the framework must do (requirement IDs like R7.14).
- `docs/ARCHITECTURE.md` — layers, packages, contracts.
- `docs/LIFECYCLES.md` — every state machine, valid transitions, invariants, error codes.
- `docs/FEATURE-NEEDS.md` — what features need; every API must trace to it.

## Commands
- `pnpm install` · `pnpm build` (tsc -b) · `pnpm test` (vitest) · `pnpm lint:boundaries` · `pnpm check` (all)

## Rules (enforced by tooling — do not work around them)
1. **No magic strings.** Tokens, flags, metrics, routes, capabilities are typed values created by `token()`, `defineFlag()`, `metric.*()`, etc.
2. **Declare, don't wire.** Every unit declares `requires` and `provides`. No service locators, no globals, no singletons outside the injector.
3. **Composition over inheritance.** Max one level of `extends` (Lit's base element only).
4. **No `if/else` on flags or modes in feature code.** Use variant bindings / per-mode features.
5. **Everything cancellable and disposable.** Async APIs take an `AbortSignal`; resources register in a scope (`scope.defer`, `scope.use`).
6. **Errors are values.** Return `Result<T, SfError>`; every `SfError` has a stable `code` and a `fix`.
7. **Layer boundaries.** A package imports only lower layers (see `.dependency-cruiser.cjs`). Never deep-import `src/`.
8. **Budgets.** Size budgets in `.size-limit.json`; do not raise one without a reason in the PR.
9. **Client gating is UX, not security.** Never treat a client-side check as authorization.
10. **Tests ship with code.** Every exported function has unit tests; contracts have shared suites.

## Style
- TypeScript strict, ESM, `verbatimModuleSyntax`. Explicit return types on exported functions.
- Verbose and explicit beats clever. Shallow abstractions (≤ 1 layer between contract and implementation).
- Each package has its own `AGENTS.md` describing purpose, public API, allowed deps and budgets.
