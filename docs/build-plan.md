# AI & Database Observability Dashboard — Build Plan

## Purpose

This is the implementation plan for the AI & Database Observability Dashboard.

Build it **phase by phase**, validating every phase before moving to the next.

### MVP scope

- AI provider/API key usage, limits, health, errors, latency and cost
- PostgreSQL/SQL health, connections, queries, storage and performance
- Project → provider → API key → usage mapping
- Organization overview
- Basic health indicators and in-dashboard alerts

Do not implement the future expansion features during the MVP.

---

# 1. Development Principles

- Build incrementally. Do not build the entire application in one pass.
- Do not use hardcoded production monitoring metrics.
- Mock data is allowed only for isolated early UI development and must be replaced by real metrics.
- Keep AI providers modular through a common adapter/interface.
- Keep the dashboard's own database separate from databases being monitored.
- Never expose, log, or commit raw API keys or database credentials.
- Every phase must include implementation, validation, tests/type checks/linting where applicable, and documentation updates.

---

# 2. Recommended Architecture

```text
                         ┌───────────────────────┐
                         │     Next.js Web App   │
                         │ Dashboard / Charts    │
                         │ Projects / Providers  │
                         │ API Keys / Databases  │
                         └───────────┬───────────┘
                                     │
                                     ▼
                         ┌───────────────────────┐
                         │   Observability API   │
                         │ Auth / CRUD            │
                         │ Metrics / Health       │
                         │ Alert evaluation       │
                         └───────────┬───────────┘
                                     │
                  ┌──────────────────┼──────────────────┐
                  ▼                  ▼                  ▼
        ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
        │ AI Collectors   │ │ DB Collectors   │ │ Health Checks   │
        │ OpenAI/Gemini/  │ │ PostgreSQL      │ │ Availability    │
        │ Anthropic       │ │ SQL metrics     │ │ Connectivity    │
        └────────┬────────┘ └────────┬────────┘ └─────────────────┘
                 │                   │
                 └──────────┬────────┘
                            ▼
                  ┌───────────────────────┐
                  │ Observability Storage │
                  │ Projects / Providers  │
                  │ API Keys / Databases  │
                  │ Metrics / Alerts      │
                  └───────────────────────┘
```

Use background collection jobs rather than making the frontend continuously query providers or production databases.

---

# 3. Phase 0 — Project Setup

## Objective

Create a clean, runnable application foundation.

## Tasks

- Inspect the repository before changing anything.
- Identify framework, package manager, existing database and auth.
- Initialize/clean the application structure only where necessary.
- Configure frontend and backend/API.
- Configure application database.
- Configure environment variables.
- Configure TypeScript, linting, formatting and testing.
- Add development scripts.
- Add basic README documentation.
- Add a simple health endpoint.

Expected result:

```text
Frontend
http://localhost:3000

API
/api/health
```

Validation:

- frontend starts
- backend responds
- database connection works
- TypeScript passes
- lint passes
- tests run

---

# 4. Phase 1 — Core Data Model

Create the foundation for:

```text
Organization
 ├── Projects
 ├── AI Providers
 │    └── API Keys
 └── Monitored Databases
```

Required entities:

### Organization

```text
id
name
created_at
updated_at
```

### Project

```text
id
organization_id
name
description
environment
created_at
updated_at
```

### AI Provider

```text
id
name
type
status
created_at
updated_at
```

### API Key

```text
id
organization_id
project_id
provider_id
key_name
encrypted_key
key_last4
environment
status
created_at
updated_at
```

### Monitored Database

```text
id
organization_id
project_id
name
database_type
host/reference
encrypted_credentials
status
created_at
updated_at
```

The schema must explicitly answer:

```text
Which project uses this key?
Which provider owns this key?
Which environment uses it?
Which usage records belong to it?
```

Add proper foreign keys, indexes, unique constraints and organization isolation.

---

# 5. Phase 2 — Authentication & Organization Access

Implement:

- authentication
- organization membership
- protected routes
- API authorization
- organization-level data isolation
- role-based access

Initial roles:

```text
Organization Admin
Developer
```

Admin:

- manage providers
- manage API keys
- manage projects
- manage databases
- view metrics
- view alerts

Developer:

- view metrics
- view health
- view alerts

Test that Organization A cannot access Organization B's resources.

---

# 6. Phase 3 — Projects & Providers

Build project and provider management.

## Projects

- create
- edit
- list
- details
- environment
- status

## Providers

Initial adapters:

- OpenAI
- Google Gemini
- Anthropic

Use a common provider interface, conceptually:

