-- Maintain `updated_at` in the database rather than in application code.
--
-- Previously `created_at` came from Postgres `now()` while `updated_at` was set
-- by the application clock via Drizzle's `$onUpdate`. Those are two different
-- clocks, so `updated_at` could land *before* `created_at` -- observed as a 1ms
-- inversion in tests, and unbounded once app and database clocks drift apart.
-- That makes ordering by `updated_at` unreliable, which matters for a system
-- whose whole purpose is putting events in order.
--
-- A trigger also covers writers that bypass the ORM: raw SQL, a later
-- migration, or a psql session.

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
    -- `now()` is the transaction timestamp, so every row touched by one
    -- statement gets an identical value.
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DO $$
DECLARE
    target text;
BEGIN
    FOREACH target IN ARRAY ARRAY[
        'organizations',
        'users',
        'sessions',
        'organization_members',
        'projects',
        'ai_providers',
        'api_keys',
        'monitored_databases'
    ]
    LOOP
        -- Dropped first so the migration is re-runnable.
        EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', target || '_set_updated_at', target);
        EXECUTE format(
            'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
            target || '_set_updated_at',
            target
        );
    END LOOP;
END;
$$;
