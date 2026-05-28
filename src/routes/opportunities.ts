import { Router } from "express";
import { and, gt, desc, sql as drizzleSql } from "drizzle-orm";
import { db } from "../db/index.js";
import { featuredOpportunities } from "../db/schema.js";
import {
  FeaturedClient,
  type FeaturedClientOptions,
  type FeaturedCredentials,
  type FeaturedOpportunity,
} from "../lib/featured-client.js";
import { getFeaturedCredentials } from "../lib/key-service-client.js";
import { config } from "../config.js";
import { OpportunitiesListQuerySchema } from "../schemas.js";

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
): Promise<{ inserted: number; updated: number }> {
  const opps: FeaturedOpportunity[] = await client.listOpportunities();
  if (opps.length === 0) return { inserted: 0, updated: 0 };

  const rows = opps.map((o) => ({
    externalId: String(o.featuredQuestionId),
    featuredQuestionId: o.featuredQuestionId,
    opportunityText: o.opportunity,
    mediaOutlet: o.mediaOutlet ?? null,
    source: o.source ?? "featured",
    pitchUrl: o.pitchUrl ?? null,
    deadline: o.deadline ? new Date(o.deadline) : null,
    raw: o,
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
  return { inserted, updated };
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
    const { since, limit } = parsed.data;
    const orgId = req.orgId!;
    const userId = req.userId;
    const runId = req.runId;

    let credentials: FeaturedCredentials;
    try {
      credentials = await getFeaturedCredentials(orgId, userId, runId);
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

    const conditions = [];
    if (since) conditions.push(gt(featuredOpportunities.firstSeenAt, new Date(since)));
    const rows = await db
      .select()
      .from(featuredOpportunities)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(featuredOpportunities.firstSeenAt))
      .limit(limit ?? 100);

    const items = rows.map((r) => ({
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
    }));

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

    let credentials: FeaturedCredentials;
    try {
      credentials = await getFeaturedCredentials(orgId, userId, runId);
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

  return router;
}

export default createOpportunitiesRouter();
