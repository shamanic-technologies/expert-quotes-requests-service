# expert-quotes-requests-service

Bronze wrapper for journalist quote-request providers. Featured.com first; HARO/SOS/Qwoted later. Owns auth lifecycle, rate-limit budgeting, sync cursor, and append-only bronze payloads. Silver / Gold / HITL live in `journalists-quotes-service`.

## Quick start

```bash
pnpm install
cp .env.example .env  # fill in EXPERT_QUOTES_REQUESTS_SERVICE_DATABASE_URL etc.
pnpm run db:migrate
pnpm run dev
```

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | liveness |
| GET | `/openapi.json` | auto-generated OpenAPI 3.0 spec |
| GET | `/orgs/featured/opportunities` | list bronze opps; `?since=<ISO>` cursor + lazy Featured refresh |
| POST | `/orgs/featured/opportunities/refresh` | force-refresh from Featured |
| POST | `/orgs/featured/answers` | submit pitch answer (auto-creates profile, rate-limit aware) |
| GET | `/orgs/featured/profiles` | list profiles for org (optional `?brandId=`) |
| POST | `/orgs/featured/profiles` | create profile for (org, brand) |
| POST | `/orgs/featured/profiles/:profileId/deactivate` | deactivate |
| GET | `/orgs/featured/premium-questions` | Featured premium questions pass-through |
| GET | `/orgs/featured/submissions` | Featured submissions list pass-through (`?page=N`) |

All `/orgs/*` require `x-api-key` + `x-org-id`. See `CLAUDE.md` for the auth + identity convention.

## Architecture

See [CLAUDE.md](./CLAUDE.md).
