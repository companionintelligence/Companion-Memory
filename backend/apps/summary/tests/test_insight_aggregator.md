# Insight aggregator tests

These unit tests inspect the single novelty query sent by the sidecar. They pin
communications as a novelty source, event updates as well as inserts, exclusion
of generated insights, and forwarding of the last-stored-insight timestamp.
They also ensure communication meaning and participant names reach the insight
prompt instead of collapsing to a subject line. No live database or model is
used.
