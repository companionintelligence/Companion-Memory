# macosActivityRecords.ts

## Purpose
Translate a small, documented subset of Apple's SQLite activity stores into
dated import items. No OS calls, source mutations, or model-generated evidence.

## Components
- `readMacosRows`: validates required columns, projects optional fields as NULL,
  streams rows from Knowledge, Safari, or CallHistory snapshots.
- `appleDate`: Apple epoch seconds to UTC; missing/invalid dates stay invalid.
- `macosItem`: stable device/source/record/time identity; original spans and
  readable semantic metadata; explicit drop results.

## Contracts
| Dependent | Expects | Breaking changes |
| --- | --- | --- |
| `macos_activity.ts` | Bounded row projections and explicit drop results | Source names, identity algorithm |
| Canonical push | `macos_activity` → events; `page_view` → browser; `call` → communications | Classification or metadata keys |
| Hourly summaries | Event title/description, original span, source_system macos_activity | Losing semantic fields or original times |

## Notes
Knowledge's four allowlisted streams describe app use, web use, lock state,
and display state. State values have explicit locked/unlocked and on/off labels.
They are observations, not proof of attention or productivity.
Missing optional metadata is supported; missing required columns fail visibly.
The source table ID plus original time prevents row-ID reuse collisions;
reusing the same device/account label is required for snapshot deduplication.
Schema references and deliberate exclusions live in `docs/import/macos-activity.md`.
