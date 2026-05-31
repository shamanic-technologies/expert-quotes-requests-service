import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import { desc, sql } from "drizzle-orm";
import { createTestApp, AUTH_HEADERS } from "../helpers/test-app.js";
import { db, closeDb } from "../../src/db/index.js";
import { featuredPremiumQuestions } from "../../src/db/schema.js";
import {
  _resetPremiumQuestionsState,
  type PremiumQuestionsDeps,
} from "../../src/routes/premium-questions.js";
import {
  _resetFeaturedClientState,
  type FeaturedClient,
} from "../../src/lib/featured-client.js";

// Featured `/premium-question-list` rows. The outlet arrives under the snake_case
// `media_outlet` key here — the exact S1 shape the verbatim pass-through dropped.
const PREMIUM_S1 = [
  {
    featuredQuestionId: 101,
    question: "Premium one — fintech compliance expert wanted.",
    media_outlet: "Snake Outlet",
    source: "featured",
    pitchUrl: "https://featured.com/q/101",
    createdAt: "2026-05-20T10:00:00.000Z",
    deadline: "2026-06-01",
  },
  {
    featuredQuestionId: 102,
    question: "Premium two — SaaS pricing strategy.",
    mediaOutlet: "Camel Outlet",
    source: "featured",
    pitchUrl: "https://featured.com/q/102",
    createdAt: "2026-05-21T10:00:00.000Z",
    deadline: "2026-06-02",
  },
];

// Unrecoverable: no outlet field AND no sourceUrl (e.g. an expired premium row).
const PREMIUM_NO_SOURCE = [
  {
    featuredQuestionId: 201,
    question: "Premium with neither outlet nor source url.",
    attribution: "Unknown",
  },
];

// The REAL Featured `/premium-question-list` shape (prod, 2026-05-31): no outlet
// field, but a 100%-present `sourceUrl` (the outlet site) + `publicLink` (pitch)
// + `closeDate`/`openDate`. `attribution` is junk ("Unknown"/"DoFollow").
const PREMIUM_REAL = [
  {
    featuredQuestionId: 301,
    question: "Looking for a tech hiring expert.",
    sourceUrl: "https://www.dice.com",
    publicLink: "https://featured.com/q/301/answer",
    attribution: "DoFollow",
    categories: ["tech"],
    domainAuthority: 85,
    openDate: "2026-05-20T00:00:00.000Z",
    closeDate: "2026-06-10T00:00:00.000Z",
    isHaroQuery: false,
    mayCloseEarly: true,
  },
];

function makeFakePremiumClient(questions: unknown[]) {
  let calls = 0;
  const client = {
    getCacheKey: () => "test-cache",
    listPremiumQuestions: async () => {
      calls += 1;
      return questions;
    },
  } as unknown as FeaturedClient;
  return {
    client,
    calls: () => calls,
  };
}

function premiumDeps(client: FeaturedClient): PremiumQuestionsDeps {
  return { buildClient: () => client };
}

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
  await db.execute(sql`TRUNCATE TABLE featured_premium_questions`);
}

