# SchedulePage tests

These tests cover the page-level wiring between schedule data, HBPE data, the calendar grid, and task mutations. The prediction-band assertion verifies that the page passes the exact `useForecastService` response and feature-gated audit link state to the band component; detailed band rendering states live in `PredictionBand.test.tsx`.

They also assert that the band precedes the calendar in document order and that only the `hbpe` flag can remove it.

The forecast hook fixture includes its real loading/stalled state shape so page wiring cannot accidentally pass an undefined request state into the panel.

The fixture is the hook's real two-element tuple, so one test can invoke the `onRetry` the page handed down and assert it reaches `refetch` — the wiring that makes a failed forecast recoverable without leaving the page.
