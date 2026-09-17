# Summary pure functions

## Intent

`summary_functions.py` transforms already-projected activity rows into bounded
model prompts and turns model output into summary, dossier, insight, and action
payloads.

## Hourly input contract

- Activity counts are derived from every list-valued source returned by the
  aggregator; adding a registered source requires no second hardcoded list.
- Metadata fields are ignored when counting.
- Prompt space is shared across non-empty sources so a busy early source cannot
  erase later sources.
- Each source's share is spent on items, not on rendered text: how many rows fit
  and how many characters each row gets are decided before rendering, so the
  "Sample (newest N)" header can never name more rows than the section carries.
  A source too poor for one legible row reports its count and claims no sample.
- Each item is individually bounded, and the complete prompt has a hard
  character ceiling — truncation includes its own ellipsis in the budget it was
  given. Source projections place semantic fields first within that bound.
- Data and counts are independent arguments, so a source named by the counts but
  absent from the data is reported without a sample rather than raising.

The module remains side-effect free except for explicitly injected model and
embedding calls, which keeps prompt construction independently testable.

Insight prompts include the semantic excerpt and named direction/participants
from each recent communication, rather than reducing the communication to its
subject line. Every one of those columns can arrive NULL — the excerpt is a
COALESCE over summary/preview/content that a call log or an attachment-only MMS
leaves empty, and sender/recipient names come from an outer join — so each field
is read as "value or empty string" rather than with a default that only applies
when the key is missing.
