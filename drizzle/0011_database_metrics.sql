CREATE TABLE "database_collector_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"database_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	"status" text NOT NULL,
	"reachable" boolean NOT NULL,
	"response_time_ms" double precision,
	"metrics_stored" double precision DEFAULT 0 NOT NULL,
	"privileges" jsonb,
	"notes" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "database_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"database_id" uuid NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"metric" text NOT NULL,
	"value" double precision,
	"reason" text,
	"detail" text,
	"text_value" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "database_collector_runs" ADD CONSTRAINT "database_collector_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_collector_runs" ADD CONSTRAINT "database_collector_runs_database_id_monitored_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."monitored_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_metrics" ADD CONSTRAINT "database_metrics_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_metrics" ADD CONSTRAINT "database_metrics_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_metrics" ADD CONSTRAINT "database_metrics_database_id_monitored_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."monitored_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_metrics" ADD CONSTRAINT "database_metrics_org_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "database_collector_runs_db_started_idx" ON "database_collector_runs" USING btree ("database_id","started_at");--> statement-breakpoint
CREATE INDEX "database_collector_runs_org_started_idx" ON "database_collector_runs" USING btree ("organization_id","started_at");--> statement-breakpoint
CREATE INDEX "database_metrics_db_metric_time_idx" ON "database_metrics" USING btree ("database_id","metric","timestamp");--> statement-breakpoint
CREATE INDEX "database_metrics_org_time_idx" ON "database_metrics" USING btree ("organization_id","timestamp");--> statement-breakpoint
CREATE INDEX "database_metrics_time_idx" ON "database_metrics" USING btree ("timestamp");--> statement-breakpoint
-- Every table with `updated_at` needs the trigger from 0004; the list there is
-- explicit, so each new table registers itself.
DROP TRIGGER IF EXISTS database_metrics_set_updated_at ON database_metrics;--> statement-breakpoint
CREATE TRIGGER database_metrics_set_updated_at
    BEFORE UPDATE ON database_metrics
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
DROP TRIGGER IF EXISTS database_collector_runs_set_updated_at ON database_collector_runs;--> statement-breakpoint
CREATE TRIGGER database_collector_runs_set_updated_at
    BEFORE UPDATE ON database_collector_runs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