```text
AIProviderAdapter

├── validateCredentials()
├── fetchUsage()
├── fetchLimits()
├── fetchHealth()
└── normalizeMetrics()
```

Do not assume every provider exposes every metric. Represent unavailable metrics explicitly.

---

# 7. Phase 4 — Secure API Key Management

Allow administrators to register a key and explicitly associate it with a project.

Example:

```text
Provider:    OpenAI
Project:     FYIND
Environment: Production
Key Name:    FYIND Production
API Key:     ********
```

Flow:

1. Validate provider.
2. Validate credential where supported.
3. Encrypt credential.
4. Store required metadata.
5. Store last characters for identification.
6. Never return the complete secret to the frontend.

Display:

```text
FYIND       OpenAI       ••••A91F       Production     🟢
Lunad       OpenAI       ••••72BC       Production     🟢
Skrumi      OpenAI       ••••19DE       Development    🟡
```

Never infer the project from the key itself.

---

# 8. Phase 5 — AI Metrics Collector

Build the background collector framework.

```text
Scheduler
   ↓
Collector
   ├── OpenAI Adapter
   ├── Gemini Adapter
   └── Anthropic Adapter
   ↓
Normalized Metrics
   ↓
Metrics Storage
```

Collect where supported:

- requests
- successful/failed requests
- input/output/total tokens
- cost
- quotas
- rate limits
- provider status
- errors
- latency
- last successful request
- last error

Provider APIs differ, so normalize common metrics while preserving provider-specific information.

---

# 9. Phase 6 — AI Usage Storage

Store normalized usage with:

```text
timestamp
organization_id
project_id
provider_id
api_key_id
requests
successful_requests
failed_requests
input_tokens
output_tokens
total_tokens
estimated_cost
error_count
rate_limit_count
latency
```

Support the hierarchy:

```text
Organization
 ↓
Project
 ↓
Provider
 ↓
API Key
 ↓
Time
 ↓
Usage
```

Design storage for historical growth and aggregation. Do not create data simply because the UI refreshes.

---

# 10. Phase 7 — PostgreSQL Monitoring Collector

Monitor external PostgreSQL databases separately from the dashboard's own database.

Collect where available:

### Health

- availability
- connection status
- response time

### Resources

- CPU
- memory
- disk
- database size
- storage growth

### Connections

- current
- maximum
- active
- idle
- utilization

### Queries

- active
- slow
- long-running
- duration
- failed transactions
- locks
- deadlocks

### PostgreSQL

- transaction rate
- cache hit ratio

Use a monitoring user with minimum required permissions. Avoid a PostgreSQL superuser unless absolutely necessary.

---

# 11. Phase 8 — Database Metrics Storage

Store:

```text
Organization
 ↓
Project
 ↓
Monitored Database
 ↓
Metric
 ↓
Timestamp
```

Handle unavailable metrics explicitly instead of inventing values.

---

# 12. Phase 9 — Health Evaluation Engine

Convert metrics into:

```text
🟢 Healthy
🟡 Warning
🔴 Critical
⚫ Unknown
```

Centralize thresholds instead of hardcoding them across UI components.

Example:

```text
Connections < 70%       Healthy
70–85%                   Warning
> 85%                    Critical
```

Also evaluate:

- high AI error rate
- high latency
- provider rate limits
- database unavailable
- high disk
- high CPU/memory
- long-running query
- deadlock

Thresholds should be configurable later.

---

# 13. Phase 10 — Main Organization Dashboard

Build the primary dashboard from **real collected metrics**.

It should answer:

> Is everything healthy?

Include:

- organization health
- AI service health
- database health
- API requests
- token usage
- estimated cost
- database connections
- recent errors
- active warnings
- provider health
- database health
- usage trends

---

# 14. Phase 11 — AI Analytics

Build detailed:

### Provider page

- health
- requests
- tokens
- cost
- errors
- latency
- rate limits
- keys

### API key page

- project
- provider
- environment
- masked key
- health
- requests
- tokens
- cost
- errors
- latency
- usage percentage

### Project page

Group usage by:

- provider
- API key
- requests
- tokens
- cost
- errors

This must answer:

> Which project is consuming the most AI resources?

---

# 15. Phase 12 — Database Analytics

Build:

### Database overview

- status
- CPU
- memory
- disk
- database size
- connections
- transactions
- cache hit ratio

### Connections

- current
- maximum
- active
- idle
- utilization

### Queries

- active
- slow
- long-running
- execution time
- locks
- deadlocks

Make failures such as:

```text
FATAL: sorry, too many clients already
```

easy to identify.

---

# 16. Phase 13 — Basic Alerts

Implement in-dashboard alerts.

AI:

