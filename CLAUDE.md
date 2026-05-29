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
- `src/routes/opportunities.ts` — `GET /orgs/featured/opportunities` (org-scoped `since` cursor OR per-brand delivery mode via `?brandId=`), `POST /orgs/featured/opportunities/refresh`, `POST /orgs/featured/opportunities/submission-status` (authoritative per-(org, brand, opportunity) submitted-status)
- `src/routes/answers.ts` — `POST /orgs/featured/answers`
- `src/routes/profiles.ts` — `GET/POST /orgs/featured/profiles`, `POST /orgs/featured/profiles/:id/deactivate`
- `src/routes/premium-questions.ts` — `GET /orgs/featured/premium-questions`
- `src/routes/submissions.ts` — `GET /orgs/featured/submissions`
- `src/middleware/auth.ts` — `apiKeyAuth` + `requireOrgId` + `withRunTracking` (per shared `service-architecture` convention)
- `src/lib/featured-client.ts` — Featured.com HTTP wrapper (JWT cache, rolling-window rate limit, 8 endpoints)
- `src/lib/featured-profile-bootstrap.ts` — Lazy `(org, brand) → Featured profileId` creation via brand-service logo
- `src/lib/brand-client.ts` — `getBrand` + `getBrandLogo` from brand-service
- `src/lib/key-service-client.ts` — `getFeaturedCredentials` via key-service `featured` provider (env-fallback when provider not yet registered)
- `src/lib/runs-client.ts` — Mandatory run tracking + cost declaration (`addCosts` / `updateCostStatus`). Fails 502 if runs-service down.
- `src/lib/billing-client.ts` — `authorizeCredit` (credit gate for the metered Featured pitch submit).
- `src/db/schema.ts` — Drizzle schema (`featured_opportunities` bronze + `featured_profiles` + `featured_submissions` ledger + `featured_deliveries` per-brand delivery ledger + `featured_jwt` forward-compatible cache table)
- `openapi.json` — Auto-generated. NEVER edit by hand.

## Operational invariants

- **Single-replica deploy.** JWT cache + rate-limit window are in-memory (`Map` + array in `src/lib/featured-client.ts`). The `featured_jwt` table exists as forward-compatible storage but is currently unused at runtime. When Railway is scaled to >1 replica, move both stores to DB rows + serialize refresh via `SELECT … FOR UPDATE`.
- **Bronze is append-only.** `featured_opportunities` writes via `ON CONFLICT (external_id) DO UPDATE` — re-ingest is idempotent, `first_seen_at` never changes, `last_seen_at` always advances.
- **Cursor is timestamp-based** (`?since=<ISO>` filtered against `first_seen_at`). Response includes `nextSince = max(first_seen_at)` for chaining. Provider-agnostic — works as-is for HARO / SOS / Qwoted once added.
- **Per-brand delivery is ledger-based, keyed on the atomic single `brandId`.** `GET /orgs/featured/opportunities?brandId=<uuid>` returns only opportunities never recorded in `featured_deliveries` for that `(org_id, brand_id)`, newest-first, and records them as delivered in the same transaction (`INSERT … ON CONFLICT DO NOTHING … RETURNING` ⇒ concurrency-safe, never double-served). Consecutive calls return disjoint sets; exhausted → `[]` (a polling consumer terminates). `nextSince` is `null` in this mode — the ledger is the cursor. A timestamp high-water-mark cannot be used here: batch ingest stamps every row of one insert with the same `first_seen_at` (single `defaultNow()`). Identity is the single brand, never a brand tuple (co-brand grouping is the consumer's concern). The `?brandId=` mode is additive — omitting it preserves the legacy `since` behavior byte-for-byte.
- **Submitted-status is authoritative and lives here.** `POST /orgs/featured/opportunities/submission-status` `{ brandId, externalIds[] }` returns, per opportunity, `{ externalId, submitted, lastStatus, submittedAt }`. `submitted` is true ONLY when a `featured_submissions` row with `status='submitted'` exists for `(org, brand, externalId)`; `error` / pending / absent ⇒ `submitted:false` (still offerable — failed submits are NOT served). EQRS owns the Featured submit, so it is the source of truth; consumers ASK rather than reconstruct locally. Keyed on the same `externalId` the opportunities feed exposes + the atomic single `brandId`. The submit (`POST /orgs/featured/answers`) accepts an additive optional `externalId` that is persisted to the ledger to enable this lookup.
- **Cost declaration lives with the terminal action.** EQRS performs the Featured `/answer-question` call, so EQRS owns the pitch-submit cost lifecycle (`POST /orgs/featured/answers`): provision → authorize → execute → actualize, cost name `featured-api-pitch-submit`, `costSource=platform` (Featured creds are platform keys), scoped to this service's own `req.runId`. This is NOT "business logic" — it is the mandatory cost-declaration invariant for any metered call a service owns. Consumers (journalists-quotes-service) MUST NOT also declare this cost (would double-charge); they call EQRS and EQRS declares. Pre-submit failures (provision/authorize) fail loud (502 / 402 insufficient-credit, provisioned row cancelled). Post-submit actualize failure logs loud but still returns `submitted` — a completed Featured submit must never surface a 5xx, or the caller resubmits and double-pitches.
- **No business logic.** Scoring, HITL queue, silver clustering all live in `journalists-quotes-service`. This service is a stateless pass-through for Featured.com mechanics + bronze persistence.
- **No silent fallbacks.** Featured.com errors propagate as `502`. Key-service unavailable propagates as `502`. Runs-service unavailable propagates as `502`. Brand-service logo missing throws (caller sees `502`).
- **`.github/workflows/migrate.yml` is non-gating and currently RED** — it runs `pnpm db:migrate` on push-to-`main` touching `drizzle/**`, but the repo GitHub secret `EXPERT_QUOTES_REQUESTS_SERVICE_DATABASE_URL` is unset, so it fails fast with `url: ''` on every such merge (has been red since #7). It does NOT gate merges. The **real** migration applier is the service boot path (`src/index.ts` runs `migrate()` before `app.listen()`), which uses the Railway env var and applies idempotent migrations on every deploy. A red `migrate.yml` is expected, not a sign your migration is broken — verify your migration locally against a real Postgres + confirm the deploy booted (registry re-syncs the service's OpenAPI on boot). To actually green the workflow, set the `EXPERT_QUOTES_REQUESTS_SERVICE_DATABASE_URL` GitHub Actions secret.

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
| _(none — derived from local ledger)_ | `POST /orgs/featured/opportunities/submission-status` (authoritative per-(org, brand, opportunity) submitted-status; no Featured call) |

## Rate limit

Featured.com enforces 100 submitted answers per Featured account per rolling 1-hour window. We mirror that constraint locally (in-memory array in `featured-client.ts`) and check the `featured_submissions` ledger before each submit to surface `status: "rate_limited"` to the caller with a `retryAfter` in seconds.

## Storage tables

- `featured_opportunities` — bronze, keyed by `external_id`, idempotent re-ingest.
- `featured_profiles` — `(org_id, brand_id) → featured_profile_id` mapping.
- `featured_submissions` — append-only ledger of submission attempts (drives ledger-based rate-limit + audit trail + authoritative submitted-status). `external_id` (nullable) ties a submission to the opportunity identity the feed exposes.
- `featured_deliveries` — per-`(org_id, brand_id)` delivery ledger, unique on `(org_id, brand_id, external_id)`. Drives per-brand "give me only what this brand hasn't seen" + loop termination. Keyed on the atomic single `brandId`.
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
