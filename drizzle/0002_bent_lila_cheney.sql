CREATE TABLE IF NOT EXISTS "featured_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"delivered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "featured_submissions" ADD COLUMN IF NOT EXISTS "external_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_featured_deliveries_org_brand_external" ON "featured_deliveries" USING btree ("org_id","brand_id","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_featured_deliveries_org_brand" ON "featured_deliveries" USING btree ("org_id","brand_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_featured_submissions_org_brand_external" ON "featured_submissions" USING btree ("org_id","brand_id","external_id");