- key approaching limit
- rate limit
- high error rate
- high latency

Database:

- high connection utilization
- high CPU
- high memory
- high disk
- unavailable
- long-running query
- deadlock

Alert model:

```text
id
organization_id
project_id
resource_type
resource_id
severity
title
description
status
triggered_at
resolved_at
```

Lifecycle:

```text
Healthy → Warning → Critical → Resolved
```

Avoid duplicate alerts for the same ongoing condition.

---

# 17. Phase 14 — Historical Metrics & Charts

Support:

- Today
- Last 7 days
- Last 30 days
- Custom range

Charts:

```text
AI Requests
Token Usage
AI Cost
AI Errors
API Latency

Database Connections
CPU
Memory
Disk
Query Duration
```

Charts must use stored real metrics.

---

# 18. Phase 15 — Testing & Hardening

Test:

### Authentication

- login/logout
- unauthorized access
- role permissions
- organization isolation

### AI

- valid key
- invalid key
- disabled key
- provider unavailable
- rate limits
- missing metrics
- multiple keys for same provider
- multiple projects using same provider

### PostgreSQL

- valid connection
- invalid connection
- unavailable database
- high connections
- long-running query
- deadlock
- missing optional metrics

### Security

- secrets never returned to frontend
- secrets never logged
- API authorization
- encrypted credentials
- masked keys
- organization isolation

### Reliability

- provider timeout
- database timeout
- collector failure
- retries
- partial provider outage
- duplicate collection prevention

---

# 19. Phase 16 — Production Readiness

Prepare for organizational use:

- production environment
- secure secret management
- migrations
- backups
- logging
- error tracking
- health checks
- collector retry strategy
- graceful failures
- API rate limiting
- secure deployment

The observability system itself must be observable.

---

# 20. MVP Completion Criteria

An organization administrator must be able to:

1. Create a project.
2. Add an AI provider.
3. Register multiple keys from the same provider.
4. Associate each key with a project/environment.
5. Securely store credentials.
6. Collect real AI usage metrics.
7. View usage by provider.
8. View usage by project.
9. View usage by API key.
10. Register PostgreSQL.
11. Monitor database health.
12. Monitor connections.
13. Monitor query health.
14. See warning/critical states.
15. View historical metrics.
16. View basic in-dashboard alerts.

The MVP must work with real infrastructure, not hardcoded production metrics.

---

# 21. Future Expansion — Do Not Build Yet

After the MVP is stable:

- Slack/email alerts
- Automatic anomaly detection
- Cost forecasting
- Which agent is consuming the most tokens?
- Which API key is close to its limit?
- Why did database connections spike?
- AI-generated incident explanations
- Historical incident timeline
- Per-project budgets
- Per-agent budgets

The architecture must allow these later without a rewrite.

---

# 22. Exact Execution Order

```text
Phase 0  → Project Setup
Phase 1  → Core Data Model
Phase 2  → Authentication & Organizations
Phase 3  → Projects & Providers
Phase 4  → Secure API Key Management
Phase 5  → AI Metrics Collector
Phase 6  → AI Usage Storage
Phase 7  → PostgreSQL Collector
Phase 8  → Database Metrics Storage
Phase 9  → Health Evaluation
Phase 10 → Main Dashboard
Phase 11 → AI Analytics
Phase 12 → Database Analytics
Phase 13 → Basic Alerts
Phase 14 → Historical Charts
Phase 15 → Testing & Hardening
Phase 16 → Production Readiness
```

Do not skip to the dashboard UI before the underlying metrics architecture is working.

---

# 23. Instructions for Claude

Treat this file as the implementation specification.

At the beginning of every phase:

1. Read this document.
2. Inspect the current repository.
3. Determine what has already been implemented.
4. Identify the current phase.
5. Implement only that phase.
6. Preserve working functionality.
7. Run tests, type checks and linting.
8. Fix issues introduced by the phase.
9. Update documentation.
10. Report what was completed.
11. Stop at the phase boundary unless explicitly told to continue.

Prefer the simplest production-ready solution when requirements are ambiguous.

Do not prematurely implement anomaly detection, AI incident analysis, forecasting, Slack/email notifications, agent attribution or budgets.

---

# 24. First Command / First Task

Start with **Phase 0 only**.

First inspect the repository and determine:

- framework
- package manager
- application structure
- database setup
- environment configuration
- authentication
- testing setup
- existing deployment configuration

Then provide a short Phase 0 plan and begin implementation.

Do not start Phase 1 until Phase 0 is complete and validated.

The first objective is:

> **Create a clean, runnable foundation for the AI & Database Observability Dashboard.**
