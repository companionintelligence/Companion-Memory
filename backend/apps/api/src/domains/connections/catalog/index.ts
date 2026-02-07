import { ACTIVE_PROVIDER_ID_SET, PROVIDER_CATALOG } from './definitions';
import type {
  OAuthCredentialResolution,
  OAuthEnvVarNames,
  ProviderCatalogEntry,
  ProviderLifecycle,
} from './types';

export type {
  OAuthCredentialResolution,
  OAuthEnvVarNames,
  ProviderAuthDefinition,
  ProviderAuthEnvTemplate,
  ProviderAuthType,
  ProviderCatalogEntry,
  ProviderCursorStrategy,
  ProviderDataDomain,
  ProviderLifecycle,
  ProviderOrigin,
  ProviderStreamDefinition,
} from './types';

export function listProviderCatalog(lifecycle?: ProviderLifecycle): ProviderCatalogEntry[] {
  if (!lifecycle) {
    return PROVIDER_CATALOG;
  }

  return PROVIDER_CATALOG.filter((entry) => entry.lifecycle === lifecycle);
}

export function getProviderCatalogByKey(providerKey: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find((entry) => entry.key === providerKey);
}

export function getProviderCatalogByProviderId(providerId: string): ProviderCatalogEntry | undefined {
  if (!ACTIVE_PROVIDER_ID_SET.has(providerId)) {
    return undefined;
  }

  return PROVIDER_CATALOG.find((entry) => entry.providerId === providerId);
}

export function getOAuthEnvVarNames(
  providerId: string,
  providerName: string | null | undefined,
): OAuthEnvVarNames {
  const entry = getProviderCatalogByProviderId(providerId);
  const fallbackPrefix = providerName?.toUpperCase().replace(/[^A-Z0-9]+/g, '_');

  const clientIdVars = new Set<string>();
  const clientSecretVars = new Set<string>();

  if (entry?.auth.env.clientIdVar) {
    clientIdVars.add(entry.auth.env.clientIdVar);
  }

  if (entry?.auth.env.legacyClientIdVar) {
    clientIdVars.add(entry.auth.env.legacyClientIdVar);
  }

  if (fallbackPrefix) {
    clientIdVars.add(`${fallbackPrefix}_CLIENT_ID`);
  }

  if (entry?.auth.env.clientSecretVar) {
    clientSecretVars.add(entry.auth.env.clientSecretVar);
  }

  if (entry?.auth.env.legacyClientSecretVar) {
    clientSecretVars.add(entry.auth.env.legacyClientSecretVar);
  }

  if (fallbackPrefix) {
    clientSecretVars.add(`${fallbackPrefix}_CLIENT_SECRET`);
  }

  return {
    clientIdVars: Array.from(clientIdVars),
    clientSecretVars: Array.from(clientSecretVars),
  };
}

export function resolveOAuthCredentials(
  providerId: string,
  providerName: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): OAuthCredentialResolution {
  const { clientIdVars, clientSecretVars } = getOAuthEnvVarNames(providerId, providerName);

  const clientId = clientIdVars.map((name) => env[name]?.trim()).find(Boolean) ?? null;
  const clientSecret = clientSecretVars.map((name) => env[name]?.trim()).find(Boolean) ?? null;

  return {
    clientIdVars,
    clientSecretVars,
    clientId,
    clientSecret,
  };
}
