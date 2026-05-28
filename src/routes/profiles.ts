import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { featuredProfiles } from "../db/schema.js";
import {
  FeaturedClient,
  type FeaturedClientOptions,
  type FeaturedCredentials,
} from "../lib/featured-client.js";
import { getFeaturedCredentials } from "../lib/key-service-client.js";
import {
  ensureFeaturedProfile,
  type FetchLogoBytes,
} from "../lib/featured-profile-bootstrap.js";
import {
  CreateProfileRequestSchema,
  ProfilesListQuerySchema,
} from "../schemas.js";

export interface ProfilesDeps {
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

function toRow(r: typeof featuredProfiles.$inferSelect) {
  return {
    id: r.id,
    orgId: r.orgId,
    brandId: r.brandId,
    featuredProfileId: r.featuredProfileId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function createProfilesRouter(deps: ProfilesDeps = {}): Router {
  const router = Router();
  const buildClient = deps.buildClient ?? defaultBuildClient;
  const fetchLogoBytes = deps.fetchLogoBytes;

  router.get("/orgs/featured/profiles", async (req, res) => {
    const parsed = ProfilesListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const orgId = req.orgId!;
    const conditions = [eq(featuredProfiles.orgId, orgId)];
    if (parsed.data.brandId) {
      conditions.push(eq(featuredProfiles.brandId, parsed.data.brandId));
    }
    const rows = await db
      .select()
      .from(featuredProfiles)
      .where(and(...conditions));
    res.json({ profiles: rows.map(toRow) });
  });

  router.post("/orgs/featured/profiles", async (req, res) => {
    const parsed = CreateProfileRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const orgId = req.orgId!;
    const userId = req.userId;
    const runId = req.runId;
    const { brandId } = parsed.data;

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

    try {
      await ensureFeaturedProfile({
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

    const [row] = await db
      .select()
      .from(featuredProfiles)
      .where(
        and(
          eq(featuredProfiles.orgId, orgId),
          eq(featuredProfiles.brandId, brandId)
        )
      )
      .limit(1);
    res.json({ profile: toRow(row) });
  });

  router.post(
    "/orgs/featured/profiles/:profileId/deactivate",
    async (req, res) => {
      const orgId = req.orgId!;
      const userId = req.userId;
      const runId = req.runId;
      const profileId = Number(req.params.profileId);
      if (!Number.isInteger(profileId)) {
        res.status(400).json({ error: "profileId must be integer" });
        return;
      }

      const [existing] = await db
        .select()
        .from(featuredProfiles)
        .where(
          and(
            eq(featuredProfiles.orgId, orgId),
            eq(featuredProfiles.featuredProfileId, profileId)
          )
        )
        .limit(1);
      if (!existing) {
        res.status(404).json({ error: "Profile not found for this org" });
        return;
      }

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

      try {
        await client.deactivateProfile(profileId);
      } catch (err) {
        res.status(502).json({ error: (err as Error).message });
        return;
      }

      res.json({ ok: true as const });
    }
  );

  return router;
}

export default createProfilesRouter();
