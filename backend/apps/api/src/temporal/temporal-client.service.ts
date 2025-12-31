import { Injectable, OnModuleInit, OnModuleDestroy, Inject, forwardRef } from '@nestjs/common';
import { Client, WorkflowHandle } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';

import { LoggerService } from '@ci/common/logging';
import { MessageService } from '@ci/domains/conversations';
import { FileService } from '@ci/domains/files';
import { OllamaService } from '@ci/domains/llm/services/OllamaService';
import { ItemService } from '@ci/domains/memory';

import * as chatActivities from './activities/chat.activities';
import * as inventoryActivities from './activities/inventory.activities';
import type { InventoryAnalysisInput } from './workflows/inventory-analysis.workflow';
import { inventoryAnalysisWorkflow } from './workflows/inventory-analysis.workflow';
import type { SaveChatMessagesInput } from './workflows/save-chat-messages.workflow';
import { saveChatMessagesWorkflow } from './workflows/save-chat-messages.workflow';

/**
 * Service for interacting with Temporal workflows.
 *
 * Manages both the Temporal client (for starting workflows) and worker (for executing them)
 * in the same process as the API.
 */
@Injectable()
export class TemporalClientService implements OnModuleInit, OnModuleDestroy {
  private client: Client | null = null;

  private worker: Worker | null = null;

  constructor(
    private readonly logger: LoggerService,
    private readonly messageService: MessageService,
    private readonly fileService: FileService,
    private readonly itemService: ItemService,
    @Inject(forwardRef(() => OllamaService))
    private readonly ollamaService: OllamaService,
  ) {
    this.logger.setContext(TemporalClientService.name);
  }

  async onModuleInit() {
    try {
      // Create connection
      const connection = await NativeConnection.connect({
        address: process.env.TEMPORAL_ADDRESS || 'temporal:7233',
      });

      this.logger.log('Connected to Temporal server', {
        address: process.env.TEMPORAL_ADDRESS || 'temporal:7233',
      });

      // Create client
      this.client = new Client({
        connection,
        namespace: process.env.TEMPORAL_NAMESPACE || 'default',
      });

      // Inject services into activities
      inventoryActivities.setServices({
        fileService: this.fileService,
        itemService: this.itemService,
        ollamaService: this.ollamaService,
      });

      chatActivities.setMessageService(this.messageService);

      // Combine all activities
      const activities = {
        ...inventoryActivities,
        ...chatActivities,
      };

      // Create and start worker in the same process
      // Worker handles both inventory (MEDIUM queue) and chat (HIGH queue) workflows
      this.worker = await Worker.create({
        connection,
        namespace: process.env.TEMPORAL_NAMESPACE || 'default',
        taskQueue: process.env.TEMPORAL_TASK_QUEUE_MEDIUM || 'medium',
        workflowsPath: require.resolve('./workflows'),
        activities,
        maxConcurrentActivityTaskExecutions: 3, // MEDIUM queue concurrency
      });

      this.logger.log('Temporal worker created', {
        taskQueue: process.env.TEMPORAL_TASK_QUEUE_MEDIUM || 'medium',
        workflows: ['inventoryAnalysisWorkflow', 'saveChatMessagesWorkflow'],
      });

      // Run worker in background (non-blocking)
      this.worker.run().catch((error) => {
        this.logger.error('Temporal worker error', error as Error);
      });

      this.logger.log('Temporal worker started');
    } catch (error) {
      this.logger.error('Failed to initialize Temporal client/worker', error as Error);
      // Don't fail app startup if Temporal is unavailable
    }
  }

  async onModuleDestroy() {
    if (this.worker) {
      this.logger.log('Shutting down Temporal worker');
      await this.worker.shutdown();
    }
  }

  /**
   * Start an inventory analysis workflow for an uploaded image.
   *
   * @param input - User ID and file ID
   * @returns Workflow handle
   */
  async startInventoryAnalysis(
    input: InventoryAnalysisInput,
  ): Promise<WorkflowHandle<typeof inventoryAnalysisWorkflow> | null> {
    if (!this.client) {
      this.logger.error('Temporal client not initialized');

      return null;
    }

    try {
      const workflowId = `inventory-${input.userId}-${input.fileId}`;

      const handle = await this.client.workflow.start(inventoryAnalysisWorkflow, {
        taskQueue: process.env.TEMPORAL_TASK_QUEUE_MEDIUM || 'medium',
        args: [input],
        workflowId,
      });

      this.logger.log('Started inventory analysis workflow', {
        workflowId,
        userId: input.userId,
        fileId: input.fileId,
      });

      return handle;
    } catch (error) {
      this.logger.error('Failed to start inventory analysis workflow', {
        error: error instanceof Error ? error.message : String(error),
        userId: input.userId,
        fileId: input.fileId,
      });

      return null;
    }
  }

  /**
   * Start a workflow to save chat messages after streaming completes.
   *
   * @param input - Thread ID and messages
   * @returns Workflow handle
   */
  async startSaveChatMessages(
    input: SaveChatMessagesInput,
  ): Promise<WorkflowHandle<typeof saveChatMessagesWorkflow> | null> {
    if (!this.client) {
      this.logger.error('Temporal client not initialized');

      return null;
    }

    try {
      const workflowId = `chat-save-${input.threadId}-${Date.now()}`;

      const handle = await this.client.workflow.start(saveChatMessagesWorkflow, {
        taskQueue: process.env.TEMPORAL_TASK_QUEUE_MEDIUM || 'medium',
        args: [input],
        workflowId,
      });

      this.logger.log('Started chat message save workflow', {
        workflowId,
        threadId: input.threadId,
      });

      return handle;
    } catch (error) {
      this.logger.error('Failed to start chat message save workflow', {
        error: error instanceof Error ? error.message : String(error),
        threadId: input.threadId,
      });

      return null;
    }
  }
}
