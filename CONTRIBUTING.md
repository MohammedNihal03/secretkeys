# Contributing

Thanks for your interest in the project. It is early — Phase 0 of 16 — so the
most valuable contributions right now are on the current phase rather than
features from later ones.

## Ground rules

1. **Follow the phase order** in [docs/build-plan.md](docs/build-plan.md). The
   build plan exists because dashboard UI built before the metrics architecture
   ends up being thrown away. If you want to work on a later phase, open an
   issue first.
2. **Never commit a credential.** No API keys, no connection strings, no
   `.env.local`. If you commit one by accident, rotate it — a force-push does
   not un-leak a secret.
3. **Do not invent metrics.** Providers differ in what they expose. If a metric
   is unavailable, model it as unknown. Mock data is acceptable only for
   isolated UI work and must be replaced before the phase is considered done.
4. **Keep secrets out of responses and logs.** Credentials are encrypted at
   rest, and only masked identifiers reach the browser. Error messages must not
   echo configuration values.

## Setup

See [Getting started](README.md#getting-started) in the README.

## Before opening a pull request

```bash
npm run verify
```

This runs type checking, linting, format checking and tests. CI runs the same
thing, so it is the fastest way to avoid a round trip.

If you changed the Drizzle schema, also commit the generated migration:

```bash
npm run db:generate
```

## Tests

Unit tests live in `tests/` and run against no external services. Tests that
need a real PostgreSQL instance should be named `*.integration.test.ts` so they
can be excluded from the default run.

Behaviour worth a test, in rough priority order:

- anything that decides a health status or crosses a threshold
- anything that handles a credential
- anything that normalizes a provider response, especially missing fields
- organization isolation, once Phase 2 lands

## Commit messages

Short imperative subject, one concern per commit. Reference the phase where it
helps, e.g. `phase 1: add organization and project tables`.

## Reporting bugs

Include the phase you are on, what you expected, what happened, and the output
of `/api/health`. Redact connection strings.

## Security issues

Please open a private security advisory on GitHub rather than a public issue.
