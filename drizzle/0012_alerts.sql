CREATE TYPE "public"."alert_severity" AS ENUM('warning', 'critical');--> statement-breakpoint
CREATE TYPE "public"."alert_status" AS ENUM('active', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."alert_resource_type" AS ENUM('api_key', 'monitored_database');--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"resource_type" "alert_resource_type" NOT NULL,
	"resource_id" uuid NOT NULL,
	"resource_name" text NOT NULL,
	"rule" text NOT NULL,
	"severity" "alert_severity" NOT NULL,
	"status" "alert_status" DEFAULT 'active' NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"triggered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"peak_severity" "alert_severity" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_active_condition_unique" ON "alerts" USING btree ("organization_id","resource_type","resource_id","rule") WHERE "alerts"."status" = 'active';--> statement-breakpoint
CREATE INDEX "alerts_org_status_idx" ON "alerts" USING btree ("organization_id","status","triggered_at");--> statement-breakpoint
CREATE INDEX "alerts_resource_idx" ON "alerts" USING btree ("resource_id","triggered_at");--> statement-breakpoint
-- Every table with `updated_at` needs the trigger from 0004; the list there is
-- explicit, so each new table registers itself.
DROP TRIGGER IF EXISTS alerts_set_updated_at ON alerts;--> statement-breakpoint
CREATE TRIGGER alerts_set_updated_at
    BEFORE UPDATE ON alerts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
