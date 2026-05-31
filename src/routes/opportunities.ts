import { Router } from "express";
import {
  and,
  gt,
  eq,
  desc,
  inArray,
  notExists,
  sql as drizzleSql,
} from "drizzle-orm";
import { db } from "../db/index.js";
import {
  featuredOpportunities,
  featuredDeliveries,
  featuredSubmissions,
  type FeaturedOpportunity as FeaturedOpportunityRow,
} from "../db/schema.js";
import {
  FeaturedClient,
  type FeaturedClientOptions,
  type FeaturedCredentials,
  type FeaturedOpportunity,
} from "../lib/featured-client.js";
import { getFeaturedCredentials } from "../lib/key-service-client.js";
import { config } from "../config.js";
import {
  OpportunitiesListQuerySchema,
  SubmissionStatusRequestSchema,
} from "../schemas.js";
import {
  readStr,
  readInt,
  readDate,
  deriveOutlet,
} from "../lib/featured-normalize.js";

export interface OpportunitiesDeps {
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

// Track last successful refresh time per cacheKey (single-replica TTL gate).
const lastRefreshAt = new Map<string, number>();

export function _resetOpportunitiesState() {
  lastRefreshAt.clear();
}

async function refreshFromFeatured(
  client: FeaturedClient
): Promise<{ inserted: number; updated: number; skipped: number }> {
  const opps: FeaturedOpportunity[] = await client.listOpportunities();
  if (!Array.isArray(opps) || opps.length === 0) {
    return { inserted: 0, updated: 0, skipped: 0 };
  }

  // Featured.com `/opportunities-list` shape (confirmed via JQS pre-EQRS
  // bronze inspection 2026-05-28):
  //   { opportunity, pitchUrl, mediaOutlet, source, deadline, createdAt }
  // No `featuredQuestionId` (that field is only on /premium-question-list).
  // `pitchUrl` is the natural unique key per opportunity.
  // `deadline` / `createdAt` are non-ISO human strings — safeParseDate falls
  // back to null when JS Date can't parse them.

  const usable: Array<{
    externalId: string;
    text: string;
    mediaOutlet: string | null;
    source: string | null;
    pitchUrl: string | null;
    deadline: Date | null;
    featuredQuestionId: number | null;
    raw: unknown;
  }> = [];
  let skipped = 0;
  for (const o of opps as unknown as Array<Record<string, unknown>>) {
    const text = readStr(o, "opportunity", "opportunity_text", "question", "text", "body");
    const pitchUrl = readStr(o, "pitchUrl", "pitch_url", "url");
    if (!text || !pitchUrl) {
      skipped++;
      continue;
    }
    usable.push({
      externalId: pitchUrl,
      text,
      pitchUrl,
      mediaOutlet: deriveOutlet(o),
      source: readStr(o, "source", "provider"),
      deadline: readDate(o, "deadline", "expiresAt", "expires_at"),
      featuredQuestionId: readInt(
        o,
        "featuredQuestionId",
        "featured_question_id",
        "questionId",
        "question_id"
      ),
      raw: o,
    });
  }
  if (usable.length === 0) {
    console.warn(
      `[expert-quotes-requests-service] refresh: all ${skipped} Featured opps filtered out (missing opportunity text or pitchUrl)`
    );
    return { inserted: 0, updated: 0, skipped };
  }

  // Dedupe by externalId within batch — Postgres errcode 21000 disallows
  // VALUES list affecting the same conflict-target row twice.
  const byExternal = new Map<string, (typeof usable)[number]>();
  for (const u of usable) {
    if (!byExternal.has(u.externalId)) byExternal.set(u.externalId, u);
  }

  const rows = Array.from(byExternal.values()).map((u) => ({
    externalId: u.externalId,
    featuredQuestionId: u.featuredQuestionId,
    opportunityText: u.text,
    mediaOutlet: u.mediaOutlet,
    source: u.source ?? "featured",
    pitchUrl: u.pitchUrl,
    deadline: u.deadline,
    raw: u.raw,
  }));

  // ON CONFLICT (external_id) DO UPDATE — use xmax to distinguish insert vs update.
  // xmax = 0 means a new tuple was inserted; non-zero means an existing tuple was updated.
  const result = await db
    .insert(featuredOpportunities)
    .values(rows)
    .onConflictDoUpdate({
      target: [featuredOpportunities.externalId],
      set: {
        lastSeenAt: drizzleSql`now()`,
        raw: drizzleSql`excluded.raw`,
        opportunityText: drizzleSql`excluded.opportunity_text`,
        mediaOutlet: drizzleSql`excluded.media_outlet`,
        source: drizzleSql`excluded.source`,
        pitchUrl: drizzleSql`excluded.pitch_url`,
        deadline: drizzleSql`excluded.deadline`,
      },
    })
    .returning({
      id: featuredOpportunities.id,
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
      `[expert-quotes-requests-service] refresh skipped ${skipped} Featured opps missing featuredQuestionId or opportunity text`
    );
  }
  return { inserted, updated, skipped };
}

function toItem(r: FeaturedOpportunityRow) {
  return {
    id: r.id,
    externalId: r.externalId,
    featuredQuestionId: r.featuredQuestionId,
    opportunityText: r.opportunityText,
    mediaOutlet: r.mediaOutlet,
    source: r.source,
    pitchUrl: r.pitchUrl,
    deadline: r.deadline ? r.deadline.toISOString() : null,
    raw: r.raw,
    firstSeenAt: r.firstSeenAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
  };
}

/**
 * Per-brand delivery mode: return bronze opportunities never delivered to this
 * (org, brand), newest-first, up to `limit`, and atomically record them as
 * delivered. Identity is the atomic single `brandId`. Consecutive calls return
 * disjoint sets; once exhausted the result is `[]` so a polling consumer
 * terminates.
 *
 * Selection + recording run in one transaction; the INSERT ... ON CONFLICT DO
 * NOTHING ... RETURNING returns only rows THIS call won, so concurrent callers
 * for the same (org, brand) never double-serve a row.
 */
async function selectAndRecordDelivery(
  orgId: string,
  brandId: string,
  limit: number
): Promise<FeaturedOpportunityRow[]> {
  return db.transaction(async (tx) => {
    const candidates = await tx
      .select()
      .from(featuredOpportunities)
      .where(
        notExists(
          tx
            .select({ one: drizzleSql`1` })
            .from(featuredDeliveries)
            .where(
              and(
                eq(featuredDeliveries.orgId, orgId),
                eq(featuredDeliveries.brandId, brandId),
                eq(featuredDeliveries.externalId, featuredOpportunities.externalId)
              )
            )
        )
      )
      .orderBy(desc(featuredOpportunities.firstSeenAt))
      .limit(limit);

    if (candidates.length === 0) return [];

    const inserted = await tx
      .insert(featuredDeliveries)
      .values(
        candidates.map((c) => ({ orgId, brandId, externalId: c.externalId }))
      )
      .onConflictDoNothing()
      .returning({ externalId: featuredDeliveries.externalId });

    const won = new Set(inserted.map((r) => r.externalId));
    return candidates.filter((c) => won.has(c.externalId));
  });
}

export interface SubmissionStatusEntry {
  externalId: string;
  submitted: boolean;
  lastStatus: string | null;
  submittedAt: string | null;
}

/**
 * Authoritative per-(org, brand, opportunity) submitted-status. `submitted` is
 * true ONLY when a ledger row with `status = 'submitted'` exists; `error` /
 * pending / absent → `submitted = false` so the opportunity stays offerable
 * (failed submits are NOT served). Keyed on the atomic single `brandId` +
 * `externalId` — the same identity the opportunities feed exposes.
 */
async function getSubmissionStatuses(
  orgId: string,
  brandId: string,
  externalIds: string[]
): Promise<SubmissionStatusEntry[]> {
  const rows = externalIds.length
    ? await db
        .select({
          externalId: featuredSubmissions.externalId,
          status: featuredSubmissions.status,
          submittedAt: featuredSubmissions.submittedAt,
        })
        .from(featuredSubmissions)
        .where(
          and(
            eq(featuredSubmissions.orgId, orgId),
            eq(featuredSubmissions.brandId, brandId),
            inArray(featuredSubmissions.externalId, externalIds)
          )
        )
    : [];

  const byExternal = new Map<
    string,
    { submitted: boolean; lastStatus: string | null; latestAt: Date | null; submittedAt: Date | null }
  >();
  for (const r of rows) {
    if (!r.externalId) continue;
    const agg =
      byExternal.get(r.externalId) ??
      { submitted: false, lastStatus: null, latestAt: null, submittedAt: null };
    if (agg.latestAt === null || r.submittedAt > agg.latestAt) {
      agg.latestAt = r.submittedAt;
      agg.lastStatus = r.status;
    }
    if (r.status === "submitted") {
      agg.submitted = true;
      if (agg.submittedAt === null || r.submittedAt > agg.submittedAt) {
        agg.submittedAt = r.submittedAt;
      }
    }
    byExternal.set(r.externalId, agg);
  }

  // One entry per REQUESTED externalId, deduped, preserving request order.
  const seen = new Set<string>();
  const result: SubmissionStatusEntry[] = [];
  for (const externalId of externalIds) {
    if (seen.has(externalId)) continue;
    seen.add(externalId);
    const agg = byExternal.get(externalId);
    result.push({
      externalId,
      submitted: agg?.submitted ?? false,
      lastStatus: agg?.lastStatus ?? null,
      submittedAt: agg?.submittedAt ? agg.submittedAt.toISOString() : null,
    });
  }
  return result;
}

export function createOpportunitiesRouter(deps: OpportunitiesDeps = {}): Router {
  const router = Router();
  const buildClient = deps.buildClient ?? defaultBuildClient;

  router.get("/orgs/featured/opportunities", async (req, res) => {
    const parsed = OpportunitiesListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { since, limit, brandId } = parsed.data;
    const orgId = req.orgId!;
    const userId = req.userId;
    const runId = req.runId;
    const caller = { method: "GET", path: "/orgs/featured/opportunities" };

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

    let refreshed = false;
    const cacheKey = client.getCacheKey();
    const last = lastRefreshAt.get(cacheKey);
    if (last === undefined || Date.now() - last > config.opportunityTtlMs) {
      try {
        await refreshFromFeatured(client);
        lastRefreshAt.set(cacheKey, Date.now());
        refreshed = true;
      } catch (err) {
        res.status(502).json({
          error: `Featured listOpportunities failed: ${(err as Error).message}`,
        });
        return;
      }
    }

    // Per-brand delivery mode: return only opportunities never delivered to
    // this (org, brand) and record them as delivered. Disjoint across calls;
    // exhausted → []. `nextSince` is null here — the delivery ledger is the
    // cursor, not the timestamp.
    if (brandId) {
      const rows = await selectAndRecordDelivery(orgId, brandId, limit ?? 100);
      res.json({ items: rows.map(toItem), nextSince: null, refreshed });
      return;
    }

    // Legacy org-scoped timestamp cursor (no brandId): unchanged behavior.
    const conditions = [];
    if (since) conditions.push(gt(featuredOpportunities.firstSeenAt, new Date(since)));
    const rows = await db
      .select()
      .from(featuredOpportunities)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(featuredOpportunities.firstSeenAt))
      .limit(limit ?? 100);

    const items = rows.map(toItem);

    const nextSince =
      items.length > 0
        ? items.reduce((max, it) => (it.firstSeenAt > max ? it.firstSeenAt : max), items[0].firstSeenAt)
        : null;

    res.json({ items, nextSince, refreshed });
  });

