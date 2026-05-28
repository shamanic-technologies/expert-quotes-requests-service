import { describe, it, expect } from "vitest";
import { OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { registry } from "../../src/schemas.js";

describe("openapi spec coverage", () => {
  const generator = new OpenApiGeneratorV3(registry.definitions);
  const document = generator.generateDocument({
    openapi: "3.0.0",
    info: {
      title: "Expert Quotes Requests Service",
      version: "0.1.0",
    },
  });

  it("registers all 8 routes", () => {
    const paths = Object.keys(document.paths ?? {});
    expect(paths).toContain("/health");
    expect(paths).toContain("/orgs/featured/opportunities");
    expect(paths).toContain("/orgs/featured/opportunities/refresh");
    expect(paths).toContain("/orgs/featured/answers");
    expect(paths).toContain("/orgs/featured/profiles");
    expect(paths).toContain("/orgs/featured/profiles/{profileId}/deactivate");
    expect(paths).toContain("/orgs/featured/premium-questions");
    expect(paths).toContain("/orgs/featured/submissions");
  });

  it("opportunities cursor query schema exposes `since` and `limit`", () => {
    const spec = document.paths?.["/orgs/featured/opportunities"]?.get;
    expect(spec).toBeDefined();
    const params = (spec as { parameters?: Array<{ name: string }> })
      .parameters;
    const paramNames = (params ?? []).map((p) => p.name);
    expect(paramNames).toContain("since");
    expect(paramNames).toContain("limit");
  });

  it("submit-answer schema enforces 100..2500 char answer length", () => {
    const schemas = document.components?.schemas ?? {};
    const submitAnswer = schemas.SubmitAnswerRequest as {
      properties: { answer: { minLength: number; maxLength: number } };
    };
    expect(submitAnswer.properties.answer.minLength).toBe(100);
    expect(submitAnswer.properties.answer.maxLength).toBe(2500);
  });
});
