# ForecastStrip.tsx

## Purpose
Renders the 24-hour behavioural forecast as a horizontal strip of 48 coloured slots (one per 30-min bucket). Colour encodes the dominant L0 class; opacity encodes q50 confidence. Hovering any slot opens a Radix Tooltip with a mini horizontal bar chart of all L0 class probabilities and the top L1 context cluster.

## Components

### `ForecastStrip`
- **Does**: Top-level component. Renders the slot strip, time labels, and legend.
- **Props**: `buckets: ForecastBucket[]`, `generatedAt: string`, `className?: string`
- **Interacts with**: `ForecastSlot`, `Legend`

### `ForecastSlot`
- **Does**: Single 30-min segment. Coloured div wrapped in a `Tooltip` from `@ci/shadcn`. Scale-Y animation on hover.
- **Interacts with**: `SlotTooltip` (rendered as `Tooltip.Content`)

### `SlotTooltip`
- **Does**: Tooltip body. Shows time range, sorted L0 probability bars (pure Tailwind divs), and top L1 cluster name if confidence > 10%.
- **Interacts with**: `ForecastBucket` data shape

### `Legend`
- **Does**: Colour key for L0 classes, rendered beneath the strip.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|-----------------|
| `FeedPage` | `<ForecastStrip buckets={...} generatedAt={...} />` | Props signature |
| `useForecastService` | `ForecastBucket.{l0_probs, l1_probs, q50, start_time}` | Field names / types |

## Notes
- `q50` is clamped to [0.2, 1] so very quiet overnight slots remain visible.
- L1 cluster IDs are UUIDs; only the first 24 chars are shown in the tooltip.
- Slot opacity is driven by `q50` (median forecast confidence), not `q90`.
