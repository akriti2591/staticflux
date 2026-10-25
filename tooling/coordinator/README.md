# Coordinator merge helpers

Used by the M1 coordinator to merge work-package branches. Not a package; no build. Procedure in
`docs/instaflow/M1-BRIEF.md` § Coordinator.

| Script | What it does |
|---|---|
| `union.py FILE…` | Resolves conflict markers in docs by keeping both sides (ours, blank line, theirs). For appended sections only; check the result reads well (tables must stay one table, no blank lines inside). |
| `jsonmerge.cjs FILE` | Structural three-way merge of a conflicted JSON file from the index stages. **Scalar conflicts take theirs**: always follow with `json-check.cjs`. |
| `json-check.cjs FILE…` | Prints every LOST / CHANGED / NEW entry against HEAD. Only NEW entries from the incoming side are expected. |

Traps seen so far:
- `.size-limit.json` entries are keyed by `name`; a renamed entry merges as two entries (old limit + new limit). Delete the stale one.
- `pnpm-lock.yaml`: take either side, then `pnpm install` to regenerate. Never hand-edit.
- After GitHub squash-merges a PR, a branch stacked on it conflicts on files both touched. If `git diff <old base> origin/main`
  shows only files the stacked branch supersedes, resolve with `git checkout --ours -- .` and verify the tree.
- Requirement / LIFECYCLES / error IDs are pre-assigned per work package (see the stage notes); collisions mean an agent
  ignored its range. Renumber the later one and every reference (`grep -rn`).
