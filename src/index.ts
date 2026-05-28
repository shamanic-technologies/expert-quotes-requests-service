import * as Sentry from "@sentry/node";
import "express-async-errors";
import express from "express";
import cors from "cors";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { getSql } from "./db/index.js";
import healthRoutes from "./routes/health.js";
import opportunitiesRoutes from "./routes/opportunities.js";
import answersRoutes from "./routes/answers.js";
import profilesRoutes from "./routes/profiles.js";
import premiumQuestionsRoutes from "./routes/premium-questions.js";
import submissionsRoutes from "./routes/submissions.js";
import {
  apiKeyAuth,
  requireOrgId,
  withRunTracking,
} from "./middleware/auth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const openapiPath = join(__dirname, "..", "openapi.json");

const app = express();
const PORT = process.env.PORT || 3055;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.get("/openapi.json", (_req, res) => {
  if (existsSync(openapiPath)) {
    res.json(JSON.parse(readFileSync(openapiPath, "utf-8")));
  } else {
    res
      .status(404)
      .json({ error: "OpenAPI spec not generated. Run: pnpm generate:openapi" });
  }
});

app.use(healthRoutes);

// /orgs/* — api key + org id + mandatory run tracking
app.use("/orgs", apiKeyAuth, requireOrgId, withRunTracking);
app.use(opportunitiesRoutes);
app.use(answersRoutes);
app.use(profilesRoutes);
app.use(premiumQuestionsRoutes);
app.use(submissionsRoutes);

app.use((_req: express.Request, res: express.Response) => {
  res.status(404).json({ error: "Not found" });
});

Sentry.setupExpressErrorHandler(app);

app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error("[expert-quotes-requests-service] unhandled error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
);

if (process.env.NODE_ENV !== "test") {
  const dbUrl = process.env.EXPERT_QUOTES_REQUESTS_SERVICE_DATABASE_URL;

  const startServer = () => {
    app.listen(Number(PORT), "::", () => {
      console.log(
        `[expert-quotes-requests-service] listening on port ${PORT}`
      );
    });
  };

  if (dbUrl) {
    const migrateDb = drizzle(getSql());
    migrate(migrateDb, { migrationsFolder: "./drizzle" })
      .then(() => {
        console.log("[expert-quotes-requests-service] migrations complete");
        startServer();
      })
      .catch((err) => {
        console.error(
          "[expert-quotes-requests-service] migration failed:",
          err
        );
        process.exit(1);
      });
  } else {
    console.warn(
      "[expert-quotes-requests-service] EXPERT_QUOTES_REQUESTS_SERVICE_DATABASE_URL not set, skipping migrations"
    );
    startServer();
  }
}

export default app;
