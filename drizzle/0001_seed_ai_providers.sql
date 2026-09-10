-- Seed the global AI provider catalogue.
--
-- These rows are reference data, not tenant data: `api_keys.provider_id` cannot
-- resolve until they exist, so they are seeded by migration rather than by an
-- application bootstrap step.
--
-- Idempotent, so re-running against an existing database is safe. `type` is
-- unique, which is what ON CONFLICT keys on.

INSERT INTO "ai_providers" ("name", "type") VALUES
    ('OpenAI', 'openai'),
    ('Google Gemini', 'google_gemini'),
    ('Anthropic', 'anthropic')
ON CONFLICT ("type") DO NOTHING;
