# SchedulePage tests

These tests cover the page-level wiring between schedule data, HBPE data, the calendar grid, and task mutations. Occupancy assertions verify that the page passes `useForecastService` buckets into `VerticalCalendar` and never mounts a top-of-page prediction band.

The forecast hook fixture includes its real loading/stalled state shape so page wiring cannot accidentally pass an undefined request state into the grid.

Footer-copy tests still distinguish off / failed / running / no-pattern / live. Occupancy that falls inside the drawn window counts as a live layer so a working histogram cannot be described as "nothing learned" over boxes the grid is already painting.
