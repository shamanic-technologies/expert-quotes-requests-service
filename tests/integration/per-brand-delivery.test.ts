import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
  afterEach,
  vi,
} from "vitest";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import {
  createTestApp,
  AUTH_HEADERS,
  TEST_ORG_A,
} from "../helpers/test-app.js";
import { db, closeDb } from "../../src/db/index.js";
import {
  featuredOpportunities,
  featuredSubmissions,
  featuredProfiles,
} from "../../src/db/schema.js";
import {
  _resetOpportunitiesState,
  type OpportunitiesDeps,
} from "../../src/routes/opportunities.js";
import {
  _resetFeaturedClientState,
  type FeaturedClient,
} from "../../src/lib/featured-client.js";

// Valid v4 UUIDs (variant nibble 8/9 — Zod 4 .uuid() is variant-strict).
const BRAND_A = "11111111-1111-4111-8111-111111111111";
const BRAND_B = "22222222-2222-4222-9222-222222222222";

const OPPS = [
  {
    opportunity: "Opportunity one — looking for a fintech expert quote.",
    pitchUrl: "https://featured.com/p/1",
    mediaOutlet: "Outlet One",
    source: "featured",
    deadline: "2026-06-01",
  },
  {
    opportunity: "Opportunity two — need a SaaS founder perspective.",
    pitchUrl: "https://featured.com/p/2",
    mediaOutlet: "Outlet Two",
    source: "featured",
    deadline: "2026-06-02",
  },
  {
    opportunity: "Opportunity three — security researcher wanted.",
    pitchUrl: "https://featured.com/p/3",
    mediaOutlet: "Outlet Three",
    source: "featured",
    deadline: "2026-06-03",
  },
];

function makeFakeClient(opps: unknown[] = OPPS): FeaturedClient {
  return {
    getCacheKey: () => "test-cache",
    listOpportunities: async () => opps,
    submitAnswer: async () => ({ message: "ok" }),
  } as unknown as FeaturedClient;
}

function feedDeps(opps: unknown[] = OPPS): OpportunitiesDeps {
  return { buildClient: () => makeFakeClient(opps) };
}

