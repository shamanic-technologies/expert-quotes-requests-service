import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/**
 * Single-row JWT cache per Featured account (keyed by username via `cacheKey`).
 * Single-replica deploy assumed (see CLAUDE.md). Future multi-replica support
 * would move state to DB rows — table exists today to hold cached tokens once
 * we scale out; current code uses an in-memory `Map` instead.
 *
 * Kept as a placeholder so the migration shape is forward-compatible.
 */
export const featuredJwt = pgTable("featured_jwt", {
  cacheKey: text("cache_key").primaryKey(),
  token: text("token").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Bronze: append-only raw Featured opportunities, keyed by `externalId`
 * (Featured's stable `featuredQuestionId`, stringified for provider-agnostic
 * future). Re-ingest is idempotent via ON CONFLICT (external_id) DO UPDATE.
 */
export const featuredOpportunities = pgTable(
  "featured_opportunities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    externalId: text("external_id").notNull(),
    // Nullable. Featured.com `/opportunities-list` never returns this field —
    // only `/premium-question-list` does. Bronze keeps it nullable so the
    // wider catalog ingests cleanly.
    featuredQuestionId: integer("featured_question_id"),
    opportunityText: text("opportunity_text").notNull(),
    mediaOutlet: text("media_outlet"),
    source: text("source"),
    pitchUrl: text("pitch_url"),
    deadline: timestamp("deadline", { withTimezone: true }),
    raw: jsonb("raw").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_featured_opportunities_external_id").on(table.externalId),
    index("idx_featured_opportunities_first_seen").on(table.firstSeenAt),
  ]
);

/**
 * Per-(org, brand) delivery ledger. Records which bronze opportunities have
 * already been served to a given brand so consecutive pulls return disjoint
 * sets and a polling consumer terminates (returns `[]` once exhausted).
 *
 * Identity is keyed on the SINGLE atomic `brandId` (not a brand tuple) — per
 * the global identity-keying rule: scoring is collective per tuple, but
 * dedup / served / cursor is atomic per single brand. `externalId` matches the
 * bronze `featured_opportunities.external_id` (the identity JQS already holds).
 *
 * This replaces the org-scoped timestamp cursor for per-brand delivery: the
 * batch ingest stamps every row of one insert with the same `first_seen_at`
 * (single `defaultNow()`), so a timestamp high-water-mark cannot page reliably.
 * An explicit ledger is the minimal robust primitive.
 */
export const featuredDeliveries = pgTable(
  "featured_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    externalId: text("external_id").notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_featured_deliveries_org_brand_external").on(
      table.orgId,
      table.brandId,
      table.externalId
    ),
    index("idx_featured_deliveries_org_brand").on(table.orgId, table.brandId),
  ]
);

/**
 * (org_id, brand_id) → Featured profileId. Mirrors JQS schema exactly.
 */
export const featuredProfiles = pgTable(
  "featured_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    featuredProfileId: integer("featured_profile_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_featured_profiles_org_brand").on(
      table.orgId,
      table.brandId
    ),
  ]
);

/**
 * Append-only ledger of submission attempts. Drives rolling-window rate-limit
 * accounting (count() over last interval), and gives ops-visible audit trail.
 */
export const featuredSubmissions = pgTable(
  "featured_submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cacheKey: text("cache_key").notNull(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    // Opportunity identity (= featured_opportunities.external_id, i.e. pitchUrl)
    // the submission was made for. Nullable: pre-feature rows have none, and
    // not every caller supplies it yet. Drives the authoritative per-(org,
    // brand, opportunity) submitted-status lookup that consumers read to
    // exclude already-pitched opportunities and re-offer failed ones.
    externalId: text("external_id"),
    featuredQuestionId: integer("featured_question_id").notNull(),
    featuredProfileId: integer("featured_profile_id").notNull(),
    status: text("status").notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_featured_submissions_cache_key_submitted").on(
      table.cacheKey,
      table.submittedAt
    ),
    index("idx_featured_submissions_org").on(table.orgId, table.submittedAt),
    index("idx_featured_submissions_org_brand_external").on(
      table.orgId,
      table.brandId,
      table.externalId
    ),
  ]
);

export type FeaturedJwtRow = typeof featuredJwt.$inferSelect;
export type FeaturedOpportunity = typeof featuredOpportunities.$inferSelect;
export type NewFeaturedOpportunity = typeof featuredOpportunities.$inferInsert;
export type FeaturedProfile = typeof featuredProfiles.$inferSelect;
export type NewFeaturedProfile = typeof featuredProfiles.$inferInsert;
export type FeaturedDelivery = typeof featuredDeliveries.$inferSelect;
export type NewFeaturedDelivery = typeof featuredDeliveries.$inferInsert;
export type FeaturedSubmission = typeof featuredSubmissions.$inferSelect;
export type NewFeaturedSubmission = typeof featuredSubmissions.$inferInsert;
