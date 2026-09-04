# PredictionBand

## Intent

`PredictionBand` restores the compact HBPE histogram that historically appeared at the top of Feed. Calendar is now the combined day surface, so the band sits above its schedule.

## Contract

- Accepts the `ForecastResponse` returned by `useForecastService()` (the hook's default `'24h'` horizon) without deriving or replacing bins from calendar data.
- Delegates bin ordering, activity color, confidence opacity, tooltips, model version, pipeline progress, and generation time to the existing `ForecastStrip` component.
- Identifies the forecast as tomorrow's 96 quarter-hour bins because the HBPE `/histogram` endpoint begins at midnight tonight.
- Shows a link to the richer `/forecast` surface only when the `forecast.page` feature is enabled.

## States

- A resolved forecast renders the interactive strip.
- An initial request renders a compact loading message without covering the calendar.
- An error or swallowed-null GraphQL response renders an explicit unavailable message with a Try again control wired to `onRetry`.

The panel uses ordinary in-flow status text rather than page-level loading overlays, keeping the schedule usable while the independent prediction request resolves or fails.

The loading and unavailable states are separate elements with separate keys, so the polite `status` region is removed and an assertive `alert` introduced rather than one node changing its role under a screen reader that is already watching it.

## Why the retry is a required prop

`ForecastResolver.ts` swallows an HBPE failure and returns `null`, and `useForecastService` treats a null forecast as "nothing to poll for" and calls `stopPolling()`. Nothing in the hook will re-issue the query, so the unavailable state is terminal unless the page threads `refetch` down as `onRetry`. `onRetry` is required rather than optional for that reason: a call site that forgets it is exactly the bug this contract exists to prevent.
