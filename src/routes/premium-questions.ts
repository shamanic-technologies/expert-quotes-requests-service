import { Router } from "express";
import { desc, sql as drizzleSql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  featuredPremiumQuestions,
  type FeaturedPremiumQuestion as FeaturedPremiumQuestionRow,
} from "../db/schema.js";
import {
  FeaturedClient,
  type FeaturedClientOptions,
  type FeaturedCredentials,
  type FeaturedQuestion,
} from "../lib/featured-client.js";
import { getFeaturedCredentials } from "../lib/key-service-client.js";
import { config } from "../config.js";
import {
  readStr,
  readInt,
  readDate,
  deriveOutlet,
} from "../lib/featured-normalize.js";

export interface PremiumQuestionsDeps {
  buildClient?: (
    credentials: FeaturedCredentials,
    overrides?: Partial<FeaturedClientOptions>
  ) => FeaturedClient;
}

function defaultBuildClient(
  credentials: FeaturedCredentials,
  overrides?: Partial<FeaturedClientOptions>
): FeaturedClient {
  return new FeaturedClient({ credentials, ...overrides });
}

// Track last successful premium refresh time per cacheKey (single-replica TTL
// gate — same pattern + same TTL knob as the opportunities feed).
const lastPremiumRefreshAt = new Map<string, number>();

export function _resetPremiumQuestionsState() {
  lastPremiumRefreshAt.clear();
}

/**
 * Fetch Featured `/premium-question-list`, normalize each row through the shared
 * field aliases (so `mediaOutlet` is captured under any known key, not dropped),
 * and upsert into the bronze table keyed on `featuredQuestionId`. Append-only:
 * `first_seen_at` is frozen on first insert, `last_seen_at` always advances, and
 * the raw provider payload is persisted verbatim.
 */
async function refreshPremiumFromFeatured(
  client: FeaturedClient
): Promise<{ inserted: number; updated: number; skipped: number }> {
  const questions: FeaturedQuestion[] = await client.listPremiumQuestions();
  if (!Array.isArray(questions) || questions.length === 0) {
    return { inserted: 0, updated: 0, skipped: 0 };
  }

  const usable: Array<{
    featuredQuestionId: number;
    questionText: string;
    mediaOutlet: string | null;
    source: string | null;
    pitchUrl: string | null;
    deadline: Date | null;
    raw: unknown;
  }> = [];
  let skipped = 0;
  for (const q of questions as unknown as Array<Record<string, unknown>>) {
    const text = readStr(
      q,
      "question",
      "questionText",
      "question_text",
      "text",
      "body"
    );
    const featuredQuestionId = readInt(
      q,
      "featuredQuestionId",
      "featured_question_id",
      "questionId",
      "question_id"
    );
    if (!text || featuredQuestionId === null) {
      skipped++;
      continue;
    }
    usable.push({
      featuredQuestionId,
      questionText: text,
      // Featured `/premium-question-list` carries NO outlet field — derive it
      // from the declared source-site URL (`sourceUrl`). `pitchUrl`/`deadline`
      // arrive as `publicLink`/`closeDate` on this feed (the opportunities feed
      // uses different keys); list both so neither feed silently drops them.
      mediaOutlet: deriveOutlet(q),
      source: readStr(q, "source", "provider"),
      pitchUrl: readStr(q, "publicLink", "pitchUrl", "pitch_url", "url"),
      deadline: readDate(q, "closeDate", "deadline", "expiresAt", "expires_at"),
      raw: q,
    });
  }
  if (usable.length === 0) {
    console.warn(
      `[expert-quotes-requests-service] premium refresh: all ${skipped} Featured premium questions filtered out (missing question text or featuredQuestionId)`
    );
    return { inserted: 0, updated: 0, skipped };
  }

  // Dedupe by featuredQuestionId within batch — Postgres errcode 21000 disallows
  // a VALUES list affecting the same conflict-target row twice.
  const byFqid = new Map<number, (typeof usable)[number]>();
  for (const u of usable) {
    if (!byFqid.has(u.featuredQuestionId)) byFqid.set(u.featuredQuestionId, u);
  }

  const rows = Array.from(byFqid.values());

  // ON CONFLICT (featured_question_id) DO UPDATE — xmax = 0 means a new tuple was
  // inserted; non-zero means an existing tuple was updated.
  const result = await db
    .insert(featuredPremiumQuestions)
    .values(rows)
    .onConflictDoUpdate({
      target: [featuredPremiumQuestions.featuredQuestionId],
      set: {
        lastSeenAt: drizzleSql`now()`,
        raw: drizzleSql`excluded.raw`,
        questionText: drizzleSql`excluded.question_text`,
        mediaOutlet: drizzleSql`excluded.media_outlet`,
        source: drizzleSql`excluded.source`,
        pitchUrl: drizzleSql`excluded.pitch_url`,
        deadline: drizzleSql`excluded.deadline`,
      },
    })
    .returning({
      id: featuredPremiumQuestions.id,
      inserted: drizzleSql<boolean>`(xmax = 0)`,
    });

  let inserted = 0;
  let updated = 0;
  for (const r of result) {
    if (r.inserted) inserted++;
    else updated++;
  }
  if (skipped > 0) {
    console.warn(
      `[expert-quotes-requests-service] premium refresh skipped ${skipped} Featured premium questions missing featuredQuestionId or question text`
    );
  }
  return { inserted, updated, skipped };
}

