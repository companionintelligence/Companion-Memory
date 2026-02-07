/**
 * Transform Map Types
 * 
 * Defines the schema for transform maps that specify how to normalize
 * provider data into our internal schema.
 */

/**
 * Type transformation configuration
 */
export interface TypeTransform {
  /** Target type */
  type: 'date' | 'number' | 'boolean' | 'json' | 'string' | 'custom';
  
  /** Format for dates (e.g., "iso8601", "unix", "unix_ms") */
  format?: string;
  
  /** Custom transformer function name */
  customFn?: string;
  
  /** Additional options */
  options?: Record<string, unknown>;
}

/**
 * Computed field configuration
 */
export interface ComputedField {
  /** Function name to execute */
  function: string;
  
  /** Input field paths */
  inputs: string[];
  
  /** Additional parameters */
  params?: Record<string, unknown>;
}

/**
 * Field mapping specification
 */
export interface FieldMapping {
  /** Mapping type */
  type: 'direct' | 'nested' | 'computed' | 'template' | 'constant';
  
  /** Source field path for direct mapping */
  source?: string;
  
  /** JSON path for nested extraction (supports array notation) */
  path?: string;
  
  /** Computed field configuration */
  compute?: ComputedField;
  
  /** Template string with {{}} placeholders */
  template?: string;
  
  /** Constant value */
  constantValue?: unknown;
  
  /** Type transformation */
  transform?: TypeTransform;
  
  /** Default value if source is null/undefined */
  default?: unknown;
  
  /** Whether this field is required */
  required?: boolean;
  
  /** Whether to skip null values */
  skipNull?: boolean;
}

/**
 * Transform map metadata
 */
export interface TransformMapMetadata {
  /** Author/creator */
  author?: string;
  
  /** Version number */
  version?: string;
  
  /** Tags for categorization */
  tags?: string[];
  
  /** Notes or comments */
  notes?: string;
}

/**
 * Complete transform map
 */
export interface TransformMap {
  /** Unique map ID */
  id: string;
  
  /** Display name */
  name: string;
  
  /** Description of what this map does */
  description: string;
  
  /** Source data type/schema name */
  sourceType: string;
  
  /** Target data type/schema name */
  targetType: string;
  
  /** Field mappings: target field name → mapping spec */
  fields: Record<string, FieldMapping>;
  
  /** Custom transformer function names used */
  transformers?: string[];
  
  /** Metadata */
  metadata?: TransformMapMetadata;
  
  /** Whether this map is enabled */
  enabled: boolean;
  
  /** Timestamps */
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * DTO for creating a new transform map
 */
export interface CreateTransformMapDto {
  id: string;
  name: string;
  description: string;
  sourceType: string;
  targetType: string;
  fields: Record<string, FieldMapping>;
  transformers?: string[];
  metadata?: TransformMapMetadata;
  enabled?: boolean;
}

/**
 * DTO for updating a transform map
 */
export interface UpdateTransformMapDto {
  name?: string;
  description?: string;
  sourceType?: string;
  targetType?: string;
  fields?: Record<string, FieldMapping>;
  transformers?: string[];
  metadata?: Partial<TransformMapMetadata>;
  enabled?: boolean;
}

/**
 * Result of applying a transform
 */
export interface TransformResult<T = unknown> {
  /** Transformed data */
  data: T;
  
  /** Whether transformation was successful */
  success: boolean;
  
  /** Errors encountered during transformation */
  errors?: string[];
  
  /** Warnings (non-fatal issues) */
  warnings?: string[];
  
  /** Fields that were skipped */
  skipped?: string[];
}