// Mock key-service decrypt so getFeaturedCredentials resolves; Featured itself
// is bypassed via the injected buildClient.
function stubKeyService() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes("/keys/") && u.includes("/decrypt")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            provider: "featured",
            key: "secret",
            keySource: "platform",
          }),
          text: async () => "",
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch in test: ${u}`);
    })
  );
}

async function cleanTestData() {
  await db.execute(
    sql`TRUNCATE TABLE featured_opportunities, featured_deliveries, featured_submissions, featured_profiles`
  );
}

function externalIds(body: { items: Array<{ externalId: string }> }): string[] {
  return body.items.map((i) => i.externalId);
}

describe("per-brand delivery cursor + submitted-status", () => {
  beforeEach(async () => {
    _resetOpportunitiesState();
    _resetFeaturedClientState();
    stubKeyService();
    await cleanTestData();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await closeDb();
  });

  // AC1
  it("returns disjoint sets across consecutive pulls and drains to empty", async () => {
    const app = createTestApp({ opportunitiesDeps: feedDeps() });

    const call1 = await request(app)
      .get("/orgs/featured/opportunities")
      .query({ brandId: BRAND_A, limit: 2 })
      .set(AUTH_HEADERS);
    const call2 = await request(app)
      .get("/orgs/featured/opportunities")
      .query({ brandId: BRAND_A, limit: 2 })
      .set(AUTH_HEADERS);
    const call3 = await request(app)
      .get("/orgs/featured/opportunities")
      .query({ brandId: BRAND_A, limit: 2 })
      .set(AUTH_HEADERS);

    expect(call1.status).toBe(200);
    const s1 = externalIds(call1.body);
    const s2 = externalIds(call2.body);
    const s3 = externalIds(call3.body);

    expect(s1).toHaveLength(2);
    expect(s2).toHaveLength(1);
    expect(s3).toHaveLength(0); // exhausted → loop terminates

    // disjoint + union covers all 3 ingested opportunities
    expect(s1.filter((x) => s2.includes(x))).toHaveLength(0);
    expect(new Set([...s1, ...s2])).toEqual(
      new Set(OPPS.map((o) => o.pitchUrl))
    );
    expect(call1.body.nextSince).toBeNull();
  });

  // AC3
  it("keys delivery on the atomic single brandId (brand A delivery does not affect brand B)", async () => {
    const app = createTestApp({ opportunitiesDeps: feedDeps() });

    const a1 = await request(app)
      .get("/orgs/featured/opportunities")
      .query({ brandId: BRAND_A })
      .set(AUTH_HEADERS);
    expect(externalIds(a1.body)).toHaveLength(OPPS.length);

    const a2 = await request(app)
      .get("/orgs/featured/opportunities")
      .query({ brandId: BRAND_A })
      .set(AUTH_HEADERS);
    expect(externalIds(a2.body)).toHaveLength(0); // drained for A

    const b1 = await request(app)
      .get("/orgs/featured/opportunities")
      .query({ brandId: BRAND_B })
      .set(AUTH_HEADERS);
    // brand B never delivered → still gets everything
    expect(new Set(externalIds(b1.body))).toEqual(
      new Set(OPPS.map((o) => o.pitchUrl))
    );
  });

  // AC2
  it("reports authoritative submitted-status for a set of opportunities", async () => {
    const submittedExternal = "https://featured.com/p/1";
    const neverExternal = "https://featured.com/p/2";
    await db.insert(featuredSubmissions).values({
      cacheKey: "ck",
      orgId: TEST_ORG_A,
      brandId: BRAND_A,
      externalId: submittedExternal,
      featuredQuestionId: 101,
      featuredProfileId: 5,
      status: "submitted",
    });

    const app = createTestApp();
    const res = await request(app)
      .post("/orgs/featured/opportunities/submission-status")
      .set(AUTH_HEADERS)
      .send({ brandId: BRAND_A, externalIds: [submittedExternal, neverExternal] });

    expect(res.status).toBe(200);
    const byId = Object.fromEntries(
      res.body.statuses.map((s: { externalId: string }) => [s.externalId, s])
    );
    expect(byId[submittedExternal].submitted).toBe(true);
    expect(byId[submittedExternal].lastStatus).toBe("submitted");
    expect(byId[submittedExternal].submittedAt).not.toBeNull();
    expect(byId[neverExternal].submitted).toBe(false);
    expect(byId[neverExternal].lastStatus).toBeNull();
  });

  // AC3 (status scope) — submitted for brand A is not submitted for brand B
  it("scopes submitted-status to the atomic single brandId", async () => {
    const ext = "https://featured.com/p/1";
    await db.insert(featuredSubmissions).values({
      cacheKey: "ck",
      orgId: TEST_ORG_A,
      brandId: BRAND_A,
      externalId: ext,
      featuredQuestionId: 101,
      featuredProfileId: 5,
      status: "submitted",
    });

    const app = createTestApp();
    const res = await request(app)
      .post("/orgs/featured/opportunities/submission-status")
      .set(AUTH_HEADERS)
      .send({ brandId: BRAND_B, externalIds: [ext] });

    expect(res.status).toBe(200);
    expect(res.body.statuses[0].submitted).toBe(false);
  });

  // AC4
  it("does NOT treat failed submits as served (error stays offerable)", async () => {
    const ext = "https://featured.com/p/9";
    await db.insert(featuredSubmissions).values({
      cacheKey: "ck",
      orgId: TEST_ORG_A,
      brandId: BRAND_A,
      externalId: ext,
      featuredQuestionId: 909,
      featuredProfileId: 5,
      status: "error",
    });

    const app = createTestApp();
    const res = await request(app)
      .post("/orgs/featured/opportunities/submission-status")
      .set(AUTH_HEADERS)
      .send({ brandId: BRAND_A, externalIds: [ext] });

    expect(res.status).toBe(200);
    expect(res.body.statuses[0].submitted).toBe(false);
    expect(res.body.statuses[0].lastStatus).toBe("error");
  });

  // AC2 (write path) — submit persists externalId to the ledger
  it("persists externalId on the submission ledger", async () => {
    // Pre-seed profile so bootstrap short-circuits (no brand-service/Featured).
    await db.insert(featuredProfiles).values({
      orgId: TEST_ORG_A,
      brandId: BRAND_A,
      featuredProfileId: 77,
    });

    const ext = "https://featured.com/p/submitted";
    const app = createTestApp({
      answersDeps: { buildClient: () => makeFakeClient() },
    });
    const res = await request(app)
      .post("/orgs/featured/answers")
      .set(AUTH_HEADERS)
      .send({
        brandId: BRAND_A,
        featuredQuestionId: 555,
        answer: "x".repeat(120),
        externalId: ext,
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("submitted");

    const rows = await db
      .select()
      .from(featuredSubmissions)
      .where(
        and(
          eq(featuredSubmissions.orgId, TEST_ORG_A),
          eq(featuredSubmissions.externalId, ext)
        )
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toBe(ext);
    expect(rows[0].status).toBe("submitted");
  });
});
