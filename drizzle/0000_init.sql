CREATE TABLE IF NOT EXISTS "featured_jwt" (
	"cache_key" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "featured_opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" text NOT NULL,
	"featured_question_id" integer NOT NULL,
	"opportunity_text" text NOT NULL,
	"media_outlet" text,
	"source" text,
	"pitch_url" text,
	"deadline" timestamp with time zone,
	"raw" jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "featured_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"featured_profile_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "featured_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cache_key" text NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"featured_question_id" integer NOT NULL,
	"featured_profile_id" integer NOT NULL,
	"status" text NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_featured_opportunities_external_id" ON "featured_opportunities" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_featured_opportunities_first_seen" ON "featured_opportunities" USING btree ("first_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_featured_profiles_org_brand" ON "featured_profiles" USING btree ("org_id","brand_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_featured_submissions_cache_key_submitted" ON "featured_submissions" USING btree ("cache_key","submitted_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_featured_submissions_org" ON "featured_submissions" USING btree ("org_id","submitted_at");