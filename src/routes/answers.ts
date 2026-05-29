import { Router } from "express";
import { and, gte, eq, count, asc } from "drizzle-orm";
import { db } from "../db/index.js";
import { featuredSubmissions } from "../db/schema.js";
import {
  FeaturedClient,
  FeaturedRateLimitError,
  type FeaturedClientOptions,
  type FeaturedCredentials,
} from "../lib/featured-client.js";
import { getFeaturedCredentials } from "../lib/key-service-client.js";
import {
  ensureFeaturedProfile,
  type FetchLogoBytes,
} from "../lib/featured-profile-bootstrap.js";
import {
  addCosts,
  updateCostStatus,
  type CostIdentity,
} from "../lib/runs-client.js";
import {
  authorizeCredit,
  BillingServiceError,
} from "../lib/billing-client.js";
import { SubmitAnswerRequestSchema } from "../schemas.js";

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 100;

// Featured pitch submission is metered platform-key spend. Cost name MUST be
// byte-equal to the costs-service catalog row (runs-service 422s otherwise).
const FEATURED_PITCH_SUBMIT_COST = "featured-api-pitch-submit";

/**
 * Cancel a provisioned cost without masking the caller's real error. A
 * dangling provisioned row is reconcilable; a thrown cancel here is not worth
 * overwriting the original failure with. Logs loud per fail-loud convention.
 */
async function cancelProvisionedCost(
  runId: string,
  costId: string,
  identity: CostIdentity
): Promise<void> {
  try {
    await updateCostStatus(runId, costId, "cancelled", identity);
  } catch (err) {
    console.error(
      `[expert-quotes-requests-service] failed to cancel provisioned cost ${costId} on run ${runId}:`,
      err
    );
  }
}

export interface AnswersDeps {
  buildClient?: (
    credentials: FeaturedCredentials,
    overrides?: Partial<FeaturedClientOptions>
  ) => FeaturedClient;
  fetchLogoBytes?: FetchLogoBytes;
}

function defaultBuildClient(
  credentials: FeaturedCredentials,
  overrides?: Partial<FeaturedClientOptions>
): FeaturedClient {
  return new FeaturedClient({ credentials, ...overrides });
}

async function countRecentSubmissions(cacheKey: string): Promise<number> {
  const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);
  const rows = await db
    .select({ n: count() })
    .from(featuredSubmissions)
    .where(
      and(
        eq(featuredSubmissions.cacheKey, cacheKey),
        gte(featuredSubmissions.submittedAt, since)
      )
    );
  return Number(rows[0]?.n ?? 0);
}

