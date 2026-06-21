import { z } from "zod";
import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
} from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

const ErrorResponseSchema = z
  .object({ error: z.string() })
  .openapi("ErrorResponse");

// ─── Shared identity headers ────────────────────────────────────────────────

const orgHeaders = z.object({
  "x-api-key": z.string(),
  "x-org-id": z.string().uuid(),
  "x-user-id": z.string().uuid().optional(),
  "x-run-id": z.string().uuid().optional(),
  "x-brand-id": z.string().optional(),
  "x-audience-id": z.string().uuid().optional(),
  "x-campaign-id": z.string().uuid().optional(),
  "x-feature-slug": z.string().optional(),
  "x-workflow-slug": z.string().optional(),
});

// ─── GET /health ────────────────────────────────────────────────────────────

const HealthResponseSchema = z
  .object({ status: z.literal("ok"), service: z.string() })
  .openapi("HealthResponse");

registry.registerPath({
  method: "get",
  path: "/health",
  summary: "Health check",
  responses: {
    200: {
      description: "Service healthy",
      content: { "application/json": { schema: HealthResponseSchema } },
    },
  },
});

// ─── Featured opportunity (bronze row) ──────────────────────────────────────

export const FeaturedOpportunityRowSchema = z
  .object({
    id: z.string().uuid(),
    externalId: z.string(),
    featuredQuestionId: z.number().int().nullable(),
    opportunityText: z.string(),
    mediaOutlet: z.string().nullable(),
    source: z.string().nullable(),
    pitchUrl: z.string().nullable(),
    deadline: z.string().nullable(),
    raw: z.unknown(),
    firstSeenAt: z.string(),
    lastSeenAt: z.string(),
  })
  .openapi("FeaturedOpportunityRow");

// ─── GET /orgs/featured/opportunities ───────────────────────────────────────

export const OpportunitiesListQuerySchema = z.object({
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  brandId: z
    .string()
    .uuid()
    .optional()
    .openapi({
      description:
        "When set, switches to per-brand delivery mode: returns only opportunities never delivered to this (org, brand) and records them as delivered. Consecutive calls return disjoint sets; exhausted → empty array. `nextSince` is null in this mode (the delivery ledger is the cursor). When absent, the legacy org-scoped `since` timestamp cursor is used.",
    }),
});

const OpportunitiesListResponseSchema = z
  .object({
    items: z.array(FeaturedOpportunityRowSchema),
    nextSince: z.string().nullable(),
    refreshed: z.boolean(),
  })
  .openapi("OpportunitiesListResponse");

