import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  FeaturedClient,
  FeaturedProfile,
} from "../../src/lib/featured-client.js";
import type { BrandContext } from "../../src/lib/brand-client.js";

// Mutable holder the mocked drizzle `db` reads from. `vi.hoisted` guarantees it
// is initialized before the hoisted `vi.mock` factory runs. `selectQueue` is
// popped once per `select(...).limit()` call so a cache-select and an
// attribution-select in the same code path get distinct results.
const h = vi.hoisted(() => ({
  state: {
    selectQueue: [] as unknown[][],
    insertResult: [] as unknown[],
    selectCalls: 0,
    insertCalls: 0,
  },
}));

vi.mock("../../src/db/index.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            h.state.selectCalls++;
            return h.state.selectQueue.shift() ?? [];
          },
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            h.state.insertCalls++;
            return h.state.insertResult;
          },
        }),
      }),
    }),
  },
}));

import {
  resolveProfileIdForDomain,
  ensureFeaturedProfile,
} from "../../src/lib/featured-profile-bootstrap.js";

const ORG = "00000000-0000-0000-0000-00000000000a";
const BRAND = "00000000-0000-0000-0000-0000000000cc";

function fakeClient(profiles: FeaturedProfile[]) {
  return {
    listProfiles: vi.fn(async () => profiles),
    createProfile: vi.fn(async () => ({ profileId: -1 })),
  } as unknown as FeaturedClient & {
    listProfiles: ReturnType<typeof vi.fn>;
    createProfile: ReturnType<typeof vi.fn>;
  };
}

function brandFn(domain: string) {
  return vi.fn(
    async (): Promise<BrandContext> => ({
      id: BRAND,
      domain,
      url: `https://${domain}`,
      name: "Test Brand",
      logoUrl: "https://logo",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    })
  );
}

describe("resolveProfileIdForDomain", () => {
  beforeEach(() => {
    h.state.selectQueue = [];
    h.state.insertResult = [];
    h.state.selectCalls = 0;
    h.state.insertCalls = 0;
    vi.clearAllMocks();
  });

  it("maps a domain to the seeded profileId (validated live on the account)", async () => {
    h.state.selectQueue = [[{ domain: "distribute.you", featuredProfileId: 88890 }]];
    const client = fakeClient([
      { profileId: 88890, isActive: true, isFlagged: false },
    ]);
    expect(await resolveProfileIdForDomain("https://www.distribute.you", client)).toBe(
      88890
    );
    expect(client.listProfiles).toHaveBeenCalledTimes(1);
  });

  it("throws when the domain is not a resolvable hostname", async () => {
    const client = fakeClient([]);
    await expect(resolveProfileIdForDomain("   ", client)).rejects.toThrow(
      /not a resolvable hostname/
    );
    expect(client.listProfiles).not.toHaveBeenCalled();
  });

  it("throws when the domain is unmapped in the registry", async () => {
    h.state.selectQueue = [[]]; // no mapping row
    const client = fakeClient([
      { profileId: 88890, isActive: true, isFlagged: false },
    ]);
    await expect(
      resolveProfileIdForDomain("unmapped-brand.com", client)
    ).rejects.toThrow(/no Featured profile mapped for brand domain "unmapped-brand.com"/);
    expect(client.listProfiles).not.toHaveBeenCalled();
  });

  it("throws when the mapped profile is absent from the account", async () => {
    h.state.selectQueue = [[{ domain: "useago.com", featuredProfileId: 94058 }]];
    const client = fakeClient([
      { profileId: 88890, isActive: true, isFlagged: false },
    ]);
    await expect(resolveProfileIdForDomain("useago.com", client)).rejects.toThrow(
      /mapped Featured profile 94058 .* not found/
    );
  });

  it("throws when the mapped profile is inactive or flagged", async () => {
    h.state.selectQueue = [[{ domain: "useago.com", featuredProfileId: 94058 }]];
    const client = fakeClient([{ profileId: 94058, isActive: false }]);
    await expect(resolveProfileIdForDomain("useago.com", client)).rejects.toThrow(
      /inactive or flagged/
    );
  });
});

describe("ensureFeaturedProfile", () => {
  beforeEach(() => {
    h.state.selectQueue = [];
    h.state.insertResult = [];
    h.state.selectCalls = 0;
    h.state.insertCalls = 0;
    vi.clearAllMocks();
  });

  it("short-circuits on a local row without calling brand-service or Featured", async () => {
    h.state.selectQueue = [
      [{ id: "x", orgId: ORG, brandId: BRAND, featuredProfileId: 42 }],
    ];
    const client = fakeClient([]);
    const getBrandFn = brandFn("distribute.you");
    const res = await ensureFeaturedProfile({
      orgId: ORG,
      brandId: BRAND,
      client,
      getBrandFn,
    });
    expect(res.featuredProfileId).toBe(42);
    expect(getBrandFn).not.toHaveBeenCalled();
    expect(client.listProfiles).not.toHaveBeenCalled();
    expect(h.state.insertCalls).toBe(0);
  });

  it("resolves via brand domain -> attribution map and persists it", async () => {
    // 1st select = cache miss; 2nd select = attribution row.
    h.state.selectQueue = [[], [{ domain: "distribute.you", featuredProfileId: 88890 }]];
    h.state.insertResult = [
      { id: "y", orgId: ORG, brandId: BRAND, featuredProfileId: 88890 },
    ];
    const client = fakeClient([
      { profileId: 88890, isActive: true, isFlagged: false },
    ]);
    const getBrandFn = brandFn("distribute.you");
    const res = await ensureFeaturedProfile({
      orgId: ORG,
      brandId: BRAND,
      client,
      getBrandFn,
    });
    expect(res.featuredProfileId).toBe(88890);
    expect(getBrandFn).toHaveBeenCalledTimes(1);
    expect(client.listProfiles).toHaveBeenCalledTimes(1);
    expect(client.createProfile).not.toHaveBeenCalled();
    expect(h.state.insertCalls).toBe(1);
  });

  it("fails loud when the brand domain is unmapped", async () => {
    h.state.selectQueue = [[], []]; // cache miss, then no attribution row
    const client = fakeClient([
      { profileId: 88890, isActive: true, isFlagged: false },
    ]);
    const getBrandFn = brandFn("unmapped-brand.com");
    await expect(
      ensureFeaturedProfile({ orgId: ORG, brandId: BRAND, client, getBrandFn })
    ).rejects.toThrow(/no Featured profile mapped/);
    expect(h.state.insertCalls).toBe(0);
  });
});