describe("premium-questions bronze ingest + normalized outlet", () => {
  beforeEach(async () => {
    _resetPremiumQuestionsState();
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

  // S1 — outlet under a non-`mediaOutlet` alias is normalized + served (THE fix).
  it("normalizes the outlet from snake_case media_outlet and serves it non-null", async () => {
    const { client } = makeFakePremiumClient(PREMIUM_S1);
    const app = createTestApp({ premiumQuestionsDeps: premiumDeps(client) });

    const res = await request(app)
      .get("/orgs/featured/premium-questions")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    const byId = Object.fromEntries(
      res.body.questions.map((q: { featuredQuestionId: number }) => [
        q.featuredQuestionId,
        q,
      ])
    );
    expect(byId[101].mediaOutlet).toBe("Snake Outlet");
    expect(byId[102].mediaOutlet).toBe("Camel Outlet");
    expect(res.body.refreshed).toBe(true);
  });

  // Bronze persistence: raw payload + normalized outlet land in the table.
  it("persists each premium question to bronze with raw + normalized outlet", async () => {
    const { client } = makeFakePremiumClient(PREMIUM_S1);
    const app = createTestApp({ premiumQuestionsDeps: premiumDeps(client) });

    await request(app).get("/orgs/featured/premium-questions").set(AUTH_HEADERS);

    const rows = await db
      .select()
      .from(featuredPremiumQuestions)
      .orderBy(desc(featuredPremiumQuestions.featuredQuestionId));
    expect(rows).toHaveLength(2);
    const r101 = rows.find((r) => r.featuredQuestionId === 101)!;
    expect(r101.mediaOutlet).toBe("Snake Outlet");
    expect(r101.questionText).toContain("fintech");
    // raw preserved verbatim → outlet question forever answerable from storage
    expect((r101.raw as Record<string, unknown>).media_outlet).toBe(
      "Snake Outlet"
    );
  });

  // Idempotent re-ingest keyed on featuredQuestionId.
  it("re-ingest is idempotent: one row per fqid, first_seen frozen, last_seen advances", async () => {
    const { client } = makeFakePremiumClient(PREMIUM_S1);
    const app = createTestApp({ premiumQuestionsDeps: premiumDeps(client) });

    const first = await request(app)
      .post("/orgs/featured/premium-questions/refresh")
      .set(AUTH_HEADERS);
    expect(first.body).toMatchObject({
      refreshed: true,
      inserted: 2,
      updated: 0,
      skipped: 0,
    });
    const before = await db.select().from(featuredPremiumQuestions);
    const firstSeen = before.find((r) => r.featuredQuestionId === 101)!
      .firstSeenAt;

    const second = await request(app)
      .post("/orgs/featured/premium-questions/refresh")
      .set(AUTH_HEADERS);
    expect(second.body).toMatchObject({ inserted: 0, updated: 2, skipped: 0 });

    const after = await db.select().from(featuredPremiumQuestions);
    expect(after).toHaveLength(2); // no duplicates
    const r101 = after.find((r) => r.featuredQuestionId === 101)!;
    expect(r101.firstSeenAt.getTime()).toBe(new Date(firstSeen).getTime());
    expect(r101.lastSeenAt.getTime()).toBeGreaterThanOrEqual(
      r101.firstSeenAt.getTime()
    );
  });

  // Serve shape is byte-compatible with the JQS EqrsPremiumQuestion contract.
  it("serves the EqrsPremiumQuestion shape", async () => {
    const { client } = makeFakePremiumClient(PREMIUM_S1);
    const app = createTestApp({ premiumQuestionsDeps: premiumDeps(client) });

    const res = await request(app)
      .get("/orgs/featured/premium-questions")
      .set(AUTH_HEADERS);

    const q = res.body.questions.find(
      (x: { featuredQuestionId: number }) => x.featuredQuestionId === 101
    );
    expect(Object.keys(q).sort()).toEqual(
      [
        "createdAt",
        "deadline",
        "featuredQuestionId",
        "mediaOutlet",
        "pitchUrl",
        "question",
        "source",
      ].sort()
    );
    expect(q.createdAt).toBe("2026-05-20T10:00:00.000Z"); // passthrough verbatim
    expect(q.deadline).toContain("2026-06-01");
    expect(q.pitchUrl).toBe("https://featured.com/q/101");
  });

  // Real Featured premium shape: no outlet field → derive from sourceUrl host;
  // pitchUrl ← publicLink, deadline ← closeDate, createdAt ← openDate.
  it("derives outlet from sourceUrl host and maps publicLink/closeDate/openDate", async () => {
    const { client } = makeFakePremiumClient(PREMIUM_REAL);
    const app = createTestApp({ premiumQuestionsDeps: premiumDeps(client) });

    const res = await request(app)
      .get("/orgs/featured/premium-questions")
      .set(AUTH_HEADERS);

    const q = res.body.questions[0];
    expect(q.mediaOutlet).toBe("dice.com"); // bare host, www stripped, no fabrication
    expect(q.pitchUrl).toBe("https://featured.com/q/301/answer"); // publicLink
    expect(q.deadline).toContain("2026-06-10"); // closeDate
    expect(q.createdAt).toBe("2026-05-20T00:00:00.000Z"); // openDate

    const rows = await db.select().from(featuredPremiumQuestions);
    expect(rows[0].mediaOutlet).toBe("dice.com");
    // raw preserved verbatim incl. the sourceUrl it was derived from
    expect((rows[0].raw as Record<string, unknown>).sourceUrl).toBe(
      "https://www.dice.com"
    );
  });

  // Unrecoverable — no outlet AND no sourceUrl: serve null, still persist raw.
  it("serves null outlet (and persists raw) when neither outlet nor sourceUrl exists", async () => {
    const { client } = makeFakePremiumClient(PREMIUM_NO_SOURCE);
    const app = createTestApp({ premiumQuestionsDeps: premiumDeps(client) });

    const res = await request(app)
      .get("/orgs/featured/premium-questions")
      .set(AUTH_HEADERS);
    expect(res.body.questions[0].mediaOutlet).toBeNull();

    const rows = await db.select().from(featuredPremiumQuestions);
    expect(rows).toHaveLength(1);
    expect(rows[0].mediaOutlet).toBeNull();
    expect(rows[0].raw).not.toBeNull(); // proof of absence is stored
  });

  // Lazy-refresh TTL: a second GET within the TTL does not re-hit Featured.
  it("lazy-refresh: second GET within TTL does not re-fetch from Featured", async () => {
    const fake = makeFakePremiumClient(PREMIUM_S1);
    const app = createTestApp({ premiumQuestionsDeps: premiumDeps(fake.client) });

    const first = await request(app)
      .get("/orgs/featured/premium-questions")
      .set(AUTH_HEADERS);
    const second = await request(app)
      .get("/orgs/featured/premium-questions")
      .set(AUTH_HEADERS);

    expect(first.body.refreshed).toBe(true);
    expect(second.body.refreshed).toBe(false);
    expect(fake.calls()).toBe(1); // Featured hit exactly once
    expect(second.body.questions).toHaveLength(2); // still served from bronze
  });

  // Malformed rows (missing fqid or question text) are skipped, not persisted.
  it("skips premium questions missing featuredQuestionId or question text", async () => {
    const malformed = [
      { question: "no id here", mediaOutlet: "X" }, // missing featuredQuestionId
      { featuredQuestionId: 303, mediaOutlet: "Y" }, // missing question text
      {
        featuredQuestionId: 304,
        question: "valid one",
        mediaOutlet: "Z",
      },
    ];
    const { client } = makeFakePremiumClient(malformed);
    const app = createTestApp({ premiumQuestionsDeps: premiumDeps(client) });

    const res = await request(app)
      .post("/orgs/featured/premium-questions/refresh")
      .set(AUTH_HEADERS);
    expect(res.body).toMatchObject({ inserted: 1, skipped: 2 });

    const rows = await db.select().from(featuredPremiumQuestions);
    expect(rows).toHaveLength(1);
    expect(rows[0].featuredQuestionId).toBe(304);
  });
});