registry.registerPath({
  method: "get",
  path: "/orgs/featured/opportunities",
  summary: "List bronze Featured opportunities (lazy-refreshes from Featured)",
  description:
    "Lazy-refreshes from Featured if last refresh > FEATURED_OPPORTUNITY_TTL_MS. Supports cursor pagination via `?since=<ISO>` filtered against `first_seen_at`. Response carries `nextSince` for chaining.",
  request: {
    headers: orgHeaders,
    query: OpportunitiesListQuerySchema,
  },
  responses: {
    200: {
      description: "Opportunities + cursor",
      content: {
        "application/json": { schema: OpportunitiesListResponseSchema },
      },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description: "Featured.com unavailable",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ─── POST /orgs/featured/opportunities/refresh ──────────────────────────────

const RefreshResponseSchema = z
  .object({
    refreshed: z.boolean(),
    inserted: z.number().int(),
    updated: z.number().int(),
    skipped: z.number().int(),
  })
  .openapi("OpportunityRefreshResponse");

registry.registerPath({
  method: "post",
  path: "/orgs/featured/opportunities/refresh",
  summary: "Force-refresh opportunities from Featured (bypass TTL)",
  request: { headers: orgHeaders },
  responses: {
    200: {
      description: "Refresh stats",
      content: { "application/json": { schema: RefreshResponseSchema } },
    },
    502: {
      description: "Featured.com unavailable",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ─── POST /orgs/featured/opportunities/submission-status ────────────────────

export const SubmissionStatusRequestSchema = z
  .object({
    brandId: z.string().uuid(),
    externalIds: z.array(z.string()).min(1).max(500),
  })
  .openapi("SubmissionStatusRequest");

const SubmissionStatusEntrySchema = z
  .object({
    externalId: z.string(),
    submitted: z.boolean(),
    lastStatus: z.string().nullable(),
    submittedAt: z.string().nullable(),
  })
  .openapi("SubmissionStatusEntry");

const SubmissionStatusResponseSchema = z
  .object({ statuses: z.array(SubmissionStatusEntrySchema) })
  .openapi("SubmissionStatusResponse");

registry.registerPath({
  method: "post",
  path: "/orgs/featured/opportunities/submission-status",
  summary:
    "Authoritative submitted-status for a set of opportunities, per (org, brand)",
  description:
    "Returns, for each requested `externalId`, whether it has been submitted-successfully to Featured for this (org, brand). `submitted` is true only when a ledger row with status `submitted` exists; `error`/pending/absent → `submitted: false` (still offerable, AC4). Keyed on the atomic single `brandId` + the same `externalId` the opportunities feed exposes.",
  request: {
    headers: orgHeaders,
    body: {
      content: {
        "application/json": { schema: SubmissionStatusRequestSchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Per-opportunity submitted-status",
      content: {
        "application/json": { schema: SubmissionStatusResponseSchema },
      },
    },
    400: {
      description: "Bad request",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ─── POST /orgs/featured/answers ────────────────────────────────────────────

export const SubmitAnswerRequestSchema = z
  .object({
    brandId: z.string().uuid(),
    featuredQuestionId: z.number().int(),
    answer: z.string().min(100).max(2500),
    externalId: z
      .string()
      .optional()
      .openapi({
        description:
          "Opportunity identity (= the `externalId` from the opportunities feed) this submission is for. Persisted to the submission ledger so the authoritative submitted-status lookup can key on it.",
      }),
  })
  .openapi("SubmitAnswerRequest");

const SubmitAnswerResponseSchema = z
  .object({
    status: z.enum(["submitted", "rate_limited", "error"]),
    featuredQuestionId: z.number().int().optional(),
    featuredProfileId: z.number().int().optional(),
    retryAfter: z.number().int().optional(),
    error: z.string().optional(),
  })
  .openapi("SubmitAnswerResponse");

// 402 body carries the balance shortfall so the caller can surface it. Distinct
// from the bare {error} ErrorResponse — consumers (journalists-quotes-service
// /reply) read balance_cents / required_cents.
const InsufficientCreditResponseSchema = z
  .object({
    error: z.string(),
    balance_cents: z.number(),
    required_cents: z.number(),
  })
  .openapi("InsufficientCreditResponse");

registry.registerPath({
  method: "post",
  path: "/orgs/featured/answers",
  summary: "Submit a pitch answer to a Featured question",
  description:
    "Auto-ensures (org, brand) Featured profile via brand-service logo lookup. Rate-limit-aware (rolling 100 / hour per Featured account). Declares the `featured-api-pitch-submit` cost (provision → authorize → execute → actualize); the credit gate returns 402 when the org cannot afford the submit.",
  request: {
    headers: orgHeaders,
    body: {
      content: { "application/json": { schema: SubmitAnswerRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Submission outcome",
      content: { "application/json": { schema: SubmitAnswerResponseSchema } },
    },
    400: {
      description: "Bad request",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    402: {
      description:
        "Insufficient credit for the featured pitch submit (credit gate). The provisioned cost is cancelled; no submit is attempted.",
      content: {
        "application/json": { schema: InsufficientCreditResponseSchema },
      },
    },
    502: {
      description:
        "Upstream unavailable — key-service, brand-service, billing-service, runs-service (cost provision), or Featured.com. The provisioned cost is cancelled.",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ─── GET /orgs/featured/profiles ────────────────────────────────────────────

export const ProfilesListQuerySchema = z.object({
  brandId: z.string().uuid().optional(),
});

const ProfileRowSchema = z
  .object({
    id: z.string().uuid(),
    orgId: z.string().uuid(),
    brandId: z.string().uuid(),
    featuredProfileId: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("FeaturedProfileRow");

const ProfilesListResponseSchema = z
  .object({ profiles: z.array(ProfileRowSchema) })
  .openapi("ProfilesListResponse");

registry.registerPath({
  method: "get",
  path: "/orgs/featured/profiles",
  summary: "List Featured profiles for the org (optional brandId filter)",
  request: { headers: orgHeaders, query: ProfilesListQuerySchema },
  responses: {
    200: {
      description: "Profiles",
      content: { "application/json": { schema: ProfilesListResponseSchema } },
    },
  },
});

// ─── POST /orgs/featured/profiles ───────────────────────────────────────────

export const CreateProfileRequestSchema = z
  .object({ brandId: z.string().uuid() })
  .openapi("CreateProfileRequest");

const CreateProfileResponseSchema = z
  .object({ profile: ProfileRowSchema })
  .openapi("CreateProfileResponse");

registry.registerPath({
  method: "post",
  path: "/orgs/featured/profiles",
  summary: "Create or fetch Featured profile for (org, brand)",
  request: {
    headers: orgHeaders,
    body: {
      content: { "application/json": { schema: CreateProfileRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Profile row",
      content: {
        "application/json": { schema: CreateProfileResponseSchema },
      },
    },
    502: {
      description: "Upstream unavailable",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ─── POST /orgs/featured/profiles/:profileId/deactivate ─────────────────────

const DeactivateProfileResponseSchema = z
  .object({ ok: z.literal(true) })
  .openapi("DeactivateProfileResponse");

registry.registerPath({
  method: "post",
  path: "/orgs/featured/profiles/{profileId}/deactivate",
  summary: "Deactivate a Featured profile",
  request: {
    headers: orgHeaders,
    params: z.object({ profileId: z.coerce.number().int() }),
  },
  responses: {
    200: {
      description: "Deactivated",
      content: {
        "application/json": { schema: DeactivateProfileResponseSchema },
      },
    },
    404: {
      description: "Profile not found for this org",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ─── GET /orgs/featured/premium-questions ───────────────────────────────────

// Bronze-backed: `mediaOutlet` (and the other optional fields) are normalized at
// ingest and served nullable — `null` when Featured's premium feed exposes no
// value under any known alias (never fabricated).
const PremiumQuestionSchema = z
  .object({
    featuredQuestionId: z.number().int(),
    question: z.string(),
    source: z.string().nullable(),
    mediaOutlet: z.string().nullable(),
    pitchUrl: z.string().nullable(),
    createdAt: z.string().nullable(),
    deadline: z.string().nullable(),
  })
  .openapi("PremiumQuestion");

const PremiumQuestionsResponseSchema = z
  .object({
    questions: z.array(PremiumQuestionSchema),
    refreshed: z.boolean(),
  })
  .openapi("PremiumQuestionsResponse");

registry.registerPath({
  method: "get",
  path: "/orgs/featured/premium-questions",
  summary: "List Featured premium questions (bronze-backed, lazy-refresh)",
  description:
    "Lazy-refreshes from Featured `/premium-question-list` if last refresh > FEATURED_OPPORTUNITY_TTL_MS, persisting the raw payload to bronze and normalizing `mediaOutlet` through the shared outlet aliases. Returns the full currently-answerable premium set (no limit). `mediaOutlet` is `null` only when Featured exposes no outlet under any known key.",
  request: { headers: orgHeaders },
  responses: {
    200: {
      description: "Premium questions + refresh flag",
      content: {
        "application/json": { schema: PremiumQuestionsResponseSchema },
      },
    },
    502: {
      description: "Featured.com unavailable",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ─── POST /orgs/featured/premium-questions/refresh ──────────────────────────

const PremiumRefreshResponseSchema = z
  .object({
    refreshed: z.boolean(),
    inserted: z.number().int(),
    updated: z.number().int(),
    skipped: z.number().int(),
  })
  .openapi("PremiumQuestionRefreshResponse");

registry.registerPath({
  method: "post",
  path: "/orgs/featured/premium-questions/refresh",
  summary: "Force-refresh premium questions from Featured (bypass TTL)",
  request: { headers: orgHeaders },
  responses: {
    200: {
      description: "Refresh stats",
      content: {
        "application/json": { schema: PremiumRefreshResponseSchema },
      },
    },
    502: {
      description: "Featured.com unavailable",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ─── GET /orgs/featured/submissions ─────────────────────────────────────────

export const SubmissionsQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
});

const SubmissionsResponseSchema = z
  .object({
    data: z.array(z.unknown()),
    total: z.number().int().optional(),
    page: z.number().int().optional(),
  })
  .openapi("SubmissionsResponse");

registry.registerPath({
  method: "get",
  path: "/orgs/featured/submissions",
  summary: "List submissions previously made to Featured (pass-through)",
  request: { headers: orgHeaders, query: SubmissionsQuerySchema },
  responses: {
    200: {
      description: "Submissions page",
      content: { "application/json": { schema: SubmissionsResponseSchema } },
    },
  },
});
