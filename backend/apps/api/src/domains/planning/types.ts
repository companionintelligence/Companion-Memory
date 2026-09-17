import type { TaskStatus } from './entities/TaskEntity';
import type { TaskPendingChangeKind } from './entities/TaskPendingChangeEntity';

export interface CreateTaskDto {
  id?: string;
  title: string;
  description?: string | null;
  notes?: string | null;
  status?: TaskStatus;
  priority?: number;
  parentId?: string | null;
  dueAt?: Date | null;
  /** Wall-clock `HH:MM` or `HH:MM:SS`, no zone. */
  taskTime?: string | null;
  /** Owner-local `YYYY-MM-DD`. */
  scheduledFor?: string | null;
  /** Owner-local `YYYY-MM-DD`. */
  deferUntil?: string | null;
  estimatedMinutes?: number | null;
  sourceKind?: string;
  sourceRef?: string | null;
  metadata?: Record<string, unknown>;
}

export interface UpdateTaskDto {
  title?: string;
  description?: string | null;
  notes?: string | null;
  status?: TaskStatus;
  priority?: number;
  parentId?: string | null;
  dueAt?: Date | null;
  taskTime?: string | null;
  scheduledFor?: string | null;
  deferUntil?: string | null;
  estimatedMinutes?: number | null;
  actualMinutes?: number;
  metadata?: Record<string, unknown>;
}

export interface FindTasksOptions {
  status?: TaskStatus[];
  /** Owner-local `YYYY-MM-DD`; matches `scheduled_for` exactly. */
  scheduledFor?: string;
  parentId?: string | null;
  limit?: number;
}

export interface CreateTaskPendingChangeDto {
  taskId: string;
  kind: TaskPendingChangeKind;
  patch?: Record<string, unknown>;
  rationale?: string | null;
  confidence?: number | null;
}

/**
 * Partial update of a user's planning preferences. Only the keys present are
 * written; an explicit `null` resets that field to its shipped default rather
 * than deleting the row.
 */
export interface UpdatePlanningPrefsDto {
  /** Zoneless wall-clock `HH:MM`. */
  workStart?: string | null;
  /** Zoneless wall-clock `HH:MM`. */
  workEnd?: string | null;
  defaultEstimatedMinutes?: number | null;
  flexDays?: number | null;
}
