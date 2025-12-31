import { proxyActivities } from '@temporalio/workflow';

import type * as activities from '../activities/inventory.activities';

// Proxy activities with appropriate timeouts
const { analyzeInventoryImage, createInventoryItems } = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  heartbeatTimeout: '30 seconds',
  retry: {
    maximumAttempts: 3,
  },
});

export interface InventoryAnalysisInput {
  userId: string;
  fileId: string;
}

export interface InventoryAnalysisResult {
  itemsCreated: number;
  itemsIdentified: number;
  skipped: boolean;
  reason?: string;
}

/**
 * Workflow that analyzes an uploaded image to identify and catalog inventory items.
 *
 * Runs on MEDIUM priority queue since this is async processing triggered by camera capture.
 * User is not actively waiting for results.
 */
export async function inventoryAnalysisWorkflow(
  input: InventoryAnalysisInput,
): Promise<InventoryAnalysisResult> {
  // Step 1: Analyze image with vision LLM
  const analysisResult = await analyzeInventoryImage({
    userId: input.userId,
    fileId: input.fileId,
  });

  // If no items found or image not valid, skip item creation
  if (analysisResult.skipped || analysisResult.items.length === 0) {
    return {
      itemsCreated: 0,
      itemsIdentified: 0,
      skipped: true,
      reason: analysisResult.reason,
    };
  }

  // Step 2: Create inventory items in database
  const createdItems = await createInventoryItems({
    userId: input.userId,
    fileId: input.fileId,
    items: analysisResult.items,
  });

  return {
    itemsCreated: createdItems.length,
    itemsIdentified: analysisResult.items.length,
    skipped: false,
  };
}
