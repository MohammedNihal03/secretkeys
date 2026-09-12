ALTER TABLE "monitored_databases" ADD COLUMN "last_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "monitored_databases" ADD COLUMN "last_check_status" "health_status";--> statement-breakpoint
ALTER TABLE "monitored_databases" ADD COLUMN "last_check_detail" text;