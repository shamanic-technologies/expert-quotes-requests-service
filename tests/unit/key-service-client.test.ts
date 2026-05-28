import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getFeaturedCredentials,
  KeyServiceUnavailableError,
} from "../../src/lib/key-service-client.js";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("getFeaturedCredentials (key-service)", () => {
  const originalKeyUrl = process.env.KEY_SERVICE_URL;
  const originalKeyKey = process.env.KEY_SERVICE_API_KEY;

  beforeEach(() => {
    process.env.KEY_SERVICE_URL = "http://key.test";
    process.env.KEY_SERVICE_API_KEY = "test-key-service-api-key";
  });

  afterEach(() => {
    process.env.KEY_SERVICE_URL = originalKeyUrl;
    process.env.KEY_SERVICE_API_KEY = originalKeyKey;
  });

  it("fetches `featured-username` and `featured-password` separately and combines them", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith("/keys/featured-username/decrypt")) {
        return jsonResponse({
          provider: "featured-username",
          key: "kevin.lourd",
          keySource: "platform",
        });
      }
      if (url.endsWith("/keys/featured-password/decrypt")) {
        return jsonResponse({
          provider: "featured-password",
          key: "s3cr3t",
          keySource: "platform",
        });
      }
      throw new Error("unexpected url " + url);
    });

    const creds = await getFeaturedCredentials(
      "00000000-0000-0000-0000-00000000000a",
      undefined,
      undefined,
      fetchImpl as unknown as typeof fetch
    );
    expect(creds).toEqual({ username: "kevin.lourd", password: "s3cr3t" });
    expect(calls).toHaveLength(2);
  });

  it("propagates KeyServiceUnavailableError when key-service env vars unset", async () => {
    delete process.env.KEY_SERVICE_URL;
    delete process.env.KEY_SERVICE_API_KEY;
    await expect(
      getFeaturedCredentials("00000000-0000-0000-0000-00000000000a")
    ).rejects.toBeInstanceOf(KeyServiceUnavailableError);
  });

  it("propagates KeyServiceUnavailableError on non-2xx key-service response", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("not found", { status: 404 })
    );
    await expect(
      getFeaturedCredentials(
        "00000000-0000-0000-0000-00000000000a",
        undefined,
        undefined,
        fetchImpl as unknown as typeof fetch
      )
    ).rejects.toBeInstanceOf(KeyServiceUnavailableError);
  });

  it("forwards identity headers (x-org-id, x-user-id, x-run-id)", async () => {
    const observed: Array<Record<string, string>> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      observed.push(init.headers as Record<string, string>);
      const key = url.endsWith("/featured-username/decrypt")
        ? "u"
        : "p";
      return jsonResponse({
        provider: key,
        key,
        keySource: "platform",
      });
    });

    await getFeaturedCredentials(
      "00000000-0000-0000-0000-00000000000a",
      "00000000-0000-0000-0000-0000000000aa",
      "00000000-0000-0000-0000-0000000000bb",
      fetchImpl as unknown as typeof fetch
    );

    expect(observed[0]).toMatchObject({
      "x-org-id": "00000000-0000-0000-0000-00000000000a",
      "x-user-id": "00000000-0000-0000-0000-0000000000aa",
      "x-run-id": "00000000-0000-0000-0000-0000000000bb",
      "x-api-key": "test-key-service-api-key",
    });
  });

  it("throws when key-service returns missing `key` field", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ provider: "featured-username", keySource: "platform" })
    );
    await expect(
      getFeaturedCredentials(
        "00000000-0000-0000-0000-00000000000a",
        undefined,
        undefined,
        fetchImpl as unknown as typeof fetch
      )
    ).rejects.toThrow(/no key for provider/);
  });
});
