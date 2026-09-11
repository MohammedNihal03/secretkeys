CREATE TYPE "public"."collector_outcome" AS ENUM('success', 'partial', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."health_status" AS ENUM('healthy', 'degraded', 'unhealthy', 'unknown');--> statement-breakpoint
CREATE TABLE "collector_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"api_key_id" uuid,
	"provider_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"outcome" "collector_outcome" NOT NULL,
	"provider_status" "health_status" NOT NULL,
	"latency_ms" integer,
	"rate_limited" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"usage_window_start" timestamp with time zone,
	"usage_window_end" timestamp with time zone,
	"usage_entry_count" integer DEFAULT 0 NOT NULL,
	"usage_persisted_count" integer DEFAULT 0 NOT NULL,
	"unavailable" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "collector_runs" ADD CONSTRAINT "collector_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_runs" ADD CONSTRAINT "collector_runs_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_runs" ADD CONSTRAINT "collector_runs_provider_id_ai_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."ai_providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collector_runs_org_started_idx" ON "collector_runs" USING btree ("organization_id","started_at");--> statement-breakpoint
CREATE INDEX "collector_runs_key_started_idx" ON "collector_runs" USING btree ("api_key_id","started_at");--> statement-breakpoint
CREATE INDEX "collector_runs_outcome_idx" ON "collector_runs" USING btree ("outcome");--> statement-breakpoint
-- Every table with `updated_at` needs the trigger from 0004; the list there is
-- explicit, so each new table registers itself.
DROP TRIGGER IF EXISTS collector_runs_set_updated_at ON collector_runs;--> statement-breakpoint
CREATE TRIGGER collector_runs_set_updated_at
    BEFORE UPDATE ON collector_runs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
