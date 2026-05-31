import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getBrand } from "../../src/lib/brand-client.js";

const ORG_ID = "00000000-0000-0000-0000-00000000000a";
const BRAND_ID = "11111111-1111-4111-8111-111111111111";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const CANONICAL_BRAND = {
  id: BRAND_ID,
  domain: "acme.com",
  url: "https://acme.com",
  name: "Acme",
  logoUrl: "https://img.logo.dev/acme.com",
  createdAt: "2026-05-31T00:00:00.000Z",
  updatedAt: "2026-05-31T00:00:00.000Z",
};

describe("getBrand (brand-service /internal tier)", () => {
  const originalUrl = process.env.BRAND_SERVICE_URL;
  const originalKey = process.env.BRAND_SERVICE_API_KEY;

  beforeEach(() => {
    process.env.BRAND_SERVICE_URL = "http://brand.test";
    process.env.BRAND_SERVICE_API_KEY = "test-brand-api-key";
  });

  afterEach(() => {
    process.env.BRAND_SERVICE_URL = originalUrl;
    process.env.BRAND_SERVICE_API_KEY = originalKey;
  });

  it("calls GET /internal/brands/{id}?orgId={org} (never the dead /orgs/brands/ path)", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      return jsonResponse({ brand: CANONICAL_BRAND });
    });

    await getBrand(
      BRAND_ID,
      ORG_ID,
      undefined,
      undefined,
      fetchImpl as unknown as typeof fetch
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(
      `http://brand.test/internal/brands/${BRAND_ID}?orgId=${ORG_ID}`
    );
    expect(calls[0]).not.toContain("/orgs/brands/");
  });

  it("parses { brand } and returns the canonical minimal shape incl. logoUrl", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ brand: CANONICAL_BRAND })
    );

    const brand = await getBrand(
      BRAND_ID,
      ORG_ID,
      undefined,
      undefined,
      fetchImpl as unknown as typeof fetch
    );

    expect(brand).toEqual(CANONICAL_BRAND);
    // logo resolution: the URL the profile bootstrap fetches comes straight off
    // the brand shape — no separate media-assets call exists anymore.
    expect(brand.logoUrl).toBe("https://img.logo.dev/acme.com");
  });

  it("forwards x-api-key + x-org-id and optional identity headers", async () => {
    const observed: Array<Record<string, string>> = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      observed.push(init.headers as Record<string, string>);
      return jsonResponse({ brand: CANONICAL_BRAND });
    });

    await getBrand(
      BRAND_ID,
      ORG_ID,
      "00000000-0000-0000-0000-0000000000aa",
      "00000000-0000-0000-0000-0000000000bb",
      fetchImpl as unknown as typeof fetch
    );

    expect(observed[0]).toMatchObject({
      "x-api-key": "test-brand-api-key",
      "x-org-id": ORG_ID,
      "x-user-id": "00000000-0000-0000-0000-0000000000aa",
      "x-run-id": "00000000-0000-0000-0000-0000000000bb",
    });
  });

  it("fails loud on non-2xx with the verbatim upstream status + body", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("Cannot GET /internal/brands/x", { status: 404 })
    );

    await expect(
      getBrand(
        BRAND_ID,
        ORG_ID,
        undefined,
        undefined,
        fetchImpl as unknown as typeof fetch
      )
    ).rejects.toThrow(/404.*Cannot GET \/internal\/brands\/x/);
  });

  it("throws when the response is missing the brand object", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));

    await expect(
      getBrand(
        BRAND_ID,
        ORG_ID,
        undefined,
        undefined,
        fetchImpl as unknown as typeof fetch
      )
    ).rejects.toThrow(/missing brand/);
  });
});
