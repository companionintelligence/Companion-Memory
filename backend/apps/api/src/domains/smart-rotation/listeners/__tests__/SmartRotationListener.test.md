# SmartRotationListener.test.ts

## Purpose

Pins smart-rotation routing and queue contracts without requiring Postgres or
the Python sidecars.

## Components

### Work-type routing tests

- **Does**: Verifies each rotation work type reaches its owning service with the expected payload.
- **Interacts with**: Mocked domain services and `PythonFunctionService`.

### Summary recovery tests

- **Does**: Verifies every summary tick dispatches an hourly digest, and that the dossier is dispatched when the gate reports stale and withheld when it does not.
- **Rationale**: Prevents the no-summary/stale-summary bootstrap trap from returning, and prevents the hourly LLM dossier rebuild that removing the trap first introduced.
- **Note**: The gate's answer is a mock here — an input, never an assertion — so a test cannot name a user state, only the boolean it fed in. What this suite does own is the SQL shape: which stamp the query reads, which period types count, and that an unreadable stamp fails open toward dispatching. Whether Postgres resolves those states to the right boolean is executed against a live database in `python-functions/__tests__/PythonFunctionCrons.dossierGate.integration.spec.ts`, which runs the same predicate set-wise for the cron fan-out. The summary sidecar's dossier tests prove nothing about it: `backend/apps/summary/tests/conftest.py` sets a fake `DATABASE_URL` and every dossier activity is monkeypatched.

### Insight dispatch test

- **Does**: Verifies the scheduler always delegates novelty decisions to the sidecar and includes personalization.

### Answer-inference rotation tests

- **Does**: Pins cooldown, ordering, and live/archive attempt-history semantics.

## Contracts

| Dependent | Expects | Breaking changes |
| --- | --- | --- |
| `SmartRotationListener.ts` | Mock constructor order mirrors production injection | Reordering constructor parameters |
| Summary recovery | Hourly dispatch is unconditional and precedes the dossier gate | Reintroducing pre-summary gating, or consulting the gate first |
| Dossier gate | Dispatch follows new summary input, not a cadence | Removing the skip assertion, or asserting a fixed interval |
| Insight recovery | No scheduler-side novelty suppression | Calling `hasNoveltySinceLastRun` before dispatch |
