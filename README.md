# AI & Database Observability Dashboard

Self-hosted observability for the two things most teams run blind on: **what their
AI providers are actually costing and consuming**, and **whether their PostgreSQL
databases are healthy**.

One place to answer:

- Are we approaching an API limit?
- Which project is burning the most tokens?
- How much did each project spend, per provider, this month?
- Are database connections approaching `too many clients already`?
- Are queries getting slower?

> **Status: early development.** Phases 0-1 of 16 are complete — a runnable
> foundation and the core data model. Metric collection does not exist yet. See
> [docs/build-plan.md](docs/build-plan.md) for the full roadmap and
> [docs/product-spec.md](docs/product-spec.md) for the product intent.

## Why not just use the provider consoles?

Because they are per-provider and per-account. If three projects share one
OpenAI organization, the console cannot tell you which project spent what. This
dashboard makes the `project → provider → API key → usage` relationship
explicit, which is the only way to attribute cost and errors to the team that
caused them.

## Design principles

- **Your credentials stay yours.** API keys and database passwords are encrypted
  at rest, never returned to the browser, and never written to logs. The UI only
  ever shows a masked identifier such as `sk-••••A91F`.
- **Least privilege.** Monitored databases are read with a dedicated monitoring
  role, not a superuser.
- **Collectors, not live queries.** The frontend never queries your production
  database. Background collectors sample metrics and store normalized results.
- **Missing metrics are missing.** Providers expose wildly different data. Where
  a metric is unavailable it is recorded as unknown, never invented.
- **Separate databases.** The dashboard's own database is distinct from every
  database it monitors.

## Requirements

- **Node.js 20.9+** (developed against 22.x)
- **PostgreSQL 16+** for the dashboard's own storage

## Getting started

```bash
git clone https://github.com/MohammedNihal03/secretkeys.git
cd secretkeys
npm install
```

### 1. Create the dashboard database

**Option A — local PostgreSQL (default).** If you already have PostgreSQL
installed:

```bash
createdb ai_observability
```

**Option B — container (optional).** If you would rather not install
PostgreSQL, an optional Compose file is included:

```bash
docker compose up -d
```

Docker Engine and Compose v2 are Apache-2.0. Note that Docker *Desktop* — the
usual way to get them on Windows and macOS — is proprietary and requires a paid
subscription for larger organisations, which is why this is not the default
path. Option A has no such caveat.

### 2. Configure the environment

```bash
cp .env.example .env.local
```

Then edit `.env.local` and set `DATABASE_URL`. The app validates configuration
at startup and fails with the *names* of anything missing — never the values.

If your password contains characters that are reserved in a URI, percent-encode
them (`@` becomes `%40`, `:` becomes `%3A`, `#` becomes `%23`). Otherwise the
first `@` is read as the host delimiter and the connection fails. To encode a
value:

```bash
node -e "console.log(encodeURIComponent(process.argv[1]))" 'your@password'
```

### 3. Apply migrations

```bash
npm run db:migrate
```

This creates the schema and seeds the AI provider catalogue.

### 4. Run

```bash
npm run dev
```

| What | Where |
| --- | --- |
| Dashboard | http://localhost:3000 |
| Health endpoint | http://localhost:3000/api/health |

A healthy `/api/health` looks like this:

```json
{
  "status": "healthy",
  "version": "0.1.0",
  "uptimeSeconds": 12,
  "timestamp": "2026-09-10T15:00:00.000Z",
  "checks": {
    "database": { "status": "healthy", "latencyMs": 3 }
  }
}
```

It returns `503` when a dependency is down and `200` when merely degraded, so an
uptime check will not page you over a slow query.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start the development server |
| `npm run build` | Production build |
| `npm start` | Serve the production build |
| `npm run verify` | Types, lint, formatting and tests — run before a PR |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` / `lint:fix` | ESLint |
| `npm run format` / `format:check` | Prettier |
| `npm test` / `test:watch` | Unit tests (no external services) |
| `npm run test:integration` | Tests against a real PostgreSQL instance |
| `npm run db:generate` | Generate SQL migrations from the Drizzle schema |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:studio` | Browse the dashboard database |

## Architecture

```text
        ┌───────────────────────┐
        │     Next.js Web App   │   dashboard, charts, admin
        └───────────┬───────────┘
                    ▼
        ┌───────────────────────┐
        │   Observability API   │   auth, CRUD, metrics, alerts
        └───────────┬───────────┘
     ┌──────────────┼──────────────┐
     ▼              ▼              ▼
┌──────────┐  ┌──────────┐  ┌──────────┐
│ AI       │  │ Postgres │  │ Health   │
│ collectors│ │ collectors│ │ checks   │
└─────┬────┘  └─────┬────┘  └──────────┘
      └───────┬─────┘
              ▼
   ┌───────────────────────┐
   │ Observability Storage │   the dashboard's OWN database
   └───────────────────────┘
```

### Stack

| Concern | Choice |
| --- | --- |
| App & API | Next.js 16 (App Router), React 19, TypeScript |
| Database access | Drizzle ORM + `node-postgres` |
| Config | Zod-validated, server-only |
| Styling | Tailwind CSS v4 |
| Tests | Vitest |

### Data model

```text
Organization
 |-- Projects
 |     |-- API Keys              (project + provider + environment)
 |     '-- Monitored Databases
 '-- AI Providers                (global catalogue, not tenant data)
```

Every tenant-owned table carries an `organization_id`. Rows that reference a
project do so through a **composite** foreign key on
`(organization_id, project_id)`, pointing at a matching unique key on
`projects`. This means a credential cannot be attached to another
organization's project even via a buggy query or raw SQL — isolation is enforced
by Postgres, not by remembering a `WHERE` clause.

An API key records its project, provider and environment explicitly, and
separately stores the *provider-side* project id (e.g. OpenAI `proj_...`) where
one exists. That is what makes per-project cost attribution possible; the
project is never inferred from the key itself.

Secrets are stored only as ciphertext (`encrypted_key`,
`encrypted_credentials`) alongside a display-safe suffix (`key_last4`). The
`SafeApiKey` and `SafeMonitoredDatabase` types omit the secret-bearing fields so
the compiler, not vigilance, keeps them out of responses.

### Layout

```text
src/
  app/
    api/health/route.ts   health endpoint
    page.tsx              Phase 0 status page
  lib/
    env.ts                validated, server-only configuration
    health.ts             health vocabulary and probes
    db/
      client.ts           pool for the dashboard's own database
      errors.ts           SQLSTATE inspection (unwraps Drizzle's wrapper)
      schema/             Drizzle schema and relations
drizzle/                  generated SQL migrations + provider seed
docs/                     product spec and build plan
tests/                    unit tests
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Development follows the phase order in
[docs/build-plan.md](docs/build-plan.md) — please keep pull requests within a
phase rather than skipping ahead to UI that has no metrics behind it yet.

## Security

Never commit `.env.local` or any real credential. If you find a vulnerability,
please open a private security advisory on GitHub rather than a public issue.

## License

[MIT](LICENSE)
