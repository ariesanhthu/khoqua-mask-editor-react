@AGENTS.md

# Annotation tool — Claude rules

Repo-wide rules live in `../CLAUDE.md` (loaded automatically). Before changing code here, read:

- `docs/AGENT_GUIDE.md` — allowed/forbidden actions, impact map, workflows.
- `docs/ENGINEERING_POLICY.md` — impact analysis, tests, the 4 gates (`npm run typecheck`, `npm test`, `npm run lint`, `npm run build`), docs, data safety.
- `docs/ARCHITECTURE.md` + `docs/EDITOR_PIPELINE.md` — user-confirmed requirements and invariants.

Every change must be tested without breaking other features, and must update `docs/` (and `docs/CHANGELOG.md`) in the same task.
