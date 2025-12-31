import { Context } from '@temporalio/activity';
import { z } from 'zod';

import { toServiceContext } from '@ci/common/context';
import type { FileService } from '@ci/domains/files';
import type { OllamaService } from '@ci/domains/llm/services/OllamaService';
import type { ItemService, InventoryCondition } from '@ci/domains/memory';

// Services will be injected by the worker
let fileService: FileService;
let itemService: ItemService;
let ollamaService: OllamaService;

export function setServices(services: {
  fileService: FileService;
  itemService: ItemService;
  ollamaService: OllamaService;
}) {
  fileService = services.fileService;
  itemService = services.itemService;
  ollamaService = services.ollamaService;
}

const ItemAnalysisSchema = z.object({
  name: z.string().nullable(),
  description: z.string().nullable(),
  category: z.string().nullable(),
  brand: z.string().nullable(),
  model: z.string().nullable(),
  condition: z.string().nullable(),
  estimated_value: z.number(),
});

const AnalysisResponseSchema = z.object({
  items: z.array(ItemAnalysisSchema),
});

type ItemAnalysis = z.infer<typeof ItemAnalysisSchema>;

const PROMPT = `
  Analyze this image and identify all distinct objects visible.
  You are a JSON generator. Output ONLY valid JSON.
  Do not include any conversational text, markdown formatting, or explanations.

  If the image is too dark, blurry, or contains no distinct objects, return an empty array for "items".

  Return a JSON object with the following schema:
  {
    "items": [
      {
        "name": "Short name of the item",
        "description": "Brief description",
        "category": "General category (e.g., Electronics, Furniture, Tools)",
        "brand": "Brand name if visible, or null",
        "model": "Model if visible, or null",
        "condition": "Estimated condition (new, good, fair, poor)",
        "estimated_value": 0
      }
    ]
  }

  For estimated_value, provide a rough number in USD based on visual condition. If unknown, use 0.
`;

export interface AnalyzeImageInput {
  userId: string;
  fileId: string;
}

export interface AnalyzeImageResult {
  items: ItemAnalysis[];
  skipped: boolean;
  reason?: string;
}

export interface CreateItemsInput {
  userId: string;
  fileId: string;
  items: ItemAnalysis[];
}

export interface CreatedItem {
  id: string;
  name: string;
}

/**
 * Activity that analyzes an image using a vision-capable LLM to identify inventory items.
 *
 * Uses heartbeats to track progress during LLM call.
 */
export async function analyzeInventoryImage(input: AnalyzeImageInput): Promise<AnalyzeImageResult> {
  const context = Context.current();

  context.heartbeat('Fetching file from database');

  const serviceContext = toServiceContext({
    userId: input.userId,
  });

  // Fetch file
  const file = await fileService.findById(serviceContext, input.fileId);

  if (file == null) {
    return {
      items: [],
      skipped: true,
      reason: 'File not found',
    };
  }

  // Validate it's an image
  if (file.contentType == null || !file.contentType.startsWith('image/')) {
    await fileService.update(serviceContext, input.fileId, {
      analysisCompleted: true,
    });

    return {
      items: [],
      skipped: true,
      reason: 'Not an image file',
    };
  }

  if (file.key == null) {
    return {
      items: [],
      skipped: true,
      reason: 'File has no storage key',
    };
  }

  context.heartbeat('Retrieving file content from storage');

  // Get file content
  const fileContent = await fileService.getFileContent(serviceContext, file.key);
  const base64Image = Buffer.from(fileContent).toString('base64');

  context.heartbeat('Selecting vision-capable model');

  // Get vision-capable model
  // Try user's configured model first, fallback to auto-select
  let model: string;
  try {
    const modelResult = await ollamaService.resolveModel(serviceContext, {
      messages: [
        {
          role: 'user',
          content: 'test',
          images: [base64Image],
        },
      ],
    });
    model = modelResult.model;
  } catch {
    // If configured model doesn't support vision, let Ollama pick one
    const models = await ollamaService.getAvailableModels(serviceContext);
    const visionModel = models.find((m) => m.name.includes('vision') || m.name.includes('llava'));

    if (!visionModel) {
      await fileService.update(serviceContext, input.fileId, {
        analysisCompleted: true,
      });

      return {
        items: [],
        skipped: true,
        reason: 'No vision-capable model available',
      };
    }

    model = visionModel.name;
  }

  context.heartbeat(`Calling vision LLM (${model})`);

  // Call LLM with vision
  const response = await ollamaService.chat(
    serviceContext,
    [
      {
        role: 'user',
        content: PROMPT,
        images: [base64Image],
      },
    ],
    {
      model,
      enableTools: false,
      format: 'json',
    },
  );

  context.heartbeat('Parsing LLM response');

  const content = response.message.content;
  const items = parseAndValidateAnalysis(content);

  context.heartbeat(`Identified ${items.length} items`);

  return {
    items,
    skipped: false,
  };
}

/**
 * Activity that creates inventory items in the database.
 *
 * Uses heartbeats to track progress through batch creation.
 */
export async function createInventoryItems(input: CreateItemsInput): Promise<CreatedItem[]> {
  const context = Context.current();

  context.heartbeat(`Creating ${input.items.length} inventory items`);

  const serviceContext = toServiceContext({
    userId: input.userId,
  });

  const createdItems: CreatedItem[] = [];

  for (const itemData of input.items) {
    const condition = itemData.condition?.toLowerCase() ?? 'good';

    const item = await itemService.create(serviceContext, {
      name: itemData.name || 'Unknown Item',
      description: itemData.description ?? undefined,
      category: itemData.category ?? undefined,
      brand: itemData.brand ?? undefined,
      model: itemData.model ?? undefined,
      condition: ['new', 'like_new', 'good', 'fair', 'poor', 'broken', 'n/a'].includes(condition)
        ? (condition as InventoryCondition)
        : 'good',
      currentValue: itemData.estimated_value,
      metadata: {
        original_analysis: itemData,
        captured_at: new Date(),
        source_file_id: input.fileId,
      },
    });

    createdItems.push({
      id: item.id,
      name: item.name,
    });

    context.heartbeat(`Created ${createdItems.length}/${input.items.length} items`);
  }

  // Mark file as analysis completed
  await fileService.update(serviceContext, input.fileId, {
    analysisCompleted: true,
  });

  context.heartbeat('All items created, file marked complete');

  return createdItems;
}

/**
 * Parse and validate LLM JSON response.
 */
function parseAndValidateAnalysis(content: string): ItemAnalysis[] {
  let jsonStr = content.replace(/```json\n?|\n?```/g, '').trim();

  const firstOpen = jsonStr.indexOf('{');
  const lastClose = jsonStr.lastIndexOf('}');

  if (firstOpen !== -1 && lastClose !== -1) {
    jsonStr = jsonStr.substring(firstOpen, lastClose + 1);
  }

  try {
    const validationResult = AnalysisResponseSchema.safeParse(JSON.parse(jsonStr));

    if (!validationResult.success) {
      console.error('LLM response failed schema validation', validationResult.error);

      return [];
    }

    return validationResult.data.items;
  } catch (error) {
    console.error('Failed to parse JSON from LLM response', error);

    return [];
  }
}
