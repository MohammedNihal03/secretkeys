CREATE TYPE "public"."ai_provider_type" AS ENUM('openai', 'google_gemini', 'anthropic');--> statement-breakpoint
CREATE TYPE "public"."api_key_status" AS ENUM('active', 'disabled', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."database_type" AS ENUM('postgresql');--> statement-breakpoint
CREATE TYPE "public"."environment" AS ENUM('production', 'staging', 'development');--> statement-breakpoint
CREATE TYPE "public"."resource_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"environment" "environment" DEFAULT 'production' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_org_name_unique" UNIQUE("organization_id","name"),
	CONSTRAINT "projects_org_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "ai_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" "ai_provider_type" NOT NULL,
	"status" "resource_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_providers_type_unique" UNIQUE("type")
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"key_name" text NOT NULL,
	"encrypted_key" text NOT NULL,
	"key_last4" text NOT NULL,
	"key_fingerprint" text,
	"provider_project_id" text,
	"environment" "environment" NOT NULL,
	"status" "api_key_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_org_key_name_unique" UNIQUE("organization_id","key_name"),
	CONSTRAINT "api_keys_org_fingerprint_unique" UNIQUE("organization_id","key_fingerprint")
);
--> statement-breakpoint
CREATE TABLE "monitored_databases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"database_type" "database_type" DEFAULT 'postgresql' NOT NULL,
	"host" text NOT NULL,
	"port" integer DEFAULT 5432 NOT NULL,
	"database_name" text NOT NULL,
	"username" text NOT NULL,
	"encrypted_credentials" text NOT NULL,
	"ssl_enabled" boolean DEFAULT true NOT NULL,
	"environment" "environment" NOT NULL,
	"status" "resource_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monitored_databases_org_name_unique" UNIQUE("organization_id","name"),
	CONSTRAINT "monitored_databases_org_target_unique" UNIQUE("organization_id","host","port","database_name")
);
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_provider_id_ai_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."ai_providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitored_databases" ADD CONSTRAINT "monitored_databases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitored_databases" ADD CONSTRAINT "monitored_databases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitored_databases" ADD CONSTRAINT "monitored_databases_org_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "projects_org_idx" ON "projects" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "api_keys_org_idx" ON "api_keys" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "api_keys_project_idx" ON "api_keys" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "api_keys_provider_idx" ON "api_keys" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "api_keys_status_idx" ON "api_keys" USING btree ("status");--> statement-breakpoint
CREATE INDEX "monitored_databases_org_idx" ON "monitored_databases" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "monitored_databases_project_idx" ON "monitored_databases" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "monitored_databases_status_idx" ON "monitored_databases" USING btree ("status");