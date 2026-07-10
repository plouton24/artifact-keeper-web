# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --status in_progress  # Claim work
bd close <id>         # Complete work
bd sync               # Sync with git
```

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds

## Cursor Cloud specific instructions

This is the **Next.js web UI** for Artifact Keeper. The Rust API lives in the
sibling `artifact-keeper` repo. Standard commands are in `package.json`
(`npm run dev`, `npm run lint`, `npm test` (Vitest), `npm run test:e2e`
(Playwright)) and `README.md`.

- To run the dev server against a local backend, set `BACKEND_URL` and leave
  `NEXT_PUBLIC_API_URL` **empty/unset**:
  `BACKEND_URL=http://localhost:8080 npm run dev` (UI on `:3000`). The Next.js
  middleware (`src/middleware.ts`) proxies same-origin `/api/*`, `/health`, and
  the native package paths to `BACKEND_URL`.
- Do **not** set `NEXT_PUBLIC_API_URL` to a cross-origin URL (e.g.
  `http://localhost:8080`) for local dev: that makes the browser call the
  backend directly, which the app's Content-Security-Policy blocks, surfacing
  as `Failed to fetch` on login. Same-origin proxying via `BACKEND_URL` avoids
  this. A gitignored `.env.local` with `NEXT_PUBLIC_API_URL=` and
  `BACKEND_URL=http://localhost:8080` is a convenient place for these.
- The backend starts in `SETUP_REQUIRED` mode: log in with the bootstrap admin
  credentials, then complete the forced password-change flow before the rest of
  the UI is usable.