/**
 * Map a bronze row to the public premium-question shape. `mediaOutlet` is the
 * NORMALIZED value (the fix); `createdAt` is passed through verbatim from the
 * stored raw payload so the contract stays faithful to Featured's original.
 */
function toPremiumItem(r: FeaturedPremiumQuestionRow) {
  const rawObj =
    r.raw && typeof r.raw === "object"
      ? (r.raw as Record<string, unknown>)
      : {};
  return {
    featuredQuestionId: r.featuredQuestionId,
    question: r.questionText,
    source: r.source,
    mediaOutlet: r.mediaOutlet,
    pitchUrl: r.pitchUrl,
    createdAt: readStr(rawObj, "createdAt", "created_at", "openDate"),
    deadline: r.deadline ? r.deadline.toISOString() : null,
  };
}

export function createPremiumQuestionsRouter(
  deps: PremiumQuestionsDeps = {}
): Router {
  const router = Router();
  const buildClient = deps.buildClient ?? defaultBuildClient;

  router.get("/orgs/featured/premium-questions", async (req, res) => {
    const orgId = req.orgId!;
    const userId = req.userId;
    const runId = req.runId;
    const caller = { method: "GET", path: "/orgs/featured/premium-questions" };

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

    // Lazy-refresh from Featured if the bronze is stale (TTL gate, shared knob
    // with the opportunities feed). Persists raw + normalized outlet.
    let refreshed = false;
    const cacheKey = client.getCacheKey();
    const last = lastPremiumRefreshAt.get(cacheKey);
    if (last === undefined || Date.now() - last > config.opportunityTtlMs) {
      try {
        await refreshPremiumFromFeatured(client);
        lastPremiumRefreshAt.set(cacheKey, Date.now());
        refreshed = true;
      } catch (err) {
        res.status(502).json({
          error: `Featured listPremiumQuestions failed: ${(err as Error).message}`,
        });
        return;
      }
    }

    // Serve from bronze (no silent limit — the premium list is the full
    // currently-answerable set the consumer ingests).
    const rows = await db
      .select()
      .from(featuredPremiumQuestions)
      .orderBy(desc(featuredPremiumQuestions.firstSeenAt));

    res.json({ questions: rows.map(toPremiumItem), refreshed });
  });

  router.post(
    "/orgs/featured/premium-questions/refresh",
    async (req, res) => {
      const orgId = req.orgId!;
      const userId = req.userId;
      const runId = req.runId;
      const caller = {
        method: "POST",
        path: "/orgs/featured/premium-questions/refresh",
      };

      let credentials: FeaturedCredentials;
      try {
        credentials = await getFeaturedCredentials(
          orgId,
          caller,
          userId,
          runId
        );
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

      let stats: { inserted: number; updated: number; skipped: number };
      try {
        stats = await refreshPremiumFromFeatured(client);
      } catch (err) {
        res.status(502).json({
          error: `Featured listPremiumQuestions failed: ${(err as Error).message}`,
        });
        return;
      }
      lastPremiumRefreshAt.set(client.getCacheKey(), Date.now());

      res.json({ refreshed: true, ...stats });
    }
  );

  return router;
}

export default createPremiumQuestionsRouter();
