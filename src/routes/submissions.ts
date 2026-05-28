import { Router } from "express";
import {
  FeaturedClient,
  type FeaturedClientOptions,
  type FeaturedCredentials,
} from "../lib/featured-client.js";
import { getFeaturedCredentials } from "../lib/key-service-client.js";
import { SubmissionsQuerySchema } from "../schemas.js";

export interface SubmissionsDeps {
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

export function createSubmissionsRouter(deps: SubmissionsDeps = {}): Router {
  const router = Router();
  const buildClient = deps.buildClient ?? defaultBuildClient;

  router.get("/orgs/featured/submissions", async (req, res) => {
    const parsed = SubmissionsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const orgId = req.orgId!;
    const userId = req.userId;
    const runId = req.runId;
    const caller = { method: "GET", path: "/orgs/featured/submissions" };

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
      resp = await client.listSubmitted(parsed.data.page ?? 1);
    } catch (err) {
      res.status(502).json({
        error: `Featured listSubmitted failed: ${(err as Error).message}`,
      });
      return;
    }
    res.json(resp);
  });

  return router;
}

export default createSubmissionsRouter();
