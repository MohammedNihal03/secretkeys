CREATE TABLE "login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "login_attempts_key_time_idx" ON "login_attempts" USING btree ("key_hash","created_at");--> statement-breakpoint
CREATE INDEX "login_attempts_time_idx" ON "login_attempts" USING btree ("created_at");--> statement-breakpoint
-- Every table with `updated_at` needs the trigger from 0004; the list there is
-- explicit, so each new table registers itself.
DROP TRIGGER IF EXISTS login_attempts_set_updated_at ON login_attempts;--> statement-breakpoint
CREATE TRIGGER login_attempts_set_updated_at
    BEFORE UPDATE ON login_attempts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
