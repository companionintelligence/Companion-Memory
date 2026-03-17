# schedule.py

## Purpose
Registers the nightly `NightlyHBPEWorkflow` Temporal Schedule on worker startup.
One schedule per user, named `hbpe-nightly-<user_id_prefix>`, firing at 2:30 AM UTC.

## Components

### `setup_hbpe_schedules(client)`
- **Does**: Queries `ci.users`, creates one Temporal Schedule per user (idempotent).
- **Cron**: `30 2 * * *` — 2:30 AM UTC, after daily summaries (00:10) and dossier refresh (:12).
- **Called from**: `worker.py` on every startup. Already-existing schedules are silently skipped.

### `delete_hbpe_schedules(client)`
- **Does**: Deletes all `hbpe-nightly-*` schedules. Use to reset timing or force recreation.

## Contracts
| Dependent | Expects |
|-----------|---------|
| `worker.py` | Calls `setup_hbpe_schedules(client)` after Temporal connect, before worker loop |
| Temporal | `NightlyHBPEWorkflow` registered on `settings.task_queue` (hbpe) |

## Notes
- Schedule IDs are `hbpe-nightly-{user_id[:8]}` — short prefix only, not full UUID
- Workflow execution IDs are `hbpe-nightly-{prefix}-{scheduled_time}` for uniqueness
- Safe to call on every container restart (idempotent via "already exists" check)
- Implements the scheduling half of T5.0 (CI-Server-1wz)
