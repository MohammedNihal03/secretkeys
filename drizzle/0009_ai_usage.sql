CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"api_key_id" uuid NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"requests" integer,
	"successful_requests" integer,
	"failed_requests" integer,
	"input_tokens" bigint,
	"output_tokens" bigint,
	"total_tokens" bigint,
	"characters" bigint,
	"audio_seconds" bigint,
	"estimated_cost" numeric(20, 8),
	"error_count" integer,
	"rate_limit_count" integer,
	"latency_ms" integer,
	"provider_key_id" text,
	"unavailable" jsonb,
	"provider_raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_usage_key_window_unique" UNIQUE("api_key_id","timestamp","window_end")
);
--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_provider_id_ai_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."ai_providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_org_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_org_time_idx" ON "ai_usage" USING btree ("organization_id","timestamp");--> statement-breakpoint
CREATE INDEX "ai_usage_org_project_time_idx" ON "ai_usage" USING btree ("organization_id","project_id","timestamp");--> statement-breakpoint
CREATE INDEX "ai_usage_org_provider_time_idx" ON "ai_usage" USING btree ("organization_id","provider_id","timestamp");--> statement-breakpoint
CREATE INDEX "ai_usage_key_time_idx" ON "ai_usage" USING btree ("api_key_id","timestamp");--> statement-breakpoint
-- Every table with `updated_at` needs the trigger from 0004; the list there is
-- explicit, so each new table registers itself.
DROP TRIGGER IF EXISTS ai_usage_set_updated_at ON ai_usage;--> statement-breakpoint
CREATE TRIGGER ai_usage_set_updated_at
    BEFORE UPDATE ON ai_usage
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
