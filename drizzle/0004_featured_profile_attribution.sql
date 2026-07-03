CREATE TABLE IF NOT EXISTS "featured_profile_attribution" (
	"domain" text PRIMARY KEY NOT NULL,
	"featured_profile_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Seed the initial brand-domain -> Connectively profile map. Idempotent:
-- DO NOTHING preserves any later ops edit to a mapping on replay.
INSERT INTO "featured_profile_attribution" ("domain", "featured_profile_id") VALUES
	('distribute.you', 88890),
	('useago.com', 94058)
ON CONFLICT ("domain") DO NOTHING;
