export type ProviderLifecycle = 'active' | 'planned';

export type ProviderAuthType = 'oauth2' | 'oauth1' | 'apikey' | 'bearer' | 'openid' | 'none' | 'unknown';

export type ProviderOrigin = 'implemented' | 'connections_page' | 'lifescope_legacy';

export type ProviderCursorStrategy = 'none' | 'token' | 'timestamp' | 'url' | 'composite';

export type ProviderDataDomain =
  | 'communications'
  | 'calendar'
  | 'files'
  | 'contacts'
  | 'social'
  | 'commerce'
  | 'gaming'
  | 'productivity'
  | 'media'
  | 'activity'
  | 'system';

export interface ProviderAuthEnvTemplate {
  modeVar: string;
  clientIdVar?: string;
  clientSecretVar?: string;
  legacyClientIdVar?: string;
  legacyClientSecretVar?: string;
  testAccessTokenVar?: string;
  testRefreshTokenVar?: string;
  mockBaseUrlVar?: string;
}

export interface ProviderAuthDefinition {
  type: ProviderAuthType;
  env: ProviderAuthEnvTemplate;
}

export interface ProviderStreamDefinition {
  key: string;
  displayName: string;
  description: string;
  dataDomain: ProviderDataDomain;
  defaultEnabled: boolean;
  requiredScopes: string[];
  cursorStrategy: ProviderCursorStrategy;
  mapKey?: string;
  scopeAliases?: string[];
}

export interface ProviderCatalogEntry {
  key: string;
  displayName: string;
  lifecycle: ProviderLifecycle;
  origin: ProviderOrigin;
  providerId?: string;
  auth: ProviderAuthDefinition;
  streams: ProviderStreamDefinition[];
}

export interface OAuthEnvVarNames {
  clientIdVars: string[];
  clientSecretVars: string[];
}

export interface OAuthCredentialResolution extends OAuthEnvVarNames {
  clientId: string | null;
  clientSecret: string | null;
}
