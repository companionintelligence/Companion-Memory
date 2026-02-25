# 20260225210000_expand_feed_queue_item_types.sql

## Purpose
Expands `ci.feed_queue` from a question-only queue to a mixed feed-item queue capable of storing action, summary, and question references.

## Changes
- Adds `item_type`, `action_id`, and `summary_id` columns.
- Makes `question_id` nullable.
- Adds integrity checks to enforce exactly one referenced item column and type-consistent rows.
- Adds unique indexes for `(user_id, action_id)` and `(user_id, summary_id)` plus an item-type ordering index.

## Contracts
- Existing question rows remain valid and default to `item_type = 'question'`.
- Queue writers can append action/summary rows without creating duplicate user-item pairs.
- Question-specific queue logic must scope itself to rows with `question_id IS NOT NULL`.

## Notes
- Down migration deletes action/summary queue rows before restoring question-only constraints.
