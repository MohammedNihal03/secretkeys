# AI & Database Observability Dashboard

## 1. Purpose

Build an internal organization dashboard that provides a single place to monitor the **usage, health, limits, and performance of AI services and PostgreSQL/SQL databases**.

The primary goal is to know whether the organization's AI infrastructure and databases are healthy, approaching limits, or experiencing problems before users are affected.

---

# 2. Core Dashboard

The first version should focus only on **AI/API monitoring and PostgreSQL/SQL health**.

## 2.1 Organization Overview

The main dashboard should provide a high-level health summary:

- Overall organization health
- AI services health
- Database health
- API request volume
- Token usage
- Estimated AI cost
- Database connections
- Database CPU
- Database memory
- Database storage
- Active/idle connections
- Slow query count
- Recent errors
- Active warnings

Example:

```text
Organization Health                              🟢 Healthy

AI SERVICES              DATABASE                 SYSTEM
🟢 Healthy               🟢 Healthy               🟢 Healthy

API Requests             Connections              CPU
1.24M                    42 / 200                 38%

Token Usage              Slow Queries             Memory
18.4M                    3                        61%

Estimated Cost           Database Size            Disk
$184.20                  42 GB                    67%
```

---

# 3. AI Provider Monitoring

The dashboard should support multiple AI providers.

Initial providers can include:

- OpenAI
- Google Gemini
- Anthropic
- Other providers later

## Metrics

Track where the provider/API makes the information available:

- API requests
- Successful requests
- Failed requests
- Input tokens
- Output tokens
- Total tokens
- Estimated cost
- Request latency
- Rate-limit errors
- HTTP 429 errors
- Provider errors
- Usage limits/quota
- Key status
- Last successful request
- Last error

## Key Health

Each API key should have a clear status:

```text
🟢 Healthy
🟡 Warning
🔴 Critical
⚫ Unknown
```

The system should avoid exposing full API keys.

Display something like:

```text
OpenAI
Key: sk-••••••••7A91
Status: 🟢 Healthy
Requests: 184,201
Tokens: 4.8M
Usage: 42%
Errors: 0.4%
```

---

# 4. AI Usage Analytics

The system should allow the organization to understand AI consumption.

Track usage over:

- Today
- Last 7 days
- Last 30 days
- Custom date range

Visualize:

- Requests over time
- Token usage over time
- Cost over time
- Errors over time
- Provider comparison
- API-key usage

The dashboard should make it easy to answer:

> How much AI are we using?

> Which provider are we using most?

> How much are we spending?

> Are usage and errors increasing?

---


# 4.1 Project-to-API-Key Mapping

A single AI provider may be used by multiple projects within the organization. The dashboard must explicitly associate every API key with the project and environment that uses it.

Do **not** attempt to determine a project from the API key itself.

Example:

```text
OpenAI

Project          API Key              Environment   Status
────────────────────────────────────────────────────────────
FYIND            sk-••••A91F          Production    🟢
Lunad            sk-••••72BC          Production    🟢
Skrumi           sk-••••19DE          Development   🟢
Internal AI      sk-••••88XA          Production    🟡
```

## Credential hierarchy

The monitoring system should maintain the following relationship:

```text
Organization
     │
     ├── Projects
     │     ├── FYIND
     │     ├── Lunad
     │     ├── Skrumi
     │     └── Internal AI
     │
     └── AI Providers
           │
           └── API Keys
                 ├── OpenAI → FYIND
                 ├── OpenAI → Lunad
                 ├── OpenAI → Skrumi
                 └── Gemini → FYIND
```

Each API key should have an explicit project association.

Recommended `api_keys` fields:

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
```

Every key should also have a human-readable name, for example:

```text
OpenAI
├── FYIND Production
├── FYIND Staging
├── Lunad Production
├── Lunad Development
└── Skrumi Production
```

The actual credential must remain encrypted and masked in the UI:

```text
FYIND Production
Provider: OpenAI
Key: sk-••••••••A91F
Status: 🟢 Healthy
```

## Provider-side project mapping

Some AI providers have their own concept of projects or organizations. Where available, store the provider-side project identifier separately.

```text
Our Organization
      │
      ▼
Our Project
      │
      └── FYIND
            │
            ▼
       AI Provider
            │
            └── OpenAI
                  │
                  ▼
           Provider Project ID
                  │
                  └── proj_xxxxxxxxx
                        │
                        ▼
                     API Key
                        │
                        └── sk-••••A91F
```

This allows the dashboard to distinguish between:

- Our internal project
- The external AI provider
- The provider-side project
- The specific API key
- The environment using the key

## Usage records

Usage data should preserve these relationships so the dashboard can answer questions such as:

> Which project is consuming the most tokens?

> Which API key is approaching its limit?

> How much did FYIND spend on OpenAI this month?

> Which project's API key is generating the most errors?

Recommended usage fields:

```text
api_key_id
project_id
provider_id
timestamp
requests
input_tokens
output_tokens
total_tokens
estimated_cost
errors
latency
```

This project → provider → API key → usage relationship is fundamental to the observability architecture.

# 5. PostgreSQL / SQL Monitoring

The dashboard should monitor PostgreSQL database health and performance.

## Database Health

Track:

- Database availability
- CPU usage
- Memory usage
- Disk usage
- Database size
- Storage growth
- Connection count
- Maximum connections
- Active connections
- Idle connections
- Connection utilization
- Transaction rate
- Cache hit ratio

## Query Health

Track:

- Active queries
- Long-running queries
- Slow queries
- Query execution time
- Query errors
- Failed transactions
- Locks
- Deadlocks

The dashboard should help identify issues such as:

```text
PostgreSQL connection usage

