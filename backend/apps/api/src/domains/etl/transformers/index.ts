/**
 * Custom transformer functions for data transformation.
 * These are referenced by name in transform maps.
 */

export interface TransformerFunction {
  (input: unknown, params?: Record<string, unknown>): unknown;
}

/**
 * Registry of all transformer functions
 */
export const transformerRegistry = new Map<string, TransformerFunction>();

/**
 * Register a transformer function
 */
export function registerTransformer(name: string, fn: TransformerFunction): void {
  transformerRegistry.set(name, fn);
}

/**
 * Get a transformer function by name
 */
export function getTransformer(name: string): TransformerFunction | undefined {
  return transformerRegistry.get(name);
}

/**
 * Execute a transformer function
 */
export function executeTransformer(
  name: string,
  input: unknown,
  params?: Record<string, unknown>,
): unknown {
  const transformer = getTransformer(name);
  if (!transformer) {
    throw new Error(`Transformer not found: ${name}`);
  }
  return transformer(input, params);
}

// Import and register all transformers
import * as emailTransformers from './email';
import * as calendarTransformers from './calendar';
import * as fileTransformers from './file';

// Register email transformers
registerTransformer('extractEmailBody', emailTransformers.extractEmailBody);
registerTransformer('extractEmailRecipients', emailTransformers.extractEmailRecipients);
registerTransformer('parseEmailHeaders', emailTransformers.parseEmailHeaders);
registerTransformer('extractEmailSender', emailTransformers.extractEmailSender);

// Register calendar transformers
registerTransformer('parseRecurrenceRule', calendarTransformers.parseRecurrenceRule);
registerTransformer('extractAttendees', calendarTransformers.extractAttendees);
registerTransformer('parseCalendarDateTime', calendarTransformers.parseCalendarDateTime);
registerTransformer('extractEventDuration', calendarTransformers.extractEventDuration);

// Register file transformers
registerTransformer('extractFileMetadata', fileTransformers.extractFileMetadata);
registerTransformer('generateThumbnailUrl', fileTransformers.generateThumbnailUrl);
registerTransformer('formatFileSize', fileTransformers.formatFileSize);
registerTransformer('categorizeFile', fileTransformers.categorizeFile);
registerTransformer('extractFileExtension', fileTransformers.extractFileExtension);

// Export transformer modules
export * from './email';
export * from './calendar';
export * from './file';
