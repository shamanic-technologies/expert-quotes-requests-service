import { describe, it, expect, vi } from "vitest";
import {
  authorizeCredit,
  BillingServiceError,
} from "../../src/lib/billing-client.js";
import {
  addCosts,
  updateCostStatus,
} from "../../src/lib/runs-client.js";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const IDENTITY = {
  orgId: "00000000-0000-0000-0000-00000000000a",
  userId: "00000000-0000-0000-0000-0000000000aa",
  brandId: "00000000-0000-0000-0000-0000000000cc",
};
const RUN_ID = "00000000-0000-0000-0000-0000000000bb";

describe("billing-client.authorizeCredit", () => {
  it("returns sufficient + posts to /v1/customer_balance/authorize with identity headers", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: unknown;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = init.headers as Record<string, string>;
      capturedBody = JSON.parse(init.body as string);
      return jsonResponse({
        sufficient: true,
        balance_cents: 5000,
        required_cents: 25,
      });
    });

    const result = await authorizeCredit(
      {
        items: [{ costName: "featured-api-pitch-submit", quantity: 1 }],
        description: "featured pitch submit",
        orgId: IDENTITY.orgId,
        userId: IDENTITY.userId,
        runId: RUN_ID,
        brandId: IDENTITY.brandId,
      },
      fetchImpl as unknown as typeof fetch
    );

    expect(result.sufficient).toBe(true);
    expect(capturedUrl).toBe(
      "http://billing.test/v1/customer_balance/authorize"
    );
    expect(capturedHeaders).toMatchObject({
      "X-API-Key": "test-billing-key",
      "x-org-id": IDENTITY.orgId,
      "x-user-id": IDENTITY.userId,
      "x-run-id": RUN_ID,
      "x-brand-id": IDENTITY.brandId,
    });
    expect(capturedBody).toEqual({
      items: [{ costName: "featured-api-pitch-submit", quantity: 1 }],
      description: "featured pitch submit",
    });
  });

  it("reports insufficient without throwing", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        sufficient: false,
        balance_cents: 10,
        required_cents: 25,
      })
    );
    const result = await authorizeCredit(
      {
        items: [{ costName: "featured-api-pitch-submit", quantity: 1 }],
        description: "x",
        orgId: IDENTITY.orgId,
      },
      fetchImpl as unknown as typeof fetch
    );
    expect(result.sufficient).toBe(false);
    expect(result.required_cents).toBe(25);
  });

  it("throws BillingServiceError(502) on non-2xx", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("upstream boom", { status: 503 })
    );
    await expect(
      authorizeCredit(
        {
          items: [{ costName: "featured-api-pitch-submit", quantity: 1 }],
          description: "x",
          orgId: IDENTITY.orgId,
        },
        fetchImpl as unknown as typeof fetch
      )
    ).rejects.toBeInstanceOf(BillingServiceError);
  });
});

describe("runs-client cost lifecycle", () => {
  it("addCosts posts provisioned item and returns the created cost id", async () => {
    let capturedUrl = "";
    let capturedBody: { items: unknown[] } = { items: [] };
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body as string);
      return jsonResponse(
        {
          costs: [
            {
              id: "cost-1",
              runId: RUN_ID,
              costName: "featured-api-pitch-submit",
              costSource: "platform",
              quantity: "1",
              unitCostInUsdCents: "25.0000000000",
              totalCostInUsdCents: "25.0000000000",
              status: "provisioned",
              idempotencyKey: "featured-submit:x",
              createdAt: "2026-05-29T00:00:00.000Z",
            },
          ],
        },
        201
      );
    });

    const costs = await addCosts(
      RUN_ID,
      [
        {
          costName: "featured-api-pitch-submit",
          costSource: "platform",
          quantity: 1,
          status: "provisioned",
          idempotencyKey: "featured-submit:x",
        },
      ],
      IDENTITY,
      fetchImpl as unknown as typeof fetch
    );

    expect(costs[0].id).toBe("cost-1");
    expect(capturedUrl).toBe(`http://runs.test/v1/runs/${RUN_ID}/costs`);
    expect(capturedBody.items).toHaveLength(1);
  });

  it("updateCostStatus PATCHes the cost to actual", async () => {
    let capturedUrl = "";
    let capturedBody: { status?: string } = {};
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body as string);
      return jsonResponse({
        id: "cost-1",
        runId: RUN_ID,
        costName: "featured-api-pitch-submit",
        costSource: "platform",
        quantity: "1",
        unitCostInUsdCents: "25.0000000000",
        totalCostInUsdCents: "25.0000000000",
        status: "actual",
        idempotencyKey: null,
        createdAt: "2026-05-29T00:00:00.000Z",
      });
    });

    await updateCostStatus(
      RUN_ID,
      "cost-1",
      "actual",
      IDENTITY,
      fetchImpl as unknown as typeof fetch
    );

    expect(capturedUrl).toBe(
      `http://runs.test/v1/runs/${RUN_ID}/costs/cost-1`
    );
    expect(capturedBody.status).toBe("actual");
  });

  it("addCosts throws on non-2xx (fail loud)", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("422 unknown cost name", { status: 422 })
    );
    await expect(
      addCosts(
        RUN_ID,
        [
          {
            costName: "bad-name",
            costSource: "platform",
            quantity: 1,
            status: "provisioned",
          },
        ],
        IDENTITY,
        fetchImpl as unknown as typeof fetch
      )
    ).rejects.toThrow(/422/);
  });
});
