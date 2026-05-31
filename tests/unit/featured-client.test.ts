import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  FeaturedClient,
  FeaturedRateLimitError,
  _resetFeaturedClientState,
} from "../../src/lib/featured-client.js";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("FeaturedClient", () => {
  beforeEach(() => {
    _resetFeaturedClientState();
  });

  it("login caches JWT for 24h (single fetch on repeat call)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ "x-access-token": "tok-1" }));
    const client = new FeaturedClient({
      credentials: { username: "u1", password: "p" },
      baseUrl: "http://featured.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const t1 = await client.login();
    const t2 = await client.login();
    expect(t1).toBe("tok-1");
    expect(t2).toBe("tok-1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("re-logs in on 401 from a request and succeeds on retry", async () => {
    let loginCalls = 0;
    let opportunityCalls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/login")) {
        loginCalls++;
        return jsonResponse({ "x-access-token": `tok-${loginCalls}` });
      }
      opportunityCalls++;
      if (opportunityCalls === 1) {
        return new Response("expired", { status: 401 });
      }
      return jsonResponse([
        {
          featuredQuestionId: 1,
          opportunity: "x",
        },
      ]);
    });

    const client = new FeaturedClient({
      credentials: { username: "u-401", password: "p" },
      baseUrl: "http://featured.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.listOpportunities();
    expect(result).toHaveLength(1);
    expect(loginCalls).toBe(2);
    expect(opportunityCalls).toBe(2);
  });

  it("listOpportunities returns array", async () => {
    const opportunities = [
      {
        opportunity: "Need expert quote",
        mediaOutlet: "Forbes",
        source: "featured",
        featuredQuestionId: 42,
      },
    ];
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/login"))
        return jsonResponse({ "x-access-token": "tok" });
      return jsonResponse(opportunities);
    });

    const client = new FeaturedClient({
      credentials: { username: "u-opps", password: "p" },
      baseUrl: "http://featured.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.listOpportunities();
    expect(result).toEqual(opportunities);
  });

  it("submitAnswer counts toward rate bucket on success", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/login"))
        return jsonResponse({ "x-access-token": "tok" });
      return jsonResponse({ message: "Success" });
    });
    const client = new FeaturedClient({
      credentials: { username: "u-submit", password: "p" },
      baseUrl: "http://featured.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const answer = "x".repeat(120);
    const result = await client.submitAnswer({
      answer,
      featuredQuestionId: 1,
      profileId: 1,
    });
    expect(result.message).toBe("Success");
    expect(client.rateLimitState().remaining).toBe(99);
  });

  it("rate limiter throws on 101st submitAnswer in same window", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/login"))
        return jsonResponse({ "x-access-token": "tok" });
      return jsonResponse({ message: "Success" });
    });
    const client = new FeaturedClient({
      credentials: { username: "u-rate", password: "p" },
      baseUrl: "http://featured.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const answer = "y".repeat(120);
    for (let i = 0; i < 100; i++) {
      await client.submitAnswer({
        answer,
        featuredQuestionId: i,
        profileId: 1,
      });
    }
    await expect(
      client.submitAnswer({ answer, featuredQuestionId: 999, profileId: 1 })
    ).rejects.toBeInstanceOf(FeaturedRateLimitError);
  });

  it("submitAnswer rejects answers below 100 chars", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ "x-access-token": "tok" })
    );
    const client = new FeaturedClient({
      credentials: { username: "u-short", password: "p" },
      baseUrl: "http://featured.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      client.submitAnswer({
        answer: "too short",
        featuredQuestionId: 1,
        profileId: 1,
      })
    ).rejects.toThrow(/100-2500/);
  });

  it("createProfile retries once on 401", async () => {
    let loginCalls = 0;
    let profileCalls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/login")) {
        loginCalls++;
        return jsonResponse({ "x-access-token": `tok-${loginCalls}` });
      }
      if (url.endsWith("/add-profile")) {
        profileCalls++;
        if (profileCalls === 1) return new Response("expired", { status: 401 });
        return jsonResponse({ profileId: 555 });
      }
      throw new Error("unexpected url " + url);
    });
    const client = new FeaturedClient({
      credentials: { username: "u-profile", password: "p" },
      baseUrl: "http://featured.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const form = new FormData();
    form.set("name", "Acme");
    const result = await client.createProfile(form);
    expect(result.profileId).toBe(555);
    expect(loginCalls).toBe(2);
    expect(profileCalls).toBe(2);
  });

  it("listProfiles unwraps the { profileList: [...] } envelope", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/login"))
        return jsonResponse({ "x-access-token": "tok" });
      if (url.endsWith("/profiles"))
        return jsonResponse({
          profileList: [
            { profileId: 88890, firstName: "Kevin", isActive: true },
          ],
        });
      throw new Error("unexpected url " + url);
    });
    const client = new FeaturedClient({
      credentials: { username: "u-list", password: "p" },
      baseUrl: "http://featured.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const profiles = await client.listProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].profileId).toBe(88890);
  });

  it("listProfiles fails loud on an unexpected shape (bare array)", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/login"))
        return jsonResponse({ "x-access-token": "tok" });
      if (url.endsWith("/profiles")) return jsonResponse([{ profileId: 1 }]);
      throw new Error("unexpected url " + url);
    });
    const client = new FeaturedClient({
      credentials: { username: "u-list-bad", password: "p" },
      baseUrl: "http://featured.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.listProfiles()).rejects.toThrow(/unexpected shape/);
  });
});