42 / 200 connections

████████░░░░░░░░░░░░ 21%

Status: 🟢 Healthy
```

And:

```text
⚠ PostgreSQL Connections

Current: 174
Maximum: 200

Utilization: 87%

Status: 🟡 Warning
```

This should make database problems such as:

```text
FATAL: sorry, too many clients already
```

easy to detect before they become a production incident.

---

# 6. Database Overview

Each connected database should have its own health page.

Example:

```text
PostgreSQL — Production

Status                    🟢 Healthy

CPU                       38%
Memory                    61%
Disk                      67%

Connections               42 / 200
Active Connections        12
Idle Connections          30

Database Size             42 GB

Slow Queries              3
Long-running Queries      1
Deadlocks                 0
```

---

# 7. Alerts & Health Indicators

The first version should provide visual warnings inside the dashboard.

Examples:

```text
🟢 Healthy
🟡 Warning
🔴 Critical
```

Potential warning conditions:

- API key usage approaching limit
- AI provider rate limits
- High AI error rate
- High API latency
- PostgreSQL connection utilization
- High CPU
- High memory
- High disk usage
- Long-running queries
- Deadlocks
- Database unavailable

---

# 8. Architecture

The dashboard should not continuously query production databases directly from the frontend.

Use a monitoring/metrics collection layer.

```text
                    ┌──────────────────────┐
                    │     AI Providers      │
                    │                      │
                    │ OpenAI / Gemini /    │
                    │ Anthropic / Others   │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │   Metrics Collector  │
                    │                      │
                    │ API usage            │
                    │ Tokens               │
                    │ Costs                │
                    │ Limits               │
                    │ Errors               │
                    └──────────┬───────────┘
                               │
                               │
┌──────────────────┐           ▼
│   PostgreSQL     │───►┌──────────────────────┐
│   Production DB  │    │ Observability Backend│
└──────────────────┘    │                      │
                        │ Metrics              │
                        │ Health checks         │
                        │ Alerts               │
                        │ Aggregations          │
                        └──────────┬───────────┘
                                   │
                                   ▼
                        ┌──────────────────────┐
                        │      Dashboard       │
                        │                      │
                        │      Next.js         │
                        └──────────────────────┘
```

---

# 9. Security Requirements

Security is critical because the platform will deal with API credentials and infrastructure information.

## API Keys

Never display complete API keys.

Store credentials securely and preferably use:

- Environment secrets
- Secret manager
- Encryption at rest
- Encryption in transit

The UI should only display masked identifiers.

Example:

```text
sk-••••••••7A91
```

## Access Control

The dashboard should support organization-level access.

Potential roles:

```text
Organization Admin
    │
    ├── Full monitoring access
    ├── Manage providers
    ├── Manage API keys
    └── Manage databases

Developer
    │
    ├── View metrics
    ├── View health
    └── View alerts
```

---

# 10. Suggested Dashboard Structure

```text
Dashboard
│
├── Overview
│
├── AI Providers
│   ├── OpenAI
│   ├── Gemini
│   ├── Anthropic
│   └── Other Providers
│
├── API Keys
│   ├── Usage
│   ├── Limits
│   ├── Costs
│   └── Health
│
├── Databases
│   ├── PostgreSQL
│   ├── Connections
│   ├── Queries
│   ├── Storage
│   └── Performance
│
└── Alerts
    ├── AI
    ├── Database
    └── Infrastructure
```

---

# 11. Initial MVP Scope

The first release should **not** attempt to build a complete observability platform.

Focus on:

### AI

- Provider registration
- API key registration
- Secure/masked key handling
- Request metrics
- Token metrics
- Cost estimation
- Usage limits
- Rate-limit monitoring
- Error monitoring
- API latency
- Provider health

### PostgreSQL

- Database registration
- Connection health
- CPU
- Memory
- Disk
- Database size
- Active/idle connections
- Maximum connections
- Connection utilization
- Slow queries
- Long-running queries
- Locks/deadlocks
- Database availability

### Dashboard

- Organization overview
- AI health cards
- Database health cards
- Usage charts
- Health indicators
- Recent errors
- Warnings
- Basic alert conditions

---

# 12. Future Expansion

These features should be intentionally left out of the initial MVP but considered in the architecture.

Eventually add:

- 🔔 Slack/email alerts
- Automatic anomaly detection
- Cost forecasting
- "Which agent is consuming the most tokens?"
- "Which API key is close to its limit?"
- "Why did database connections spike?"
- AI-generated incident explanations
- Historical incident timeline
- Per-project budgets
- Per-agent budgets

The architecture should leave room for these capabilities without requiring a complete rewrite.

---

# 13. Product Vision

The long-term product should become an internal:

> **AI Infrastructure Control Center**

The goal is to give the organization one place to answer:

- Is our AI infrastructure healthy?
- Are we approaching an API limit?
- Which provider is being used?
- How many tokens are we consuming?
- How much are we spending?
- Are our databases healthy?
- Are database connections approaching their limit?
- Are queries becoming slower?
- Are there infrastructure problems right now?

The MVP should establish reliable monitoring first. Advanced intelligence, forecasting, automation, and incident management can be built on top of this foundation later.
