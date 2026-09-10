-- Add the Phase 3 provider types and the provider-side key identifier.
--
-- `IF NOT EXISTS` on each ADD VALUE makes this re-runnable. Without it,
-- re-applying against a database that already has one of these values aborts
-- the whole migration, which is easy to hit when a migration run is
-- interrupted partway.
--
-- These values cannot be *used* until a later transaction, which is why the
-- catalogue rows are inserted by 0004 rather than here.

ALTER TYPE "public"."ai_provider_type" ADD VALUE IF NOT EXISTS 'groq';--> statement-breakpoint
ALTER TYPE "public"."ai_provider_type" ADD VALUE IF NOT EXISTS 'qwen';--> statement-breakpoint
ALTER TYPE "public"."ai_provider_type" ADD VALUE IF NOT EXISTS 'elevenlabs';--> statement-breakpoint
ALTER TYPE "public"."ai_provider_type" ADD VALUE IF NOT EXISTS 'deepgram';--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "provider_key_id" text;
