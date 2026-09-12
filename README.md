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

> **Status: early development.** Phases 0-6 of 16 are complete — foundation,
> data model, authentication, project + provider management with eleven
> provider adapters, encrypted API key registration, a scheduled metrics
> collector, and the AI usage time series it writes to. The dashboards arrive
> in Phase 10.
> See
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

Generate an encryption key for stored API keys and set it as
`CREDENTIAL_ENCRYPTION_KEY`:

```bash
npm run generate:key
```

**Back this key up separately from the database.** Stored API keys are encrypted
with it; if it is lost they cannot be recovered, only registered again. Use a
different key for each environment.

If your password contains characters that are reserved in a URI, percent-encode
them (`@` becomes `%40`, `:` becomes `%3A`, `#` becomes `%23`). Otherwise the
first `@` is read as the host delimiter and the connection fails. To encode a
value:

```bash
node -e "console.log(encodeURIComponent(process.argv[1]))" 'your@password'
```

### 3. Apply migrations and seed

```bash
npm run db:setup
```

This applies migrations and reconciles the provider catalogue. The catalogue is
derived from the adapter registry in code rather than a SQL seed, so the
database can never list a provider that has no adapter.

### 4. Create the first administrator

```bash
ORG_NAME="Acme" ADMIN_EMAIL="you@acme.com" ADMIN_NAME="Your Name" npm run bootstrap
```

Omit `ADMIN_PASSWORD` and a strong one is generated and printed once. This is a
CLI step rather than a web page on purpose: an unauthenticated setup endpoint is
a permanent liability if it stays reachable after setup.

### 5. Run

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
| `npm run db:seed` | Reconcile the provider catalogue with the adapter registry |
| `npm run db:setup` | `db:migrate` then `db:seed` |
| `npm run db:studio` | Browse the dashboard database |
| `npm run bootstrap` | Create the first organization and administrator |
| `npm run generate:key` | Generate a `CREDENTIAL_ENCRYPTION_KEY` |
| `npm run collect` | Run one metrics collection |

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
| Auth | Server-side sessions, scrypt passwords (no native deps) |
| Config | Zod-validated, server-only |
| Styling | Tailwind CSS v4, light/dark with no flash |
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

### Providers, and what they actually expose

Eleven adapters ship, behind one `AIProviderAdapter` interface. **They differ
enormously in what they let you read**, so a missing metric is recorded as
unavailable with a reason — never as zero, which would read as "healthy and
idle" when the truth is "we cannot see it".

| Provider | Usage | Cost | Limits | Meters |
| --- | --- | --- | --- | --- |
| OpenAI | Admin key | Admin key | Headers only | requests, tokens |
| Anthropic | Admin key | Admin key | Headers only | requests, tokens |
| Google Gemini | — | — | — | requests, tokens |
| Groq | — | — | Headers only | requests, tokens |
| Qwen | — | — | — | requests, tokens |
| ElevenLabs | — | — | **Endpoint** | characters |
| Deepgram | **Per key** | — | — | requests, audio, tokens, characters |
| OpenRouter | — | **Per key** (spend) | **Endpoint** (USD limit) | requests, tokens |
| DeepSeek | — | — | **Endpoint** (balance) | requests, tokens |
| Mistral | — | — | — | requests, tokens |
| Azure OpenAI | — | — | — | requests, tokens |

- **Admin key** — OpenAI and Anthropic expose usage and cost *only* on
  organization endpoints requiring a separate admin credential
  (`sk-admin-…` / `sk-ant-admin…`). They report the whole organization's usage
  grouped by *their* key id, which is why `api_keys.provider_key_id` exists:
  it's the join back to one of your projects. Per-project attribution therefore
  works inside-out — one admin call per provider, then map each returned key id.
- **Headers only** — rate limits appear solely on responses to real API calls,
  so they cannot be polled on their own.
- **Deepgram** has the most complete usage API of the seven: real windowed
  requests, audio hours, tokens and TTS characters, groupable by API key with no
  admin credential.
- **ElevenLabs** is the only one exposing a true quota (characters used, limit
  and reset time), which is what makes "this key is approaching its limit"
  answerable directly.
- **OpenRouter** reports each key's USD credit limit, how much remains, and
  running daily/weekly/monthly spend — straight from the project key.
- **DeepSeek** is prepaid: it reports a balance per currency and whether it still
  covers API calls, so an exhausted account shows as unhealthy before calls fail.
- **Cost is never derived from a local price list.** Only the two providers that
  report cost themselves have a cost figure; guessing from tokens would produce
  a confident number that silently drifts whenever a provider changes prices.

**Azure OpenAI** keys are registered together with their resource endpoint, which
is checked against an allow-list of Azure hosts before any request is made.

Not yet added: **AWS Bedrock**, which needs SigV4 request signing and a region
rather than a single API key.

### Choosing which providers an organization tracks

Not every organization uses every provider. Each organization picks its own set
on the **Providers** page — a company using only OpenAI and ElevenLabs switches
those two on and the rest off; a company that wants everything chooses
**Track all**. The choice is per organization and never affects another tenant.

