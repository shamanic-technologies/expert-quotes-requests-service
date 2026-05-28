# Project: expert-quotes-requests-service

Bronze wrapper for journalist quote-request providers. Owns Featured.com mechanics today (auth, rate-limit, cursor / sync, append-only bronze payloads). Future providers: HARO mailbox parser, SOS, Qwoted. Silver clustering + Gold scoring + HITL live in `journalists-quotes-service`, not here.

## Commands

- `pnpm test` — run all tests (Vitest)
- `pnpm test:unit` — unit tests only
- `pnpm test:integration` — integration tests only
- `pnpm run build` — `tsc` + regenerate `openapi.json`
- `pnpm run dev` — local dev server (`tsx watch`)
- `pnpm run generate:openapi` — regenerate `openapi.json` from Zod schemas
- `pnpm run db:generate` — generate Drizzle migrations
- `pnpm run db:migrate` — apply migrations
- `pnpm run db:push` — push schema directly (dev only)

## Architecture

- `src/schemas.ts` — Zod + OpenAPI registry (single source of truth)
- `src/routes/health.ts` — `GET /health`
- `src/routes/opportunities.ts` — `GET /orgs/featured/opportunities`, `POST /orgs/featured/opportunities/refresh`
- `src/routes/answers.ts` — `POST /orgs/featured/answers`
- `src/routes/profiles.ts` — `GET/POST /orgs/featured/profiles`, `POST /orgs/featured/profiles/:id/deactivate`
- `src/routes/premium-questions.ts` — `GET /orgs/featured/premium-questions`
- `src/routes/submissions.ts` — `GET /orgs/featured/submissions`
- `src/middleware/auth.ts` — `apiKeyAuth` + `requireOrgId` + `withRunTracking` (per shared `service-architecture` convention)
- `src/lib/featured-client.ts` — Featured.com HTTP wrapper (JWT cache, rolling-window rate limit, 8 endpoints)
- `src/lib/featured-profile-bootstrap.ts` — Lazy `(org, brand) → Featured profileId` creation via brand-service logo
- `src/lib/brand-client.ts` — `getBrand` + `getBrandLogo` from brand-service
- `src/lib/key-service-client.ts` — `getFeaturedCredentials` via key-service `featured` provider (env-fallback when provider not yet registered)
- `src/lib/runs-client.ts` — Mandatory run tracking. Fails 502 if runs-service down.
- `src/db/schema.ts` — Drizzle schema (`featured_opportunities` bronze + `featured_profiles` + `featured_submissions` ledger + `featured_jwt` forward-compatible cache table)
- `openapi.json` — Auto-generated. NEVER edit by hand.

## Operational invariants

- **Single-replica deploy.** JWT cache + rate-limit window are in-memory (`Map` + array in `src/lib/featured-client.ts`). The `featured_jwt` table exists as forward-compatible storage but is currently unused at runtime. When Railway is scaled to >1 replica, move both stores to DB rows + serialize refresh via `SELECT … FOR UPDATE`.
- **Bronze is append-only.** `featured_opportunities` writes via `ON CONFLICT (external_id) DO UPDATE` — re-ingest is idempotent, `first_seen_at` never changes, `last_seen_at` always advances.
- **Cursor is timestamp-based** (`?since=<ISO>` filtered against `first_seen_at`). Response includes `nextSince = max(first_seen_at)` for chaining. Provider-agnostic — works as-is for HARO / SOS / Qwoted once added.
- **No business logic.** Scoring, HITL queue, silver clustering all live in `journalists-quotes-service`. This service is a stateless pass-through for Featured.com mechanics + bronze persistence.
- **No silent fallbacks.** Featured.com errors propagate as `502`. Key-service unavailable propagates as `502`. Runs-service unavailable propagates as `502`. Brand-service logo missing throws (caller sees `502`).

## Cross-service auth + identity

`/orgs/*` requires `x-api-key` (matches `EXPERT_QUOTES_REQUESTS_SERVICE_API_KEY`) + `x-org-id`. `x-user-id`, `x-run-id`, `x-brand-id`, `x-campaign-id`, `x-feature-slug`, `x-workflow-slug` are forwarded to downstream calls. See `~/.claude/skills/service-architecture/SKILL.md`.

`withRunTracking` creates a child run in runs-service on every `/orgs/*` request and closes it on response. `req.parentRunId` = caller's run id; `req.runId` = this service's own run id. Downstream calls must use `req.runId` as the outbound `x-run-id`.

## Featured.com surface

| Featured.com endpoint | This service surface |
|---|---|
| `POST /login` | internal — JWT cached for 24h |
| `GET /opportunities-list` | `GET /orgs/featured/opportunities` (lazy-refresh, TTL = `FEATURED_OPPORTUNITY_TTL_MS`) + `POST /orgs/featured/opportunities/refresh` (force) |
| `POST /answer-question` | `POST /orgs/featured/answers` |
| `POST /add-profile` | `POST /orgs/featured/profiles` + auto-bootstrap on submit |
| `GET /profiles` | (internal) |
| `POST /deactivate-profile` | `POST /orgs/featured/profiles/:profileId/deactivate` |
| `GET /premium-question-list` | `GET /orgs/featured/premium-questions` |
| `GET /submitted?page=N` | `GET /orgs/featured/submissions?page=N` |
| `POST /add-seats` | NOT EXPOSED (v0.1 scope) |

## Rate limit

Featured.com enforces 100 submitted answers per Featured account per rolling 1-hour window. We mirror that constraint locally (in-memory array in `featured-client.ts`) and check the `featured_submissions` ledger before each submit to surface `status: "rate_limited"` to the caller with a `retryAfter` in seconds.

## Storage tables

- `featured_opportunities` — bronze, keyed by `external_id`, idempotent re-ingest.
- `featured_profiles` — `(org_id, brand_id) → featured_profile_id` mapping.
- `featured_submissions` — append-only ledger of submission attempts (drives ledger-based rate-limit + audit trail).
- `featured_jwt` — forward-compatible JWT cache table (unused at runtime today; populate when scaling to multi-replica).

## Configuration

See `.env.example` for the full list. Key envs:

| Variable | Required | Default | Description |
|---|---|---|---|
| `EXPERT_QUOTES_REQUESTS_SERVICE_DATABASE_URL` | yes | — | Neon connection string |
| `EXPERT_QUOTES_REQUESTS_SERVICE_API_KEY` | yes | — | Inbound API key |
| `KEY_SERVICE_URL` / `KEY_SERVICE_API_KEY` | yes | — | Featured creds resolved via key-service `featured-username` + `featured-password` platform keys (declared by dashboard at startup). No env-var fallback. |
| `RUNS_SERVICE_URL` / `RUNS_SERVICE_API_KEY` | yes (prod) | — | Run tracking. Boot fails closed if missing in prod. |
| `BRAND_SERVICE_URL` / `BRAND_SERVICE_API_KEY` | yes | — | For lazy Featured profile bootstrap (brand logo upload). |
| `FEATURED_API_BASE_URL` | no | `https://featured.com/api/external-users` | Override for staging / test. |
| `FEATURED_OPPORTUNITY_TTL_MS` | no | `300000` (5 min) | Bronze lazy-refresh TTL on `GET /orgs/featured/opportunities`. |
| `PORT` | no | `3055` | |

## Triage flow

- Hotfix → `release.sh hotfix` (when added) → `main` → tag.
- Feature / bugfix → branch from `origin/main` (no `staging` yet) → PR → merge with `gh pr merge --auto --squash` → tag manually.
- Staging branch will be created post-`v0.1.0` for soak before promotion (see `release` skill).
