# Refresh hourly summary labels

## Purpose
Invalidate HBPE's cached classification when forced backfill revises the text
that the summary tokenizer actually reads (the first 400 characters), or moves
the summary to a different owner/window/type. Updates preserve the summary ID.

## Contract
Run `make migrate` before importing and regenerating historical summaries.
Summary-only installations remain supported through a guarded dynamic delete.
No stored activity is removed; the next HBPE serialization reclassifies missing
labels. Downgrade removes the trigger/function and cannot restore invalidated
derived labels. Existing token streams/models refresh on the normal HBPE run.

The tokenizer locks and checks the current summary text before inserting a
label, preventing an in-flight classification from restoring a stale label.
No invalidation occurs for unchanged text or unrelated summary metadata.