  router.post("/orgs/featured/opportunities/refresh", async (req, res) => {
    const orgId = req.orgId!;
    const userId = req.userId;
    const runId = req.runId;
    const caller = {
      method: "POST",
      path: "/orgs/featured/opportunities/refresh",
    };

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

    let stats: { inserted: number; updated: number };
    try {
      stats = await refreshFromFeatured(client);
    } catch (err) {
      res.status(502).json({
        error: `Featured listOpportunities failed: ${(err as Error).message}`,
      });
      return;
    }
    lastRefreshAt.set(client.getCacheKey(), Date.now());

    res.json({ refreshed: true, ...stats });
  });

  // Authoritative submitted-status for a set of opportunities, keyed on the
  // atomic single brandId + externalId. Lets a consumer exclude already-pitched
  // opportunities and re-offer failed ones. Pure DB lookup — no Featured call.
  router.post(
    "/orgs/featured/opportunities/submission-status",
    async (req, res) => {
      const parsed = SubmissionStatusRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.message });
        return;
      }
      const { brandId, externalIds } = parsed.data;
      const orgId = req.orgId!;
      const statuses = await getSubmissionStatuses(orgId, brandId, externalIds);
      res.json({ statuses });
    }
  );

  return router;
}

export default createOpportunitiesRouter();
