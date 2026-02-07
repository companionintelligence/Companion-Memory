/**
 * Provider Configuration Types
 * 
 * Defines the schema for provider configurations that specify what data sources
 * are available from each API provider and their default settings.
 */

/**
 * OAuth configuration for a provider
 */
export interface OAuthConfig {
  /** OAuth version */
  type: 'oauth1' | 'oauth2' | 'api_key';
  
  /** Authorization endpoint URL */
  authorizationUrl: string;
  
  /** Token exchange endpoint URL */
  tokenUrl: string;
  
  /** Default OAuth scopes */
  scopes: string[];
  
  /** Additional parameters for authorization request */
  extraParams?: Record<string, string>;
}

/**
 * A data source from a provider (e.g., Gmail, Calendar)
 */
export interface ProviderSource {
  /** Display name */
  name: string;
  
  /** Human-readable description */
  description: string;
  
  /** Whether this source is enabled by default */
  enabledByDefault: boolean;
  
  /** Which API endpoints to call for this source */
  endpoints: string[];
  
  /** OAuth scopes required for this source */
  scopes: string[];
  
  /** Transform map ID to use for normalizing this data */
  transformMap: string;
}

/**
 * Provider theme/branding configuration
 */
export interface ProviderTheme {
  backgroundColor: string | null;
  borderColor: string | null;
}

/**
 * Complete provider configuration
 */
export interface ProviderConfig {
  /** Unique provider ID (UUID) */
  id: string;
  
  /** Display name (e.g., "Google", "Microsoft") */
  name: string;
  
  /** Human-readable description */
  description: string | null;
  
  /** URL to provider logo */
  logoUrl: string | null;
  
  /** Theme colors for UI */
  theme: ProviderTheme;
  
  /** Data sources available from this provider */
  sources: ProviderSource[];
  
  /** OAuth configuration */
  auth: OAuthConfig;
  
  /** Reference to API specification document */
  apiSpecId: string;
  
  /** Whether this provider is enabled */
  enabled: boolean;
  
  /** Timestamps */
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * DTO for creating a new provider configuration
 */
export interface CreateProviderConfigDto {
  id: string;
  name: string;
  description?: string;
  logoUrl?: string;
  theme?: Partial<ProviderTheme>;
  sources: ProviderSource[];
  auth: OAuthConfig;
  apiSpecId: string;
  enabled?: boolean;
}

/**
 * DTO for updating a provider configuration
 */
export interface UpdateProviderConfigDto {
  name?: string;
  description?: string;
  logoUrl?: string;
  theme?: Partial<ProviderTheme>;
  sources?: ProviderSource[];
  auth?: Partial<OAuthConfig>;
  apiSpecId?: string;
  enabled?: boolean;
}
