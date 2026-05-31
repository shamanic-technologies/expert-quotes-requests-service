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
- `src/routes/premium-questions.ts` — `GET /orgs/featured/premium-questions` (bronze-backed, lazy-refresh + outlet normalization), `POST /orgs/featured/premium-questions/refresh` (force)
- `src/routes/submissions.ts` — `GET /orgs/featured/submissions`
- `src/middleware/auth.ts` — `apiKeyAuth` + `requireOrgId` + `withRunTracking` (per shared `service-architecture` convention)
- `src/lib/featured-client.ts` — Featured.com HTTP wrapper (JWT cache, rolling-window rate limit, 8 endpoints)
- `src/lib/featured-profile-bootstrap.ts` — Resolves `(org, brand) → Featured profileId` by ADOPTING an existing account profile (`selectFeaturedProfileId` over `client.listProfiles()`), never creating one. Featured `/add-profile` is unusable (server-side 500 for every payload shape — see invariant below), so it picks the single active, non-flagged profile (or the `FEATURED_PROFILE_ID` pin) and caches the `(org, brand) → profileId` mapping locally. Does NOT call brand-service or upload a logo.
- `src/lib/brand-client.ts` — `getBrand` from brand-service `GET /internal/brands/{id}?orgId=` (server-to-server `/internal/*` tier, x-api-key + x-org-id). Returns the canonical minimal brand shape `{ id, domain, url, name, logoUrl, createdAt, updatedAt }`. **Currently has no caller** (the profile-bootstrap path that used `brand.logoUrl` was removed when add-profile proved unusable) — retained (tested) for future profile-enrichment / answer-text templating. Business fields (industry/geography/targetAudience/description) are NOT on this shape; fetch via brand-service `POST /internal/brands/extract-fields` if ever needed.
- `src/lib/key-service-client.ts` — `getFeaturedCredentials` via key-service `featured` provider (env-fallback when provider not yet registered)
- `src/lib/featured-normalize.ts` — shared field normalizers (`readStr` / `readInt` / `readDate` + `deriveOutlet` / `hostnameFromUrl` + `MEDIA_OUTLET_KEYS` / `SOURCE_URL_KEYS`). BOTH ingestion paths resolve the outlet through the one shared `deriveOutlet` (explicit outlet alias, else `sourceUrl` hostname), so outlet coverage is symmetric by construction.
- `src/lib/runs-client.ts` — Mandatory run tracking + cost declaration (`addCosts` / `updateCostStatus`). Fails 502 if runs-service down.
- `src/lib/billing-client.ts` — `authorizeCredit` (credit gate for the metered Featured pitch submit).
- `src/db/schema.ts` — Drizzle schema (`featured_opportunities` bronze + `featured_premium_questions` bronze + `featured_profiles` + `featured_submissions` ledger + `featured_deliveries` per-brand delivery ledger + `featured_jwt` forward-compatible cache table)
- `openapi.json` — Auto-generated. NEVER edit by hand.

## Operational invariants