- **Nothing chosen yet means everything is tracked.** When a new adapter ships
  it appears for existing organizations instead of being silently withheld — in
  a monitoring tool, a silent omission is worse than one extra service you can
  switch off in one click.
- **Track all / Clear all** record an explicit choice for every provider, so
  "everything on, deliberately" stays distinguishable from "nobody has decided".
- Only an **organization admin** can change the selection. Developers see it
  read-only, and the server re-checks permission on every change.

#### When there is nothing useful to show

"No data" can mean three different things, and the UI says which:

| Situation | What the dashboard shows |
| --- | --- |
| Nothing configured yet | What is missing, and the one next step |
| The provider has no usage, cost or quota API | That only reachability can be monitored, and where to find the rest (e.g. Google AI Studio for Gemini) |
| Something is wrong | A warning, kept visually distinct from the two above |

These all use one `Notice` component (`src/components/notice.tsx`), so a new
page gets the same honest empty states rather than a blank area or a zero.

### Collecting metrics

A collection reads every tracked credential once. For each one it checks the
credential, records the provider's status and latency, reads whatever limits or
quota that provider exposes, and asks for usage over the last two days.

**The scheduler is external**, on purpose. Run it from cron, a systemd timer or
Windows Task Scheduler:

```bash
npm run collect
npm run collect -- --org=<uuid> --concurrency=2 --window-days=3
npm run collect -- --dry-run   # contact every provider, store nothing
```

```cron
*/15 * * * * cd /srv/observability && npm run collect >> /var/log/collect.log 2>&1
```

An interval inside the web process would collect twice when two instances run,
and not at all while none is awake. For hosted schedulers that can only make an
HTTP request, set `COLLECTOR_TRIGGER_SECRET` and call `POST /api/collect` with
`Authorization: Bearer <secret>`; with no secret set that endpoint is disabled
rather than left open.

How it behaves, and why:

- **One collection at a time**, enforced by a Postgres advisory lock. Overlapping
  runs would call every provider twice and double whatever gets stored.
- **One provider at a time**, with different providers collected in parallel. The
  collector must not trigger the rate limits it is there to measure.
- **Transient failures are retried** with jittered backoff. A rejected credential
  is not: retrying a 401 just produces three of them, and some providers rate
  limit repeated failed authentication.
- **One provider failing changes nothing for the others**, and a defect in a
  single adapter is contained to that credential rather than ending the run.
- **A key its provider rejects is marked rejected**, so it stops showing as
  validated. A provider being unreachable leaves it *unverified* instead — an
  outage is not evidence against a key.
- **A provider that exposes little is still a success.** Gemini reports no usage
  at all; recording that as a failure would make a working key look broken.
- Every attempt is recorded in `collector_runs`, which is where "last successful
  collection" and "last error" are read from.

### Where usage is stored

Normalized usage lands in `ai_usage`, one row per provider-reported interval per
credential, carrying organization, project, provider and key — so
`Organization → Project → Provider → API Key → Time → Usage` is answerable by a
filtered aggregate rather than four joins.

Three rules shape that table, each guarding against a way a usage series goes
quietly wrong:

- **Nothing is invented.** Every metric column is nullable, and null means the
  provider did not report it — never zero. The reason is kept alongside the row,
  so a chart can say "Groq exposes no usage" instead of drawing a flat line at
  zero. An interval in which nothing at all was reported is not stored: a
  collection that found nothing must not look like usage of nothing.
- **A window is corrected, not duplicated.** Providers finalise usage late, so
  every run re-reads an overlapping two-day window and writes upsert-style
  against `(api_key_id, timestamp, window_end)`. Collecting twice cannot double a
  total, and a provider revising a day downward can revise it down.
- **Usage is never billed to the wrong project.** Organization-wide usage
  endpoints return every key's consumption grouped by the provider's own key
  identifier. A row matching a registered key goes to that key's project; a row
  naming a key this dashboard does not know is reported in the run summary and
  dropped, rather than parked on whichever credential happened to fetch it.

