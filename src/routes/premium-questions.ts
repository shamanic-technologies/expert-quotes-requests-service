import { Router } from "express";
import {
  FeaturedClient,
  type FeaturedClientOptions,
  type FeaturedCredentials,
} from "../lib/featured-client.js";
import { getFeaturedCredentials } from "../lib/key-service-client.js";

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

    let questions;
    try {
      questions = await client.listPremiumQuestions();
    } catch (err) {
      res.status(502).json({
        error: `Featured listPremiumQuestions failed: ${(err as Error).message}`,
      });
      return;
    }
    res.json({ questions });
  });

  return router;
}

export default createPremiumQuestionsRouter();
