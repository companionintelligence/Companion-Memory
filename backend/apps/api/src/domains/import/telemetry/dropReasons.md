# dropReasons.ts

## Purpose
Map parser-specific drop slugs into the shared closed telemetry vocabulary.
Expected filters and actual data gaps remain distinguishable in import reports.

## Components
- `DROP_REASONS`: stable category vocabulary.
- `DROP_SLUG_REASONS`: exhaustive parser slug mapping, including
  `macos_unsupported_stream` → `unsupported_shape` so unhandled Knowledge streams
  remain visible instead of being reported as imported activity.
- Hulu's existing `no_title` slug maps to `no_identity`, keeping the exhaustive
  vocabulary check accurate for rows without an episode or series name.
- `represented_elsewhere` (expected) versus `no_destination` (gap): both are a
  push row `destinationsFor` routed nowhere; the first is one another lane
  already carries by design (a contact card's Person, a rolled-up subscription
  line's order receipt — `push/canonical.ts isRepresentedElsewhere`), the second
  is one nothing claimed.

## Contracts
Parse and push summaries depend on stable category meanings. The vocabulary
tests enumerate datasource drop literals and reject unmapped slugs.