Each run records both how many intervals a provider returned and how many were
stored, so the two can disagree visibly. Aggregation, bucketing (in an explicit
time zone, not the database server's) and retention live in
`src/lib/usage/repository.ts`.

### API keys and how they are stored

Registering a key follows a fixed flow: confirm the organization tracks the
provider, check the key with the provider, encrypt it, then store it with its
project and environment. The full secret never leaves the server again — pages
only ever receive its last four characters.

- **AES-256-GCM, bound to the organization.** The organization id is
  authenticated alongside the ciphertext, so a ciphertext copied into another
  tenant's row fails to decrypt instead of lending them a credential.
- **Rotatable.** Each ciphertext records which key encrypted it. Set the old key
  as `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS` during a rotation and existing keys keep
  working.
- **Duplicates are caught without storing anything reversible.** A keyed,
  per-organization HMAC fingerprint detects the same key registered twice —
  which would otherwise credit its usage to two projects.
- **A provider outage does not block registration.** A key the provider rejects
  (401) is refused. One that cannot be checked — provider down, rate limiting, or
  a restricted key denied the check (403) — is saved as *Not verified* and can be
  checked again later.
- **Provider messages are redacted** of the key before they are shown or stored,
  even when a provider echoes the key back.
- **Revocation is permanent.** A revoked key is kept so its usage history stays
  attributed, but it can never be enabled again.
- **Azure endpoints are allow-listed.** The server makes authenticated requests
  to the endpoint you supply, so only Azure OpenAI hosts are accepted — otherwise
  the key form could be used to make the server call into its own network.

Until Phase 9 collects real health, a key's state is the result of its last
check — *Validated*, *Not verified* or *Rejected* — rather than implying
monitoring that does not exist yet.

### Authentication and access control

Three separate things, deliberately not conflated:

- a **session** proves who you are
- a **membership row** grants access to one organization's data
- a **role** decides what you may do inside it

Holding a valid session conveys no authority over any organization. Roles are
per-membership, so the same person can administer one organization and only read
another.

| Capability | Organization admin | Developer |
| --- | :---: | :---: |
| View metrics, health, alerts | ✅ | ✅ |
| Manage projects | ✅ | — |
| Manage providers | ✅ | — |
| Manage API keys | ✅ | — |
| Manage databases | ✅ | — |

Security choices worth knowing about:

- **Sessions are server-side, not JWTs.** Only a SHA-256 hash of the token is
  stored, so a dump of the `sessions` table cannot be replayed. Sign-out and
  disabling a user take effect on the *next request*, not at token expiry.
- **Passwords use scrypt** from `node:crypto` at the OWASP-recommended cost, so
  there is no native build dependency to fail on install. Parameters are stored
  inside each digest and can be raised without invalidating existing passwords.
- **Sign-in does not leak which emails exist.** An unknown address, a wrong
  password and a disabled account return the same message, and all three perform
  one scrypt derivation so they take the same time.
- **A non-member gets 404, not 403.** A 403 would confirm the organization
  exists, letting any account probe for other tenants by id.
- **`proxy.ts` is not the security boundary.** It only checks a cookie is
  present, to avoid rendering a page that would just redirect. Real validation
  happens in the data layer, in `src/lib/auth/guards.ts`.

### Theming

Light and dark, chosen by a cookie that is read on the server, so the correct
theme is in the first HTML response and there is no flash of the wrong one. With
no cookie set, `prefers-color-scheme` decides — the toggle does not override the
system default until someone actually uses it.

Brand marks for the monitored providers are inlined as SVG, with sources and
licences recorded in [docs/ICON-CREDITS.md](docs/ICON-CREDITS.md). Nothing is
loaded from a third-party CDN at runtime.

### Layout

```text
src/
  app/
    api/health/route.ts   health endpoint
    page.tsx              Phase 0 status page
  proxy.ts                optimistic route protection (not the boundary)
  components/             ambient background, brand marks, theme toggle, notices
  lib/
    env.ts                validated, server-only configuration
    health.ts             health vocabulary and probes
    auth/
      password.ts         scrypt hashing, constant-time verification
      session.ts          server-side sessions (hashed tokens)
      access.ts           membership and role resolution
      guards.ts           page guards -- the real security boundary
      permissions.ts      the role/permission matrix
    api/
      authorize.ts        route-handler authorization (401/403/404)
    collector/
      runner.ts           a collection run: lock, pooling, isolation
      collect-target.ts   one credential: probe, limits, usage
      interpret.ts        health and outcome rules (pure)
      targets.ts          which credentials to collect from
    usage/
      sink.ts             the collector's storage seam, filled
      normalize.ts        provider metrics -> a storable row (pure)
      attribution.ts      which credential a usage row belongs to (pure)
      repository.ts       upserts, aggregation, retention
    credentials/
      crypto.ts           AES-256-GCM, key rotation, fingerprints
      service.ts          register, check, revoke -- the only decryption path
      repository.ts       display-safe reads (never selects ciphertext)
    projects/
      repository.ts       organization-scoped project queries
      schema.ts           input validation
      actions.ts          Server Actions, permission-checked
    providers/
      types.ts            AIProviderAdapter + explicit unavailable metrics
      http.ts             timeouts, secret scrubbing, rate-limit headers
      registry.ts         the adapters, and the catalogue derived from them
      selection.ts        per-organization provider selection
      openai.ts anthropic.ts gemini.ts groq.ts qwen.ts
      elevenlabs.ts deepgram.ts openrouter.ts deepseek.ts mistral.ts azure-openai.ts
    db/
      client.ts           pool for the dashboard's own database
      errors.ts           SQLSTATE inspection (unwraps Drizzle's wrapper)
      schema/             Drizzle schema and relations
drizzle/                  generated SQL migrations + provider seed
scripts/
  migrate.ts              applies migrations (reports real Postgres errors)
  seed-providers.ts       reconciles the catalogue with the adapter registry
  bootstrap.ts            creates the first organization and administrator
  collect.ts              runs one collection (point cron at this)
docs/                     product spec, build plan, icon credits
tests/                    unit tests (*.test.ts) + integration (*.integration.test.ts)
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
