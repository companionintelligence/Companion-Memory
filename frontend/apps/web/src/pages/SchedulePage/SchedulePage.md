# SchedulePage

## Intent

`SchedulePage` is the calendar half of the combined Calendar surface. It owns the visible week, committed events, the learned weekly rhythm, and task placement. The day-ahead HBPE histogram is not a second strip above the calendar or a gutter of boxes — its 96 quarter-hour bins wash the day column behind committed events so the hours themselves read as color-coded time.

## Data contracts

- `useScheduleService(start, end)` supplies committed events and the seven-day recurrence forecast for the week currently on screen.
- `useForecastService()` supplies the HBPE `/histogram` response: tomorrow's 96 quarter-hour occupancy bins plus model and pipeline status. Calendar events never substitute for those bins. The page passes `buckets` into `VerticalCalendar`; pipeline status still drives the waiting shimmer on empty strips.
- `usePlanTasks(refetch)` supplies tasks that can be placed onto the calendar.
- `useRescheduleEvent(refetch)` moves committed events.

## Composition

The page can render standalone or embedded at the top of `TodayPage`. In the embedded form, the host owns scrolling, safe-area padding, and the document title.

Occupancy is a fixed 24h horizon. Bins only light strips in the week (or phone day) currently on screen; paging away does not keep a floating "tomorrow" band above an unrelated week.

## Failure behavior

The schedule and prediction calls fail independently. Schedule failures retain any usable events or rhythm. A missing occupancy histogram leaves the week-forecast climate on the strips; a missing week forecast still lets occupancy paint the day it covers.

The `hbpe` feature flag owns both the occupancy bins and the climate layer. `forecast.page` is only the richer `/forecast` destination and does not gate the calendar strips.
