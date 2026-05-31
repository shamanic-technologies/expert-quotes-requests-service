import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  FeaturedClient,
  FeaturedProfile,
} from "../../src/lib/featured-client.js";

// Mutable holder the mocked drizzle `db` reads from. `vi.hoisted` guarantees it
// is initialized before the hoisted `vi.mock` factory runs.
const h = vi.hoisted(() => ({
  state: {
    selectResult: [] as unknown[],
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
            return h.state.selectResult;
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
  selectFeaturedProfileId,
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

describe("selectFeaturedProfileId", () => {
  it("returns the single active, non-flagged profile", () => {
    expect(
      selectFeaturedProfileId([
        { profileId: 88890, isActive: true, isFlagged: false },
      ])
    ).toBe(88890);
  });

  it("honors a FEATURED_PROFILE_ID pin among many", () => {
    expect(
      selectFeaturedProfileId(
        [
          { profileId: 1, isActive: true },
          { profileId: 2, isActive: true },
        ],
        "2"
      )
    ).toBe(2);
  });

  it("throws when there are zero profiles", () => {
    expect(() => selectFeaturedProfileId([])).toThrow(/No single usable/);
  });

  it("throws when more than one active profile and no pin", () => {
    expect(() =>
      selectFeaturedProfileId([
        { profileId: 1, isActive: true },
        { profileId: 2, isActive: true },
      ])
    ).toThrow(/No single usable/);
  });

  it("filters out flagged / inactive, leaving the one usable profile", () => {
    expect(
      selectFeaturedProfileId([
        { profileId: 1, isActive: false },
        { profileId: 2, isFlagged: true },
        { profileId: 3, isActive: true, isFlagged: false },
      ])
    ).toBe(3);
  });

  it("throws when the pinned id is not on the account", () => {
    expect(() =>
      selectFeaturedProfileId([{ profileId: 1, isActive: true }], "999")
    ).toThrow(/not found/);
  });
});

describe("ensureFeaturedProfile", () => {
  beforeEach(() => {
    h.state.selectResult = [];
    h.state.insertResult = [];
    h.state.selectCalls = 0;
    h.state.insertCalls = 0;
    vi.clearAllMocks();
    delete process.env.FEATURED_PROFILE_ID;
  });

  it("short-circuits on a local row without calling Featured", async () => {
    h.state.selectResult = [
      { id: "x", orgId: ORG, brandId: BRAND, featuredProfileId: 42 },
    ];
    const client = fakeClient([]);
    const res = await ensureFeaturedProfile({
      orgId: ORG,
      brandId: BRAND,
      client,
    });
    expect(res.featuredProfileId).toBe(42);
    expect(client.listProfiles).not.toHaveBeenCalled();
    expect(h.state.insertCalls).toBe(0);
  });

  it("resolves an existing Featured profile and persists it, never creating", async () => {
    h.state.selectResult = []; // no local row
    h.state.insertResult = [
      { id: "y", orgId: ORG, brandId: BRAND, featuredProfileId: 88890 },
    ];
    const client = fakeClient([
      { profileId: 88890, isActive: true, isFlagged: false },
    ]);
    const res = await ensureFeaturedProfile({
      orgId: ORG,
      brandId: BRAND,
      client,
    });
    expect(res.featuredProfileId).toBe(88890);
    expect(client.listProfiles).toHaveBeenCalledTimes(1);
    expect(client.createProfile).not.toHaveBeenCalled();
    expect(h.state.insertCalls).toBe(1);
  });
});
