CREATE TYPE "public"."credential_validation_outcome" AS ENUM('valid', 'invalid', 'unverified');--> statement-breakpoint
ALTER TYPE "public"."ai_provider_type" ADD VALUE IF NOT EXISTS 'azure_openai';--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "base_url" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "last_validated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "last_validation_outcome" "credential_validation_outcome";--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "last_validation_detail" text;