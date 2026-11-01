# CLAUDE.md

Bitter Melon Annotation Tool: multi-user labeling app for bitter-melon (khổ qua) segmentation masks (polygons) and wart-density **points**. Next.js full-stack, deployed on Vercel. No Python backend, Vite or Docker in the runtime path.

Docs are written in Vietnamese. Reply in the language the user writes in; keep code identifiers and comments consistent with the surrounding file.

## Read first (in this order)

1. `annotation-tool/AGENTS.md` — this Next.js (16.x) differs from training data. Read the matching guide in `annotation-tool/node_modules/next/dist/docs/` before touching routing, Route Handlers, proxy or caching code.
2. `annotation-tool/docs/AGENT_GUIDE.md` — what you may / may not do, impact map, workflows. **Mandatory.**
3. `annotation-tool/docs/ENGINEERING_POLICY.md` — change, test and documentation standards. **Mandatory.**
4. `annotation-tool/docs/ARCHITECTURE.md` and `EDITOR_PIPELINE.md` — user-confirmed requirements and invariants; `EDITOR_RENDERING.md` before touching canvas rendering. Index: `annotation-tool/docs/README.md`.

## Layout

```text
.                          repo root (npm scripts proxy to annotation-tool)
├── annotation-tool/       the app (Next.js App Router, API in Route Handlers)
│   ├── src/app/           pages + src/app/api/** route handlers
│   ├── src/components/    dashboard, editor-workspace, editor-canvas, ...
│   ├── src/lib/           services (db, lock, annotation, export, drive, storage, geometry)
│   ├── src/types/         shared DTOs
│   ├── src/proxy.ts       auth gate for /api/* (JWT cookie)
│   ├── scripts/           one-off ops/audit/import scripts (touch real data!)
│   ├── docs/              engineering docs — keep in sync with code
│   └── artifacts/         local exports/backups, gitignored, never commit
├── docs/                  product specs, UI style guide, prelabel/Vercel notes
├── cloudflare/            Worker + wrangler.jsonc that fronts the app container (not deployed yet)
├── drive/                 source prelabel dataset — do not delete or revert
├── scripts/               Python dataset conversion (+ tests)
├── .github/workflows/     Vercel CI/CD (test → typecheck → build → deploy)
└── .mcp.json              project MCP servers (Cloudflare)
```

## Commands (run in `annotation-tool/`, or from root via `npm run <name>`)

| Command | Purpose |
| --- | --- |
| `npm run dev` | Dev server. Without `DATABASE_URL` it uses embedded PGlite (`data/pglite`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest (single file: `npx vitest run src/lib/<name>.test.ts`) |
| `npm run lint` | ESLint (next core-web-vitals + typescript) |
| `npm run build` | Production build |
| `node scripts/canvas-browser-check.mjs http://localhost:3217` | Headless-Chrome check of canvas interactions on the synthetic `/canvas-browser-check` page (start an isolated dev server first; see the script header) |

The 4 gates (typecheck, test, lint, build) must pass before any deploy; CI runs test → typecheck → build.
Baseline on 2026-10-25 (after editor render optimization / COCO 1.0 import in the editor, and `compactPolygon` for the surface import): typecheck clean, lint clean, build ok, 184 tests in 26 files pass, `canvas-browser-check` 21/21. A regression from this baseline is yours to fix or report.

## Non-negotiable rules (summary — full text in ENGINEERING_POLICY.md)

1. **Impact before edit.** Before changing a shared module (types, db schema, lock/annotation/export services, api-client, editor-canvas/workspace), find every consumer (Grep) and check the impact map in `AGENT_GUIDE.md`. A new feature must not change or break other features.
2. **Test with every change.** Add or update tests for the behavior you touched; run the full gates, not only the new test. Canvas changes also need `scripts/canvas-browser-check.mjs`. If you cannot test something (real devices, real data, workspace save/lock flows in a browser), say so explicitly — never claim it was verified.
3. **Docs are part of the change.** Update the relevant `annotation-tool/docs/*.md` and `CHANGELOG.md` in the same task: what changed, the architecture impact, and which behavior the user confirmed. Record user decisions as user-confirmed, do not invent requirements.
4. **Protect real data.** `.env`/`.env.local` point to production Postgres/Blob/Drive. Never call `/api/seed`, `scripts/*` that write, export-to-Drive, or any mutating API against them without explicit user approval. Never print or copy secrets into logs/docs.
5. **Preserve user-confirmed invariants** (save policy, lock model, “chấm điểm” = click a point, Drive written only by the Home button, mouse mapping in Select, Ctrl+Z removes one point at a time while drawing a polygon, non-admins see only their assigned groups, manifest import stays the default format next to COCO 1.0). See `EDITOR_PIPELINE.md` and `annotation-tool/docs/GROUPS_AND_IMPORT.md`.
6. **Minimal diffs.** Read code first, change only what is needed, keep existing logic and the user's uncommitted edits (the working tree is dirty by design). No sweeping rewrites of `editor-canvas.tsx` / `editor-workspace.tsx`.
7. **Git/deploy only on request.** Do not commit, push, deploy or run Vercel/Cloudflare mutations unless asked. Never `--no-verify`, never force-push, never revert `drive/`.

## Cloudflare MCP

`.mcp.json` registers `cloudflare-api` (`https://mcp.cloudflare.com/mcp`) and `cloudflare-docs` (`https://docs.mcp.cloudflare.com/mcp`). Authenticate with `/mcp` (OAuth); never put API tokens in the file. Usage rules: `annotation-tool/docs/AGENT_GUIDE.md` § Cloudflare MCP. Production app is on Vercel; object storage is moving to Cloudflare R2 (`annotation-tool/docs/CLOUDFLARE_R2_STORAGE.md`, code ready, not yet switched on). A parallel Cloudflare Containers deployment is prepared in `cloudflare/` (see `annotation-tool/docs/CLOUDFLARE_DEPLOY.md`) but **not deployed**: it needs the Workers Paid plan and Docker. Any Cloudflare write (deploy, secrets, DNS, R2) needs the user's explicit request. The Cloudflare token lives in the gitignored root `.env`; never print or copy it.
