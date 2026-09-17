# Summary orchestration tests

This suite pins skip and execution policy for rollups, hourly summaries,
dossier refresh, and bounded hourly recovery. All activities are replaced with
recording async stubs, so tests exercise orchestration without PostgreSQL or a
model.

Recovery coverage includes exact-window idempotency, aligned range validation,
the 24-hour cap, chronological one-hour dispatch, and separate accounting for
generated, empty, and already-existing windows.
