# SchedulePage

## Intent

`SchedulePage` is the calendar half of the combined Calendar surface. It owns the visible week, committed events, the learned weekly rhythm, task placement, and the fixed day-ahead prediction band above the calendar.

## Data contracts

- `useScheduleService(start, end)` supplies committed events and the seven-day recurrence forecast for the week currently on screen.
- `useForecastService()` supplies the HBPE `/histogram` response: tomorrow's 96 quarter-hour occupancy bins plus model and pipeline status. This response is passed unchanged to `PredictionBand`; calendar events never substitute for it. Its `refetch` is passed down as the band's `onRetry`.
- `usePlanTasks(refetch)` supplies tasks that can be placed onto the calendar.
- `useRescheduleEvent(refetch)` moves committed events.

## Composition

The page can render standalone or embedded at the top of `TodayPage`. In the embedded form, the host owns scrolling, safe-area padding, and the document title. The day-ahead band stays visible when the displayed calendar is paged to another week because its heading explicitly identifies its independent, fixed horizon.

## Failure behavior

The schedule and prediction calls fail independently. Schedule failures retain any usable events or rhythm. Prediction failures remain visible inside `PredictionBand` so a missing audit surface cannot be mistaken for an intentional UI removal.

A failed prediction call is recoverable only from here. The resolver answers `null` on an HBPE error and `useForecastService` stops polling on a null forecast, so the band's retry has to be the hook's own `refetch` — without it the failed state lasts until the user leaves the page.

The `hbpe` feature flag owns the band itself. `forecast.page` controls only the optional link to the larger Forecast page, so disabling that secondary destination does not remove the primary audit strip from Calendar.
