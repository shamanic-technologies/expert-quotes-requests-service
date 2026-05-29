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
import { SubmitAnswerRequestSchema } from "../schemas.js";

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 100;

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

    try {
      await client.submitAnswer({
        answer,
        featuredQuestionId,
        profileId: profile.featuredProfileId,
      });
    } catch (err) {
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
