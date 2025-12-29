import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

interface WorkflowStatus {
  total: number;
  system: Record<string, number>;
  user: Record<string, number>;
}

interface WorkflowControlResult {
  cancelled?: string[];
  triggered?: string[];
  already_running?: string[];
  not_found?: string[];
  errors?: Array<{ workflow_id?: string; workflow_type?: string; error: string }>;
}

/**
 * Service for coordinating with Temporal workflows to manage LLM resource priority.
 *
 * This service enables the TypeScript API to pause background summarization workflows
 * when high-priority user-facing operations (like chat) need immediate LLM access.
 */
@Injectable()
export class TemporalService {
  private resumeTimeout: NodeJS.Timeout | null = null;

  constructor(private readonly logger: LoggerService) {
    this.logger.setContext(TemporalService.name);
  }

  /**
   * Get current workflow status from summary service.
   */
  async getWorkflowStatus(): Promise<WorkflowStatus> {
    try {
      const response = await fetch(`${config.services.summary.host}/workflows/status`);

      if (!response.ok) {
        throw new Error(`Failed to get workflow status: ${response.statusText}`);
      }

      const data = await response.json();

      return data.workflows as WorkflowStatus;
    } catch (error) {
      this.logger.warn('Failed to get workflow status', {
        error: error instanceof Error ? error.message : String(error),
      });

      // Return empty status on error
      return {
        total: 0,
        system: {},
        user: {},
      };
    }
  }

  /**
   * Pause background summary workflows to free LLM resources for high-priority work.
   *
   * This cancels running system workflows (hourly summaries, dossier refresh, etc.)
   * to ensure chat and other user-facing operations get immediate LLM access.
   *
   * @param workflowTypes - Optional list of specific workflow types to cancel
   */
  async pauseBackgroundWork(workflowTypes?: string[]): Promise<WorkflowControlResult> {
    try {
      const response = await fetch(`${config.services.summary.host}/workflows/cancel-system`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflow_types: workflowTypes,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to cancel workflows: ${response.statusText}`);
      }

      const data = await response.json();
      const result = data.results as WorkflowControlResult;

      this.logger.log('Background workflows paused', {
        cancelled: result.cancelled?.length ?? 0,
        not_found: result.not_found?.length ?? 0,
        errors: result.errors?.length ?? 0,
      });

      return result;
    } catch (error) {
      // Don't fail high-priority operations if cancellation fails
      this.logger.warn('Failed to pause background work', {
        error: error instanceof Error ? error.message : String(error),
      });

      return { errors: [{ error: String(error) }] };
    }
  }

  /**
   * Resume background workflows after high-priority work completes.
   *
   * This manually triggers system workflows to resume background processing
   * without waiting for the next scheduled run.
   *
   * @param workflowTypes - Optional list of specific workflow types to resume
   */
  async resumeBackgroundWork(workflowTypes?: string[]): Promise<WorkflowControlResult> {
    try {
      const response = await fetch(`${config.services.summary.host}/workflows/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflow_types: workflowTypes,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to resume workflows: ${response.statusText}`);
      }

      const data = await response.json();
      const result = data.results as WorkflowControlResult;

      this.logger.log('Background workflows resumed', {
        triggered: result.triggered?.length ?? 0,
        already_running: result.already_running?.length ?? 0,
        errors: result.errors?.length ?? 0,
      });

      return result;
    } catch (error) {
      this.logger.warn('Failed to resume background work', {
        error: error instanceof Error ? error.message : String(error),
      });

      return { errors: [{ error: String(error) }] };
    }
  }

  /**
   * Schedule background workflows to resume after a delay.
   *
   * Cancels any previously scheduled resume. Useful for ensuring background
   * work resumes after user interaction completes, with appropriate delay for
   * users to continue reading/interacting.
   *
   * @param delayMs - Delay in milliseconds before resuming workflows
   * @param workflowTypes - Optional list of specific workflow types to resume
   */
  scheduleResume(delayMs: number, workflowTypes?: string[]): void {
    // Cancel any previously scheduled resume
    if (this.resumeTimeout) {
      clearTimeout(this.resumeTimeout);
      this.resumeTimeout = null;
    }

    this.logger.log('Scheduling background workflow resume', {
      delayMs,
      delayMinutes: Math.round(delayMs / 60000),
    });

    this.resumeTimeout = setTimeout(() => {
      this.logger.log('Executing scheduled workflow resume');
      this.resumeBackgroundWork(workflowTypes).catch((error) => {
        this.logger.error('Scheduled resume failed', error);
      });
      this.resumeTimeout = null;
    }, delayMs);
  }

  /**
   * Cancel any pending scheduled resume.
   */
  cancelScheduledResume(): void {
    if (this.resumeTimeout) {
      clearTimeout(this.resumeTimeout);
      this.resumeTimeout = null;
      this.logger.log('Cancelled scheduled workflow resume');
    }
  }
}
