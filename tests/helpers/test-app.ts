import "express-async-errors";
import express from "express";
import cors from "cors";
import healthRoutes from "../../src/routes/health.js";
import {
  createOpportunitiesRouter,
  type OpportunitiesDeps,
} from "../../src/routes/opportunities.js";
import {
  createAnswersRouter,
  type AnswersDeps,
} from "../../src/routes/answers.js";
import {
  createProfilesRouter,
  type ProfilesDeps,
} from "../../src/routes/profiles.js";
import {
  createPremiumQuestionsRouter,
  type PremiumQuestionsDeps,
} from "../../src/routes/premium-questions.js";
import {
  createSubmissionsRouter,
  type SubmissionsDeps,
} from "../../src/routes/submissions.js";
import {
  apiKeyAuth,
  requireOrgId,
  withRunTracking,
} from "../../src/middleware/auth.js";

export interface TestAppDeps {
  opportunitiesDeps?: OpportunitiesDeps;
  answersDeps?: AnswersDeps;
  profilesDeps?: ProfilesDeps;
  premiumQuestionsDeps?: PremiumQuestionsDeps;
  submissionsDeps?: SubmissionsDeps;
}

export function createTestApp(deps: TestAppDeps = {}) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "10mb" }));

  app.use(healthRoutes);
  app.use("/orgs", apiKeyAuth, requireOrgId, withRunTracking);
  app.use(createOpportunitiesRouter(deps.opportunitiesDeps));
  app.use(createAnswersRouter(deps.answersDeps));
  app.use(createProfilesRouter(deps.profilesDeps));
  app.use(createPremiumQuestionsRouter(deps.premiumQuestionsDeps));
  app.use(createSubmissionsRouter(deps.submissionsDeps));

  app.use((_req: express.Request, res: express.Response) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      console.error("[test-app] unhandled error:", err);
      res.status(500).json({ error: err.message });
    }
  );

  return app;
}

export const TEST_ORG_A = "00000000-0000-0000-0000-00000000000a";
export const TEST_USER = "00000000-0000-0000-0000-0000000000aa";
export const TEST_PARENT_RUN = "00000000-0000-0000-0000-0000000000bb";
export const TEST_BRAND = "00000000-0000-0000-0000-0000000000cc";

export const AUTH_HEADERS = {
  "x-api-key": "test-api-key",
  "x-org-id": TEST_ORG_A,
  "x-user-id": TEST_USER,
  "x-run-id": TEST_PARENT_RUN,
};
