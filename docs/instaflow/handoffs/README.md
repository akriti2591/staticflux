# Handoffs

Every agent session on a work package ends by writing `<WP>.md` here (for example `B2.md`) and committing it with its
work, even when it stops early (limits, a checkpoint request, a blocker). The next agent starts fresh from the handoff,
the brief (`../M1-BRIEF.md`) and the notes (`../M1B-NOTES.md`). It never relies on an earlier agent's history.

Keep it under 80 lines and write it for someone with none of your context:

```md
# <WP> handoff — <date>
**Commit:** <hash> on <branch>  ·  **State:** done | partly done | blocked

## Scope status
- <item>: done | partly done (what is left) | not started

## Decisions (and why)
## IDs used
Requirements, LIFECYCLES section, error codes, framework R-IDs.

## Failing or untested
## Next steps (3–5, concrete)
## Traps
Things that cost you time; files that will conflict at merge.
```
