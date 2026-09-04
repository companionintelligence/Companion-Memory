# HBPE summary-label range tests

These tests pin the direct SQL selection of unlabeled hourly summaries, shared
single-day/range labeling behavior, derived serialization-window defaults, and
explicit recovery dates, including the serialization-window safety cap.
Database connections and Qwen dependencies are replaced by small recording
fakes.

They also pin the token-window bounds query to all serializer inputs. A recent
hourly summary or completed labeled task must extend the same window used for
summary labeling and serialization even when the user's latest event occurred
earlier.
