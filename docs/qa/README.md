# QA — release verification for CI-Server

Read in this order:

| Document | What it is | When you read it |
|---|---|---|
| [`release-qa-program.md`](release-qa-program.md) | The programme: risk-ranked feature inventory, per-surface automated matrix, manual scripts, the UI-refactor rubric, per-target build procedures, sign-off checklist. | Before every release. |
| [`baseline-2026-08-26.md`](baseline-2026-08-26.md) | The measured day-zero state: every suite actually run, with the real numbers and each failure classified. | To know what was already red before you started. |
| [`baseline-2026-08-29.md`](baseline-2026-08-29.md) | The next measurement pass. Read it against the one above — **the delta is the release risk**. | Same, and after the day-zero one. |
| [`ci-gate-proposal.md`](ci-gate-proposal.md) | What runs automatically, what it costs, and the minimum gate worth turning on. Its §5 tracks which of its own proposals have shipped. | When deciding whether to change CI. |

A baseline is a record of what was true on its date, not a live document: where one contradicts the programme or the proposal, the later of the two is the one to trust, and the way to settle it is to re-measure rather than to edit the record.

The programme assumes the reader has a clean checkout and nothing else. Every
command in it was run on 2026-08-26 while writing the baseline; where a command
does not work as documented elsewhere in the repo, the baseline says so.
