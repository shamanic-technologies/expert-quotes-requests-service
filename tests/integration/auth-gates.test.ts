import { describe, it, expect } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";

describe("Auth gates on /orgs/*", () => {
  const app = createTestApp();

  it("rejects missing x-api-key with 401", async () => {
    const response = await request(app).get("/orgs/featured/opportunities");
    expect(response.status).toBe(401);
    expect(response.body.error).toMatch(/Unauthorized/);
  });

  it("rejects wrong x-api-key with 401", async () => {
    const response = await request(app)
      .get("/orgs/featured/opportunities")
      .set("x-api-key", "wrong-key");
    expect(response.status).toBe(401);
  });

  it("rejects missing x-org-id with 400 when api-key is valid", async () => {
    const response = await request(app)
      .get("/orgs/featured/opportunities")
      .set("x-api-key", "test-api-key");
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/x-org-id/);
  });
});