export function createAnswersRouter(deps: AnswersDeps = {}): Router {
  const router = Router();
  const buildClient = deps.buildClient ?? defaultBuildClient;
  const fetchLogoBytes = deps.fetchLogoBytes;

  router.post("/orgs/featured/answers", async (req, res) => {
    const parsed = SubmitAnswerRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { brandId, featuredQuestionId, answer, externalId } = parsed.data;
    const orgId = req.orgId!;
    const userId = req.userId;
    const runId = req.runId;
    const caller = { method: "POST", path: "/orgs/featured/answers" };

    let credentials: FeaturedCredentials;
    try {
      credentials = await getFeaturedCredentials(orgId, caller, userId, runId);
    } catch (err) {
      const name = (err as Error).name;
      const message = (err as Error).message;
      if (name === "KeyServiceUnavailableError") {
        res.status(502).json({ error: message });
        return;
      }
      res.status(500).json({ error: message });
      return;
    }
    const client = buildClient(credentials);
    const cacheKey = client.getCacheKey();

    const recentCount = await countRecentSubmissions(cacheKey);
    if (recentCount >= RATE_LIMIT_MAX) {
      const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);
      const oldestRow = (
        await db
          .select({ submittedAt: featuredSubmissions.submittedAt })
          .from(featuredSubmissions)
          .where(
            and(
              eq(featuredSubmissions.cacheKey, cacheKey),
              gte(featuredSubmissions.submittedAt, since)
            )
          )
          .orderBy(asc(featuredSubmissions.submittedAt))
          .limit(1)
      )[0];
      const oldestAgeMs = oldestRow
        ? Date.now() - oldestRow.submittedAt.getTime()
        : 0;
      const retryAfter = Math.ceil(
        Math.max(RATE_LIMIT_WINDOW_MS - oldestAgeMs, 1) / 1000
      );
      res.json({ status: "rate_limited", retryAfter });
      return;
    }

    let profile: { featuredProfileId: number };
    try {
      profile = await ensureFeaturedProfile({
        orgId,
        brandId,
        userId,
        runId,
        client,
        fetchLogoBytes,
      });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
      return;
    }

    // ── Cost declaration: provision → authorize → execute → actualize ──
    // EQRS performs the terminal action (Featured /answer-question), so EQRS
    // owns the cost lifecycle for the pitch submission. costSource=platform
    // (Featured creds are platform keys). req.runId is this service's own run.
    const costIdentity: CostIdentity = {
      orgId,
      userId,
      brandId,
      campaignId: req.campaignId,
      featureSlug: req.featureSlug,
      workflowSlug: req.workflowSlug,
    };

    // 1. PROVISION — reserve the cost row before the metered call. Idempotency
    //    key is per-run so a safe retry within the same run does not duplicate.
    let costId: string;
    try {
      const costs = await addCosts(
        runId!,
        [
          {
            costName: FEATURED_PITCH_SUBMIT_COST,
            costSource: "platform",
            quantity: 1,
            status: "provisioned",
            idempotencyKey: `featured-submit:${runId}:${featuredQuestionId}:${profile.featuredProfileId}`,
          },
        ],
        costIdentity
      );
      costId = costs[0].id;
    } catch (err) {
      res.status(502).json({
        error: `failed to provision featured pitch submit cost: ${(err as Error).message}`,
      });
      return;
    }

    // 2. AUTHORIZE — affordability gate for platform spend.
    try {
      const auth = await authorizeCredit({
        items: [{ costName: FEATURED_PITCH_SUBMIT_COST, quantity: 1 }],
        description: "featured pitch submit",
        orgId,
        userId,
        runId,
        brandId,
        campaignId: req.campaignId,
        featureSlug: req.featureSlug,
        workflowSlug: req.workflowSlug,
      });
      if (!auth.sufficient) {
        await cancelProvisionedCost(runId!, costId, costIdentity);
        res.status(402).json({
          error: "insufficient credit for featured pitch submit",
          balance_cents: auth.balance_cents,
          required_cents: auth.required_cents,
        });
        return;
      }
    } catch (err) {
      await cancelProvisionedCost(runId!, costId, costIdentity);
      const status = err instanceof BillingServiceError ? err.status : 500;
      res.status(status).json({ error: (err as Error).message });
      return;
    }

    // 3. EXECUTE — the metered Featured.com call.
    try {
      await client.submitAnswer({
        answer,
        featuredQuestionId,
        profileId: profile.featuredProfileId,
      });
    } catch (err) {
      // Submit never landed → cancel the provisioned cost (not billable).
      await cancelProvisionedCost(runId!, costId, costIdentity);
      if (err instanceof FeaturedRateLimitError) {
        res.json({ status: "rate_limited", retryAfter: err.retryAfter });
        return;
      }
      await db.insert(featuredSubmissions).values({
        cacheKey,
        orgId,
        brandId,
        externalId: externalId ?? null,
        featuredQuestionId,
        featuredProfileId: profile.featuredProfileId,
        status: "error",
      });
      res.json({
        status: "error",
        error: (err as Error).message,
        featuredProfileId: profile.featuredProfileId,
      });
      return;
    }

    // 4. ACTUALIZE — the submit succeeded (irreversible at Featured). Realize
    //    the cost. If this PATCH fails we log loud but still return submitted:
    //    never surface a 5xx for a completed submit, or the caller resubmits
    //    and double-pitches. The provisioned row is reconcilable out-of-band.
    try {
      await updateCostStatus(runId!, costId, "actual", costIdentity);
    } catch (err) {
      console.error(
        `[expert-quotes-requests-service] submit succeeded but failed to actualize cost ${costId} on run ${runId}:`,
        err
      );
    }

    await db.insert(featuredSubmissions).values({
      cacheKey,
      orgId,
      brandId,
      externalId: externalId ?? null,
      featuredQuestionId,
      featuredProfileId: profile.featuredProfileId,
      status: "submitted",
    });

    res.json({
      status: "submitted",
      featuredQuestionId,
      featuredProfileId: profile.featuredProfileId,
    });
  });

  return router;
}

export default createAnswersRouter();
