# Summary data-pipeline contract tests

These tests pin the boundary from the database source registry through
aggregation and bounded prompt construction. They use recording database stubs
and do not require PostgreSQL or a model.

The suite verifies current sources are queried, retired/derived sources are
absent, query failures remain visible, activity counting follows list-valued
sources automatically, and prompt budgets preserve semantic content from both
early and late sources.

It also pins the honesty of the budget: a sample header never names more rows
than its section contains, a section too small for a legible row drops the
sample claim instead of leaving a fragment of it, truncation stays inside a
one-character budget, a source named only by the counts is skipped rather than
raising, and a communication whose every text column is NULL still renders.