- **Featured profiles are PEOPLE on ONE shared platform account; we ADOPT, never create.** `featured-username`/`featured-password` are platform keys = a single Featured account. `GET /profiles` returns `{ profileList: FeaturedProfile[] }` where each profile is a person (`profileId, firstName, lastName, email, linkedinUrl, isActive, isFlagged, isUsed`) — there is **no brand `name`/`image`/logo** field. **`POST /add-profile` is unusable: it returns a server-side `500 {"error":"Internal server error"}` for EVERY payload shape** (verified live 2026-05-31 — `{name,image}`, JSON person fields, FormData person fields, FormData+headshot all 500; likely frozen by Featured's 2026-06-02 relaunch as Connectively). So `ensureFeaturedProfile` resolves an EXISTING profile via `selectFeaturedProfileId(listProfiles())` — the `FEATURED_PROFILE_ID` pin if set, else the single active non-flagged profile; 0 or >1-without-pin fails loud. The original "create a Featured profile per (org,brand) from `{brand.name, brand.logoUrl}`" model was wrong twice over (Featured has no brand-profiles AND add-profile 500s) and was the root cause of the reply-path 502 (DIS-124). **Consequence: every org/brand maps to the SAME human-expert profile; client/brand context (headshot, bio, links) goes in the answer TEXT, not the profile.** Re-creating per-brand profiles is blocked on Featured fixing add-profile (revisit post-Connectively); until then `createProfile()` is retained but never called.
- **Single-replica deploy.** JWT cache + rate-limit window are in-memory (`Map` + array in `src/lib/featured-client.ts`). The `featured_jwt` table exists as forward-compatible storage but is currently unused at runtime. When Railway is scaled to >1 replica, move both stores to DB rows + serialize refresh via `SELECT … FOR UPDATE`.
- **Bronze is append-only.** `featured_opportunities` writes via `ON CONFLICT (external_id) DO UPDATE` — re-ingest is idempotent, `first_seen_at` never changes, `last_seen_at` always advances.
- **Both Featured feeds have bronze; outlet resolution is shared via `deriveOutlet`.** `featured_premium_questions` is the bronze for `/premium-question-list` (keyed on `featured_question_id`, idempotent `ON CONFLICT … DO UPDATE`, raw payload persisted). `GET /orgs/featured/premium-questions` lazy-refreshes into it (same TTL knob as opportunities) and serves normalized rows; it is NOT a verbatim pass-through. Outlet resolution for BOTH feeds goes through `deriveOutlet(o)` (`featured-normalize.ts`): an explicit `MEDIA_OUTLET_KEYS` alias if present, ELSE the bare hostname (`www.` stripped) of the declared source-site URL `sourceUrl`. `mediaOutlet` is `null` ONLY when neither exists — never fabricated. Deriving from `sourceUrl` is the **documented-enrichment exception** to the no-fabrication rule: it is Featured's OWN declared publication site, not an email-domain guess.
- **The two Featured feeds DO NOT share key names — normalize each against its OWN confirmed raw, never assume parity with the sibling feed.** `/opportunities-list` → `{ opportunity, pitchUrl, mediaOutlet, source, deadline, createdAt }`. `/premium-question-list` (confirmed from stored raw, prod 2026-05-31) → `{ question, sourceUrl, publicLink, attribution, categories, domainAuthority, openDate, closeDate, isHaroQuery, mayCloseEarly, featuredQuestionId }` — **no `mediaOutlet`, no `pitchUrl`, no `deadline`, no `createdAt`**. So premium maps `pitchUrl ← publicLink`, `deadline ← closeDate`, `createdAt ← openDate`, `outlet ← hostname(sourceUrl)`. The #12 normalizers guessed the opportunities key names for premium and silently stored `null` for `pitchUrl`/`deadline` until #16 fixed them against the real keys — when adding HARO/SOS/Qwoted, persist raw FIRST, read the actual keys from it, then map. `attribution` on premium is junk (`Unknown`/`DoFollow` = link policy), NOT the outlet.
- **Premium outlet recoverability is bounded by `sourceUrl` presence.** Only premium questions still live on Featured (so still returned by a refresh, carrying `sourceUrl`) are outlet-recoverable; expired rows whose raw was never captured have no `sourceUrl` → not recoverable (no fabrication). The premium served set is what `journalists-quotes-service` ingests to silver; `mediaOutlet` flows straight through (JQS reads `q.mediaOutlet`, zero code).
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
| `POST /add-profile` | **NOT CALLED** — server-side 500 for every payload shape (see invariant). Profiles are resolved from `GET /profiles`, never created. |
| `GET /profiles` | (internal) — `listProfiles()`; source of truth for profile resolution. Returns `{ profileList: [...] }`. |
| `POST /deactivate-profile` | `POST /orgs/featured/profiles/:profileId/deactivate` |
| `GET /premium-question-list` | `GET /orgs/featured/premium-questions` (bronze-backed, lazy-refresh, TTL = `FEATURED_OPPORTUNITY_TTL_MS`, outlet normalized) + `POST /orgs/featured/premium-questions/refresh` (force) |
| `GET /submitted?page=N` | `GET /orgs/featured/submissions?page=N` |
| `POST /add-seats` | NOT EXPOSED (v0.1 scope) |
| _(none — derived from local ledger)_ | `POST /orgs/featured/opportunities/submission-status` (authoritative per-(org, brand, opportunity) submitted-status; no Featured call) |

## Rate limit

Featured.com enforces 100 submitted answers per Featured account per rolling 1-hour window. We mirror that constraint locally (in-memory array in `featured-client.ts`) and check the `featured_submissions` ledger before each submit to surface `status: "rate_limited"` to the caller with a `retryAfter` in seconds.

## Storage tables

- `featured_opportunities` — bronze (the `/opportunities-list` feed), keyed by `external_id` (= `pitchUrl`), idempotent re-ingest. Has `media_outlet` but no `featured_question_id` (not API-submittable).
- `featured_premium_questions` — bronze (the `/premium-question-list` feed — the only API-answerable one), keyed by `featured_question_id`, idempotent re-ingest. `media_outlet` derived from `sourceUrl` host at ingest (feed has no outlet field); `pitch_url ← publicLink`, `deadline ← closeDate`; `raw` persisted. This is the feed `journalists-quotes-service` ingests to silver (`external_id` there = `featured-premium-${featuredQuestionId}`).
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
| `BRAND_SERVICE_URL` / `BRAND_SERVICE_API_KEY` | no | — | Used by `brand-client.ts`, which currently has no caller (profile bootstrap no longer uploads a logo). Retained for future profile-enrichment use. |
| `FEATURED_API_BASE_URL` | no | `https://featured.com/api/external-users` | Override for staging / test. |
| `FEATURED_PROFILE_ID` | no | — | Pin which existing Featured profile to submit under. When unset, `ensureFeaturedProfile` auto-picks the single active, non-flagged profile from `GET /profiles` (fails loud on 0 or >1). Set this only when the account holds more than one usable profile. |
| `FEATURED_OPPORTUNITY_TTL_MS` | no | `300000` (5 min) | Bronze lazy-refresh TTL — shared by `GET /orgs/featured/opportunities` AND `GET /orgs/featured/premium-questions`. |
| `PORT` | no | `3055` | |

## Triage flow

- Hotfix → `release.sh hotfix` (when added) → `main` → tag.
- Feature / bugfix → branch from `origin/main` (no `staging` yet) → PR → merge with `gh pr merge --auto --squash` → tag manually.
- **Bump `package.json` `version` IN THE SAME PR, and tag the merge commit `v<that version>`.** The tag must match `package.json` exactly — every prior release does (`v0.1.8` ⇒ `package.json` 0.1.8, etc.). Forgetting the inline bump forces a separate bump PR before you can tag (happened on #12 → #13). The `vX.Y.Z` tag sequence follows the most recent tag's creation order, not strict semver max (`v0.2.0` sits on an out-of-order older commit — ignore it; continue the `v0.1.x` line).
- Staging branch will be created post-`v0.1.0` for soak before promotion (see `release` skill).
