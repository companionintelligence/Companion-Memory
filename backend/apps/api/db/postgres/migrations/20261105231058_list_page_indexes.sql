-- migrate:up
-- The notes, threads and tasks lists are now read one page at a time from SQL
-- (`findPage` on NoteService, ThreadService and TaskService), sorted and seeked
-- on these orders. Each index matches one list's ORDER BY exactly, so a page is
-- an index range scan rather than a sort over the user's whole table.
CREATE INDEX IF NOT EXISTS idx_notes_user_list_order
  ON ci.notes (user_id, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_threads_user_list_order
  ON ci.threads (user_id, updated_at DESC, thread_id DESC)
  WHERE is_archived = false;

CREATE INDEX IF NOT EXISTS idx_tasks_user_list_order
  ON ci.tasks (user_id, due_at, priority, created_at DESC, id DESC);

-- migrate:down
DROP INDEX IF EXISTS ci.idx_tasks_user_list_order;
DROP INDEX IF EXISTS ci.idx_threads_user_list_order;
DROP INDEX IF EXISTS ci.idx_notes_user_list_order;
