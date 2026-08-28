# QA — release verification for CI-Server

Three documents, read in this order:

| Document | What it is | When you read it |
|---|---|---|
| [`release-qa-program.md`](release-qa-program.md) | The programme: risk-ranked feature inventory, per-surface automated matrix, manual scripts, the UI-refactor rubric, per-target build procedures, sign-off checklist. | Before every release. |
| [`baseline-2026-08-26.md`](baseline-2026-08-26.md) | The measured day-zero state: every suite actually run, with the real numbers and each failure classified. | To know what was already red before you started. |
| [`ci-gate-proposal.md`](ci-gate-proposal.md) | What runs automatically today (almost nothing), what it costs, and the minimum gate worth turning on. | When deciding whether to change CI. |

The programme assumes the reader has a clean checkout and nothing else. Every
command in it was run on 2026-08-26 while writing the baseline; where a command
does not work as documented elsewhere in the repo, the baseline says so.
