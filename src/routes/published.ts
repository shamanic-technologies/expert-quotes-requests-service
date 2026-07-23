import { Router } from "express";
import {
  FeaturedClient,
  type FeaturedClientOptions,
  type FeaturedCredentials,
} from "../lib/featured-client.js";
import { getFeaturedCredentials } from "../lib/key-service-client.js";
import { PublishedQuerySchema } from "../schemas.js";

export interface PublishedDeps {
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

/**
 * Pass-through of Connectively's `/published` list. Unlike `/submitted`
 * (status + outlet + DR + attribution), `/published` also carries the
 * published article's link, title, and publish date — the placement
 * fields JQS persists onto pitches so the press report can link the
 * article. Same (featuredQuestionId, profileId) match key as `/submitted`.
 */
export function createPublishedRouter(deps: PublishedDeps = {}): Router {
  const router = Router();
  const buildClient = deps.buildClient ?? defaultBuildClient;

  router.get("/orgs/featured/published", async (req, res) => {
    const parsed = PublishedQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const orgId = req.orgId!;
    const userId = req.userId;
    const runId = req.runId;
    const caller = { method: "GET", path: "/orgs/featured/published" };

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

    let resp;
    try {
      resp = await client.listPublished(parsed.data.page ?? 1);
    } catch (err) {
      res.status(502).json({
        error: `Featured listPublished failed: ${(err as Error).message}`,
      });
      return;
    }
    res.json(resp);
  });

  return router;
}

export default createPublishedRouter();
