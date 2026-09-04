# PredictionBand tests

These tests keep the restored audit surface honest: resolved HBPE bins and status metadata reach `ForecastStrip` unchanged, the full Forecast link follows its feature gate, and loading or unavailable responses remain visibly distinguishable from a removed component.

The strip itself is mocked here because its bucket geometry and tooltip behavior are independent component responsibilities; this suite verifies the Calendar-facing boundary.

Two of them guard states that are easy to regress into decoration: the unavailable state must expose a Try again that calls `onRetry` and must render the strip once a retry resolves, and the loading and unavailable live regions must be distinct DOM nodes rather than one node whose `role` flips between renders.
