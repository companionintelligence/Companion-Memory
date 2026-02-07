/**
 * API Specification Types
 * 
 * Defines the schema for API specifications that describe how to fetch data
 * from provider APIs, including endpoints, parameters, pagination, and rate limits.
 */

/**
 * Parameter specification for API requests
 */
export interface ParamSpec {
  /** Parameter type */
  type: 'static' | 'dynamic' | 'template';
  
  /** Static value */
  value?: string | number | boolean;
  
  /** Source path for dynamic params (e.g., "syncState.lastHistoryId") */
  source?: string;
  
  /** Template string with {{}} placeholders */
  template?: string;
  
  /** Whether this parameter is required */
  required?: boolean;
  
  /** Default value if not provided */
  default?: unknown;
}

/**
 * Pagination configuration
 */
export interface PaginationConfig {
  /** Pagination type */
  type: 'cursor' | 'offset' | 'token';
  
  /** Field in response containing next page token */
  nextTokenField?: string;
  
  /** Query parameter name for page token */
  tokenParam?: string;
  
  /** Query parameter name for limit/page size */
  limitParam?: string;
  
  /** Default limit/page size */
  defaultLimit?: number;
  
  /** Maximum limit/page size */
  maxLimit?: number;
}

/**
 * Rate limiting configuration
 */
export interface RateLimitConfig {
  /** Requests per second */
  requestsPerSecond?: number;
  
  /** Requests per minute */
  requestsPerMinute?: number;
  
  /** Requests per hour */
  requestsPerHour?: number;
  
  /** Requests per day */
  requestsPerDay?: number;
}

/**
 * API endpoint specification
 */
export interface EndpointSpec {
  /** Endpoint name/identifier */
  name: string;
  
  /** HTTP method */
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  
  /** URL path (may include path parameters) */
  path: string;
  
  /** Required OAuth scopes */
  scopes?: string[];
  
  /** Static headers to include */
  headers?: Record<string, string>;
  
  /** Query parameters */
  queryParams?: Record<string, ParamSpec>;
  
  /** Request body template (for POST/PUT/PATCH) */
  bodyTemplate?: string;
  
  /** Response type */
  responseType: 'single' | 'collection';
  
  /** JSON path to data in response (e.g., "messages", "data.items") */
  dataPath?: string;
  
  /** Pagination configuration */
  pagination?: PaginationConfig;
  
  /** Rate limiting */
  rateLimit?: RateLimitConfig;
  
  /** Timeout in milliseconds */
  timeout?: number;
}

/**
 * API metadata configuration
 */
export interface ApiMetadata {
  /** Field name for unique identifier */
  uniquenessField: string;
  
  /** Field name for default display name */
  defaultNameField: string;
  
  /** Endpoint to fetch user profile */
  profileEndpoint: string;
}

/**
 * Complete API specification
 */
export interface ApiSpec {
  /** Unique spec ID */
  id: string;
  
  /** Spec name (e.g., "Google APIs v1") */
  name: string;
  
  /** Base URL for all endpoints */
  baseUrl: string;
  
  /** API version */
  version: string;
  
  /** Metadata configuration */
  meta: ApiMetadata;
  
  /** Endpoint specifications */
  endpoints: Record<string, EndpointSpec>;
  
  /** Global rate limits (applied to all endpoints) */
  globalRateLimit?: RateLimitConfig;
  
  /** Timestamps */
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * DTO for creating a new API specification
 */
export interface CreateApiSpecDto {
  id: string;
  name: string;
  baseUrl: string;
  version: string;
  meta: ApiMetadata;
  endpoints: Record<string, EndpointSpec>;
  globalRateLimit?: RateLimitConfig;
}

/**
 * DTO for updating an API specification
 */
export interface UpdateApiSpecDto {
  name?: string;
  baseUrl?: string;
  version?: string;
  meta?: Partial<ApiMetadata>;
  endpoints?: Record<string, EndpointSpec>;
  globalRateLimit?: RateLimitConfig;
}
