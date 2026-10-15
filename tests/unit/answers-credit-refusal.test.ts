import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * FUNNEL-CAP-NAMED-402-1016: POST /orgs/featured/answers asks billing-service to
 * authorize the pitch submit. A refusal for the campaign's sales funnel MAX
 * BUDGET must reach the caller named, with billing's `reason` +
 * `sales_funnel_cap` verbatim; a real balance shortfall keeps today's body.
 */

vi.mock("../../src/db/index.js", () => {
  const chain: any = {
    select: () => chain,
    from: () => chain,
    where: () => Promise.resolve([{ n: 0 }]),
  };
  return { db: chain, closeDb: vi.fn() };
});
vi.mock("../../src/lib/key-service-client.js", () => ({
  getFeaturedCredentials: vi.fn(async () => ({ email: "x", password: "y" })),
}));
vi.mock("../../src/lib/featured-profile-bootstrap.js", () => ({
  ensureFeaturedProfile: vi.fn(async () => ({ featuredProfileId: 42 })),
}));
const updateCostStatus = vi.fn(async () => undefined);
vi.mock("../../src/lib/runs-client.js", () => ({
  createChildRun: vi.fn(async () => ({ id: "11111111-1111-4111-8111-111111111111" })),
  closeRun: vi.fn(async () => undefined),
  addCosts: vi.fn(async () => [{ id: "cost-1" }]),
  updateCostStatus: (...a: unknown[]) => updateCostStatus(...(a as [])),
}));

const { createTestApp, AUTH_HEADERS } = await import("../helpers/test-app.js");

const BRAND = "22222222-2222-4222-8222-222222222222";
const CAP = {
  salesFunnelId: "sf-1",
  salesFunnelCampaignId: "sfc-1",
  amountCents: 5000,
  period: "month",
  consumedCents: 5000,
  reservedCents: 0,
};

const submitAnswer = vi.fn(async () => ({}));
const app = createTestApp({
  answersDeps: {
    buildClient: () => ({ getCacheKey: () => "acct-1", submitAnswer }) as any,
  },
});

function billingAnswers(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "http://billing.test/v1/customer_balance/authorize") {
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    })
  );
}

const submit = () =>
  request(app)
    .post("/orgs/featured/answers")
    .set(AUTH_HEADERS)
    .send({ brandId: BRAND, featuredQuestionId: 7, answer: "An expert answer. ".repeat(10) });

describe("POST /orgs/featured/answers credit refusal", () => {
  beforeEach(() => {
    submitAnswer.mockClear();
    updateCostStatus.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("a sales funnel max-budget refusal names the cap and carries reason + sales_funnel_cap verbatim", async () => {
    billingAnswers({
      sufficient: false,
      balance_cents: 100000,
      required_cents: 50,
      reason: "sales_funnel_max_budget_reached",
      sales_funnel_cap: CAP,
    });
    const res = await submit();
    expect(res.status).toBe(402);
    expect(res.body).toEqual({
      error: "Sales funnel max budget reached for featured pitch submit",
      balance_cents: 100000,
      required_cents: 50,
      reason: "sales_funnel_max_budget_reached",
      sales_funnel_cap: CAP,
    });
    expect(res.body.error).not.toMatch(/insufficient/i);
    expect(submitAnswer).not.toHaveBeenCalled();
    expect(updateCostStatus).toHaveBeenCalledWith(expect.anything(), "cost-1", "cancelled", expect.anything());
  });

  it("an unreadable cap is named too", async () => {
    billingAnswers({
      sufficient: false,
      balance_cents: 100000,
      required_cents: 50,
      reason: "sales_funnel_max_budget_unreadable",
      sales_funnel_cap: CAP,
    });
    const res = await submit();
    expect(res.status).toBe(402);
    expect(res.body.reason).toBe("sales_funnel_max_budget_unreadable");
    expect(res.body.sales_funnel_cap).toEqual(CAP);
    expect(res.body.error).toBe("Sales funnel max budget unreadable for featured pitch submit");
  });

  it("a real balance shortfall (no reason) is byte-identical to before", async () => {
    billingAnswers({ sufficient: false, balance_cents: 3, required_cents: 50 });
    const res = await submit();
    expect(res.status).toBe(402);
    expect(res.text).toBe(
      JSON.stringify({ error: "insufficient credit for featured pitch submit", balance_cents: 3, required_cents: 50 })
    );
    expect(submitAnswer).not.toHaveBeenCalled();
  });
});
