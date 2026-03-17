# qwen_labeler.py

## Purpose
Assigns L0+L1 labels to events and L0+L1+L2 labels to content using a single Qwen3.5-0.8B completion per item. Replaces the entire HDBSCAN/BERTopic/router/namer pipeline with direct LLM classification. The model chooses from existing vocab or proposes new labels; new labels are auto-created and trigger an HMT retrain signal.

## Components

### `QwenLabeler`
- **Does**: Stateful labeler with per-instance vocab caches (invalidated when new labels are created)
- **Interacts with**: `ci.inference.qwen.get_qwen()`, `ci.tokenizer.vocab_registry`

### `QwenLabeler.label_event(event_id, user_id, title, description)`
- **Does**: Builds event prompt → calls Qwen → parses JSON → writes to DB
- **Returns**: `{"l0", "l1", "l1_id", "is_new_l1"}`

### `QwenLabeler.label_content(content_id, user_id, title, content_type)`
- **Does**: Builds content prompt with L2 vocab → calls Qwen → parses JSON → writes to DB
- **Returns**: `{"l0", "l1", "l1_id", "is_new_l1", "l2", "l2_id", "is_new_l2"}`

### `_build_event_user_message(title, description, all_l1)`
- **Does**: Chat-style user message with `_L0_BLOCK` (class names + descriptions) + existing vocab
- **Rationale**: Descriptions for each L0 class (e.g. "SOCIAL — gatherings with people") give the model semantic anchors so it picks the right class rather than defaulting to WORK

### `_build_content_user_message(title, content_type, all_l1, all_l2)`
- **Does**: Same pattern, includes L2 vocab grouped by L1

### `_L0_BLOCK`
- **Does**: Pre-formatted string listing each L0 class with a one-line description; injected into every prompt

### `_parse_json(raw)`
- **Does**: Finds first `{...}` block anywhere in the response; falls back to regex extraction
- **Rationale**: Chat instruct models may add a preamble sentence before the JSON — brace-depth scan handles this

### `_clean_label(raw)`
- **Does**: Strips quotes/whitespace, collapses spaces, truncates to 50 chars

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `pipeline/nightly_runner.py` | `label_event()` and `label_content()` as documented | Signature changes |

## Notes
- Vocab caches live for the QwenLabeler instance lifetime — create one per nightly run, not one per event
- `_MAX_VOCAB_IN_PROMPT = 20` limits prompt growth as vocabulary expands
- `_L0_BLOCK` descriptions are the key to accurate classification — bare class names cause WORK bias
