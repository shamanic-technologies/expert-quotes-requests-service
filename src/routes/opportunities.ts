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

function safeParseDate(value: unknown): Date | null {
  if (!value || typeof value !== "string") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function readQid(o: Record<string, unknown>): number | null {
  const raw =
    (o.featuredQuestionId as unknown) ??
    (o.featured_question_id as unknown) ??
    (o.questionId as unknown) ??
    (o.question_id as unknown) ??
    (o.id as unknown);
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isInteger(n) ? n : null;
}

function readText(o: Record<string, unknown>): string | null {
  const candidates = [
    o.opportunity,
    o.opportunity_text,
    o.opportunityText,
    o.question,
    o.text,
    o.body,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c;
  }
  return null;
}

function readStr(o: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

function readDate(o: Record<string, unknown>, ...keys: string[]): Date | null {
  for (const k of keys) {
    const d = safeParseDate(o[k]);
    if (d) return d;
  }
  return null;
}

async function refreshFromFeatured(
  client: FeaturedClient
): Promise<{ inserted: number; updated: number; skipped: number }> {
  const opps: FeaturedOpportunity[] = await client.listOpportunities();
  if (!Array.isArray(opps) || opps.length === 0) {
    console.log(
      "[expert-quotes-requests-service] Featured listOpportunities returned non-array or empty:",
      JSON.stringify(opps).slice(0, 500)
    );
    return { inserted: 0, updated: 0, skipped: 0 };
  }

  // One-shot diagnostic log: first opp's keys + shape sample.
  if (opps[0]) {
    console.log(
      "[expert-quotes-requests-service] Featured opp sample keys:",
      Object.keys(opps[0] as Record<string, unknown>).join(",")
    );
  }

  const usable: Array<{
    qid: number;
    text: string;
    mediaOutlet: string | null;
    source: string | null;
    pitchUrl: string | null;
    deadline: Date | null;
    raw: unknown;
  }> = [];
  let skipped = 0;
  for (const o of opps as unknown as Array<Record<string, unknown>>) {
    const qid = readQid(o);
    const text = readText(o);
    if (qid === null || text === null) {
      skipped++;
      continue;
    }
    usable.push({
      qid,
      text,
      mediaOutlet: readStr(o, "mediaOutlet", "media_outlet", "outlet"),
      source: readStr(o, "source", "provider"),
      pitchUrl: readStr(o, "pitchUrl", "pitch_url", "url"),
      deadline: readDate(o, "deadline", "expiresAt", "expires_at"),
      raw: o,
    });
  }
  if (usable.length === 0) {
    console.warn(
      `[expert-quotes-requests-service] refresh: all ${skipped} Featured opps filtered out`
    );
    return { inserted: 0, updated: 0, skipped };
  }

  const rows = usable.map((u) => ({
    externalId: String(u.qid),
    featuredQuestionId: u.qid,
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

  return router;
}

export default createOpportunitiesRouter();
