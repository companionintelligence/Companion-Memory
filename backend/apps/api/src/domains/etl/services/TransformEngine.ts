import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';

import type { TransformMap, FieldMapping, TransformResult } from '../types/transform';
import { getTransformer } from '../transformers';

/**
 * TransformEngine handles data transformation using transform maps.
 * It applies field mappings to convert provider data into our internal schema.
 */
@Injectable()
export class TransformEngine {
  constructor(private readonly logger: LoggerService) {
    this.logger.setContext(TransformEngine.name);
  }

  /**
   * Transform an array of items using a transform map
   */
  async transform<T = unknown>(rawData: unknown[], transformMap: TransformMap): Promise<TransformResult<T[]>> {
    this.logger.log(`Transforming ${rawData.length} items using map: ${transformMap.name}`);

    const transformedData: T[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];
    const skipped: string[] = [];

    for (const item of rawData) {
      try {
        const transformed = this.transformItem(item, transformMap);
        transformedData.push(transformed as T);
      } catch (error) {
        errors.push(`Transform error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    return {
      data: transformedData,
      success: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
      skipped: skipped.length > 0 ? skipped : undefined,
    };
  }

  /**
   * Transform a single item
   */
  private transformItem(item: unknown, transformMap: TransformMap): unknown {
    const result: Record<string, unknown> = {};

    for (const [targetField, mapping] of Object.entries(transformMap.fields)) {
      try {
        const value = this.applyMapping(item, mapping);
        if (value !== undefined || !mapping.skipNull) {
          result[targetField] = value;
        }
      } catch (error) {
        if (mapping.required) {
          throw new Error(`Required field ${targetField} failed: ${error}`);
        }
        if (mapping.default !== undefined) {
          result[targetField] = mapping.default;
        }
      }
    }

    return result;
  }

  /**
   * Apply a field mapping to extract/compute a value
   */
  private applyMapping(item: unknown, mapping: FieldMapping): unknown {
    let value: unknown;

    switch (mapping.type) {
      case 'direct':
        value = this.applyDirectMapping(item, mapping);
        break;
      case 'nested':
        value = this.applyNestedMapping(item, mapping);
        break;
      case 'computed':
        value = this.applyComputedMapping(item, mapping);
        break;
      case 'template':
        value = this.applyTemplateMapping(item, mapping);
        break;
      case 'constant':
        value = mapping.constantValue;
        break;
      default:
        throw new Error(`Unknown mapping type: ${(mapping as FieldMapping).type}`);
    }

    // Apply type transformation if specified
    if (mapping.transform && value !== null && value !== undefined) {
      value = this.applyTypeTransform(value, mapping);
    }

    return value;
  }

  /**
   * Direct field mapping
   */
  private applyDirectMapping(item: unknown, mapping: FieldMapping): unknown {
    if (!mapping.source) {
      return mapping.default;
    }

    const obj = item as Record<string, unknown>;
    return obj[mapping.source];
  }

  /**
   * Nested path mapping with array support
   */
  private applyNestedMapping(item: unknown, mapping: FieldMapping): unknown {
    if (!mapping.path) {
      return mapping.default;
    }

    return this.extractNestedValue(item, mapping.path);
  }

  /**
   * Extract value from nested path
   * Supports: "field.subfield", "array[0]", "array[name=value]"
   */
  private extractNestedValue(obj: unknown, path: string): unknown {
    if (!obj || typeof obj !== 'object') {
      return undefined;
    }

    const parts = path.split('.');
    let current: unknown = obj;

    for (const part of parts) {
      if (current === null || current === undefined) {
        return undefined;
      }

      // Handle array access: array[0] or array[name=value]
      const arrayMatch = part.match(/^([^[]+)\[(.+)\]$/);
      if (arrayMatch) {
        const [, arrayName, selector] = arrayMatch;
        const arrayObj = (current as Record<string, unknown>)[arrayName];

        if (!Array.isArray(arrayObj)) {
          return undefined;
        }

        // Numeric index: array[0]
        if (/^\d+$/.test(selector)) {
          const index = parseInt(selector, 10);
          current = arrayObj[index];
        }
        // Property match: array[name=value]
        else {
          const [propName, propValue] = selector.split('=');
          const found = arrayObj.find((item: unknown) => {
            if (typeof item === 'object' && item !== null) {
              return (item as Record<string, unknown>)[propName] === propValue;
            }
            return false;
          });
          current = found;
        }
      } else {
        current = (current as Record<string, unknown>)[part];
      }
    }

    return current;
  }

  /**
   * Computed field mapping
   */
  private applyComputedMapping(item: unknown, mapping: FieldMapping): unknown {
    if (!mapping.compute) {
      return mapping.default;
    }

    const { function: fnName, inputs, params } = mapping.compute;

    // Get the transformer function
    const transformer = getTransformer(fnName);
    if (!transformer) {
      throw new Error(`Transformer function not found: ${fnName}`);
    }

    // Extract input values
    const inputValues = inputs.map((inputPath) => {
      // Input can be a field path or direct reference
      if (inputPath.includes('.') || inputPath.includes('[')) {
        return this.extractNestedValue(item, inputPath);
      } else {
        return (item as Record<string, unknown>)[inputPath];
      }
    });

    // For single input, pass the value directly
    // For multiple inputs, pass as array
    const input = inputValues.length === 1 ? inputValues[0] : inputValues;

    // Execute the transformer
    return transformer(input, params);
  }

  /**
   * Template-based mapping
   */
  private applyTemplateMapping(item: unknown, mapping: FieldMapping): unknown {
    if (!mapping.template) {
      return mapping.default;
    }

    return this.renderTemplate(mapping.template, item);
  }

  /**
   * Render template with variable substitution
   * Supports: {{ field }}, {{ field.subfield }}, {{ field[0] }}
   */
  private renderTemplate(template: string, context: unknown): string {
    return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (match, path) => {
      const value = this.extractNestedValue(context, path.trim());
      return value !== null && value !== undefined ? String(value) : '';
    });
  }

  /**
   * Apply type transformation
   */
  private applyTypeTransform(value: unknown, mapping: FieldMapping): unknown {
    if (!mapping.transform) {
      return value;
    }

    const { type, format, customFn } = mapping.transform;

    switch (type) {
      case 'date':
        return this.transformToDate(value, format);

      case 'number':
        return this.transformToNumber(value);

      case 'boolean':
        return this.transformToBoolean(value);

      case 'string':
        return String(value);

      case 'json':
        return this.transformToJson(value);

      case 'custom':
        if (customFn) {
          const transformer = getTransformer(customFn);
          if (transformer) {
            return transformer(value);
          }
        }
        return value;

      default:
        return value;
    }
  }

  /**
   * Transform value to Date
   */
  private transformToDate(value: unknown, format?: string): Date | null {
    if (value === null || value === undefined) {
      return null;
    }

    if (value instanceof Date) {
      return value;
    }

    const strValue = String(value);

    // Handle Unix timestamps
    if (format === 'unix') {
      const timestamp = parseInt(strValue, 10);
      return new Date(timestamp * 1000);
    }

    if (format === 'unix_ms') {
      const timestamp = parseInt(strValue, 10);
      return new Date(timestamp);
    }

    // Try to parse as ISO or standard date string
    try {
      const date = new Date(strValue);
      return isNaN(date.getTime()) ? null : date;
    } catch {
      return null;
    }
  }

  /**
   * Transform value to number
   */
  private transformToNumber(value: unknown): number | null {
    if (value === null || value === undefined) {
      return null;
    }

    if (typeof value === 'number') {
      return value;
    }

    const num = Number(value);
    return isNaN(num) ? null : num;
  }

  /**
   * Transform value to boolean
   */
  private transformToBoolean(value: unknown): boolean {
    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'string') {
      const lower = value.toLowerCase();
      return lower === 'true' || lower === '1' || lower === 'yes';
    }

    return Boolean(value);
  }

  /**
   * Transform value to JSON
   */
  private transformToJson(value: unknown): unknown {
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return value;
  }
}
