CREATE TABLE "organization_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_providers_org_provider_unique" UNIQUE("organization_id","provider_id")
);
--> statement-breakpoint
ALTER TABLE "organization_providers" ADD CONSTRAINT "organization_providers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_providers" ADD CONSTRAINT "organization_providers_provider_id_ai_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."ai_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organization_providers_org_idx" ON "organization_providers" USING btree ("organization_id");--> statement-breakpoint
-- Every table with an `updated_at` needs the trigger from 0004; the list there
-- is explicit, so a new table must register itself here.
DROP TRIGGER IF EXISTS organization_providers_set_updated_at ON organization_providers;--> statement-breakpoint
CREATE TRIGGER organization_providers_set_updated_at
    BEFORE UPDATE ON organization_providers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
