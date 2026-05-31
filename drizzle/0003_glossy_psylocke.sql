CREATE TABLE IF NOT EXISTS "featured_premium_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"featured_question_id" integer NOT NULL,
	"question_text" text NOT NULL,
	"media_outlet" text,
	"source" text,
	"pitch_url" text,
	"deadline" timestamp with time zone,
	"raw" jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_featured_premium_questions_fqid" ON "featured_premium_questions" USING btree ("featured_question_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_featured_premium_questions_first_seen" ON "featured_premium_questions" USING btree ("first_seen_at");