# Summary tokenizer

## Intent

`summary_tokenizer.py` assigns grounded hourly summary text to HBPE L0/L1
labels and turns stored labels into lower-confidence bucket tokens. It never
reads insight, daily, weekly, or monthly summaries.

## Labeling contract

- `label_day` supports the ordinary single-day path.
- `label_range` supports bounded recovery with one database fetch.
- `label_days` labels an explicit, possibly non-contiguous set of days — the
  serialize day list — with one database fetch.
- All three share exactly the same Qwen classification, quality checks,
  vocabulary updates, and idempotent label insert logic.
- One bad summary is logged and skipped without losing labels already stored.

## Cancellation

All three take an optional `should_continue()` predicate, polled before every
row. Each label is committed on its own row, so stopping mid-batch is safe: the
next run picks up exactly the summaries this one did not reach. The batch is
now the whole serialize day list rather than one day, which is why it can no
longer be treated as too short to interrupt.
