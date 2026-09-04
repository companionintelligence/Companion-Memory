# HBPE background functions

## Intent

`functions.py` orchestrates nightly and cold-start HBPE pipelines while
preserving fail-continue behavior between independent maintenance steps.

## Summary recovery parameters

`nightly` and `bootstrap` accept optional `summary_start_date` and
`summary_end_date` arguments. When supplied together they are forwarded to the
summary-label step; when absent, that step derives the serialization window.
Partial or invalid ranges fail within the labeled step and remain visible in
the normal per-step result.
