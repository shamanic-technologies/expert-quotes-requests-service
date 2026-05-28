import { OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { registry } from "../src/schemas.js";
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

const generator = new OpenApiGeneratorV3(registry.definitions);

const document = generator.generateDocument({
  openapi: "3.0.0",
  info: {
    title: "Expert Quotes Requests Service",
    description:
      "Bronze wrapper for journalist quote-request providers (Featured.com first; HARO/SOS/Qwoted later). Owns Featured.com auth lifecycle, rate-limit budgeting, cursor / sync state, and append-only bronze raw payloads.",
    version: "0.1.0",
  },
  servers: [{ url: process.env.SERVICE_URL || "http://localhost:3055" }],
});

const outputFile = join(projectRoot, "openapi.json");
writeFileSync(outputFile, JSON.stringify(document, null, 2));
console.log("openapi.json generated");
