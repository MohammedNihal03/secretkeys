# Testing

Two suites, run differently:

```bash
npm run verify             # typecheck, lint, format, unit tests -- no database needed
npm run test:integration   # needs a real PostgreSQL: npm run db:setup first
```

Integration tests run serially against the database in `DATABASE_URL`, and every
one creates and deletes its own organization. **Run them against a development
database, never production:** several deliberately cause failures for real — a
deadlock, a query cancelled by a statement timeout, a connection to a closed port.

Every destructive helper those tests call is scoped to the test's organization.
An unscoped retention call once deleted a developer's own metrics during a test
run, which is why the prune functions take an `organizationId` and the tests
always pass it.

## The build plan's checklist, and where each item is proven

### Authentication

| Requirement | Proven in |
|---|---|
| login/logout | `sign-in.integration.test.ts` — a real session starts; sign-out revokes it server-side, so a captured cookie stops working |
| unauthorized access | `api-authorization.test.ts` (401/404/403 from route handlers), `security-headers.test.ts` (redirect without a session), `static-security.test.ts` (every Server Action checks permission) |
| role permissions | `permissions.test.ts`, `api-authorization.test.ts` |
| organization isolation | `auth.integration.test.ts`, `credentials.integration.test.ts`, `alerts.integration.test.ts`, `usage-storage.integration.test.ts` |
| enumeration resistance | `sign-in.integration.test.ts` — wrong password, unknown email and disabled account give one identical answer |
| brute force | `throttle.test.ts`, `throttle.integration.test.ts`, `sign-in.integration.test.ts` |

### AI providers

| Requirement | Proven in |
|---|---|
| valid key | `credentials.integration.test.ts`, `providers.test.ts` |
| invalid key | `credentials.integration.test.ts` — a rejected key is never stored |
| disabled key | `collector.integration.test.ts` — disabled and revoked keys are not collected |
| provider unavailable | `collector.integration.test.ts`, `collector.test.ts` — unreachable leaves a key *unverified*, not rejected |
| rate limits | `providers.test.ts`, `collector.test.ts`, `evaluation.test.ts` |
| missing metrics | `providers.test.ts`, `usage.test.ts`, `evaluation.test.ts` — recorded with a reason, never as zero |
| multiple keys for one provider | `collector.test.ts` (collected in sequence), `usage-storage.integration.test.ts` (usage attributed to the key the provider named) |
| multiple projects on one provider | `usage-storage.integration.test.ts` — another project's spend lands on that project |

### PostgreSQL

| Requirement | Proven in |
|---|---|
| valid connection | `databases.integration.test.ts` — every collector statement runs against a real server |
| invalid connection | `databases.integration.test.ts` — a refused password is never stored |
| unavailable database | `databases-realworld.integration.test.ts` — a real closed port, reported as critical and named |
| high connections | `evaluation.test.ts` (the 70/85% rule), `connection-failures.test.ts` (`too many clients already` is named) |
| long-running query | `databases-realworld.integration.test.ts` — a real slow query is seen, and the collector does not count itself |
| deadlock | `databases-realworld.integration.test.ts` — a real deadlock is caused, counted across two samples, and judged a warning |
| missing optional metrics | `databases.test.ts` — no `pg_monitor`, no `pg_stat_statements`, host metrics PostgreSQL cannot report |

### Security

| Requirement | Proven in |
|---|---|
| secrets never returned to the frontend | `credentials.integration.test.ts`, `databases-realworld.integration.test.ts`, `static-security.test.ts` (ciphertext columns are referenced only by the schema and the two decryption services) |
| secrets never logged | `secrets-never-logged.integration.test.ts` — a canary key echoed back by a provider, quoted in a network error, and refused by a database never reaches any log, result or stored run; `static-security.test.ts` pins where logging exists at all |
| API authorization | `api-authorization.test.ts` — including the internet-facing collector trigger |
| encrypted credentials | `credential-crypto.test.ts`, `credentials.integration.test.ts`, `databases.integration.test.ts` |
| masked keys | `credentials.test.ts`, `credentials.integration.test.ts` |
| organization isolation | see Authentication |
| injection | `security-headers.test.ts` — script CSP with a per-request nonce; `static-security.test.ts` — no raw HTML rendering |
| information disclosure | `api-authorization.test.ts` — the public health report never repeats a database error |

### Reliability

| Requirement | Proven in |
|---|---|
| provider timeout | `providers.test.ts`, `http-network.test.ts` |
| database timeout | `databases-realworld.integration.test.ts` — a monitoring query is cancelled by the session's statement timeout |
| collector failure | `collector.test.ts`, `database-runner.test.ts` — a crash is contained to one target |
| retries | `collector.test.ts` — transient failures retried with jitter; a rejected key never retried |
| partial provider outage | `collector.test.ts`, `database-runner.test.ts` — one failing target never stops the others |
| duplicate collection prevention | `collector.integration.test.ts`, `databases-realworld.integration.test.ts` — advisory locks, and the AI and database locks do not block each other; `alerts.integration.test.ts` — a partial unique index bars duplicate alerts |

## Checked in a browser, not in a test

The Content Security Policy was verified against the production build: every
`<script>` tag on the sign-in page and on an authenticated page carries the
request's nonce, a plain page load reports no console errors, and client
components hydrate. A browser test runner could automate this later; it is
listed here so it is repeated after any change to `src/proxy.ts`.
