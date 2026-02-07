import type {
  ConnectionEtlAdapter,
  EtlPipelineContext,
  ExtractStageResult,
  LoadStageResult,
  TransformStageResult,
} from '../types';

type ScopeKind = 'communication' | 'event' | 'file' | 'person' | 'media' | 'social' | 'content' | 'raw';

type DomainKind = Exclude<ScopeKind, 'raw'>;

type ProviderDataDomain =
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

export interface EtlProviderStreamDefinition {
  key: string;
  displayName: string;
  dataDomain: ProviderDataDomain;
  mapKey?: string;
  scopeAliases?: string[];
}

export interface EtlProviderCatalogEntry {
  key: string;
  streams: EtlProviderStreamDefinition[];
}

export interface AdapterSyncResult {
  api: string;
  data: unknown;
  syncState?: Record<string, unknown>;
}

export interface AdapterSyncResponse {
  success: boolean;
  message: string;
  data?: {
    results?: AdapterSyncResult[];
    errors?: string[];
  };
  cursor?: unknown;
}

const DOMAIN_KIND_MAP: Record<ProviderDataDomain, DomainKind | 'raw'> = {
  communications: 'communication',
  calendar: 'event',
  files: 'file',
  contacts: 'person',
  social: 'social',
  commerce: 'content',
  gaming: 'content',
  productivity: 'content',
  media: 'media',
  activity: 'event',
  system: 'raw',
};

function normalizeScope(scope: string): string {
  return scope
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
}

function toScopeKind(dataDomain: ProviderDataDomain): ScopeKind {
  return DOMAIN_KIND_MAP[dataDomain];
}

function buildScopeKindIndex(
  provider: Pick<EtlProviderCatalogEntry, 'streams'>,
): ReadonlyMap<string, ScopeKind> {
  const scopeKindIndex = new Map<string, ScopeKind>();

  for (const stream of provider.streams) {
    const kind = toScopeKind(stream.dataDomain);
    const candidates = [stream.key, stream.displayName, stream.mapKey, ...(stream.scopeAliases ?? [])].filter(
      (candidate): candidate is string => !!candidate?.trim(),
    );

    for (const candidate of candidates) {
      scopeKindIndex.set(normalizeScope(candidate), kind);
    }
  }

  return scopeKindIndex;
}

abstract class BaseConnectionSyncResponseAdapter implements ConnectionEtlAdapter {
  constructor(
    public readonly providerKey: string,
    protected readonly syncResponses: AdapterSyncResponse[],
  ) {}

  async extract(context: EtlPipelineContext): Promise<ExtractStageResult> {
    void context;

    const checkpoint: Record<string, unknown> = {};
    const errors: string[] = [];
    const records: ExtractStageResult['records'] = [];

    for (const response of this.syncResponses) {
      if (response.cursor) {
        Object.assign(checkpoint, response.cursor as Record<string, unknown>);
      }

      if (response.data?.errors?.length) {
        errors.push(...response.data.errors);
      } else if (!response.success && response.message) {
        errors.push(response.message);
      }

      if (!response.success || !response.data?.results?.length) {
        continue;
      }

      for (const result of response.data.results) {
        records.push({
          stream: result.api,
          scope: result.api,
          payload: result.data,
          cursor: result.syncState,
        });
      }
    }

    return {
      records,
      checkpoint,
      errors,
    };
  }

  async transform(_context: EtlPipelineContext, extract: ExtractStageResult): Promise<TransformStageResult> {
    return {
      records: extract.records.map((record) => ({
        stream: record.stream,
        scope: record.scope,
        kind: this.classifyScope(record.scope),
        payload: record.payload,
      })),
      errors: extract.errors,
    };
  }

  async load(_context: EtlPipelineContext, transform: TransformStageResult): Promise<LoadStageResult> {
    return {
      writtenCount: transform.records.length,
      errors: transform.errors,
    };
  }

  protected abstract classifyScope(scope: string): ScopeKind;
}

export class GenericConnectionEtlAdapter extends BaseConnectionSyncResponseAdapter {
  private readonly scopeKindIndex: ReadonlyMap<string, ScopeKind>;

  constructor(
    providerKey: string,
    syncResponses: AdapterSyncResponse[],
    providerCatalog?: Pick<EtlProviderCatalogEntry, 'streams'>,
  ) {
    super(providerKey, syncResponses);
    this.scopeKindIndex = providerCatalog ? buildScopeKindIndex(providerCatalog) : new Map();
  }

  protected classifyScope(scope: string): ScopeKind {
    return this.scopeKindIndex.get(normalizeScope(scope)) ?? 'raw';
  }
}

export function createConnectionSyncResponseAdapter(
  provider: Pick<EtlProviderCatalogEntry, 'key' | 'streams'> | string,
  syncResponses: AdapterSyncResponse[],
): ConnectionEtlAdapter {
  if (typeof provider === 'string') {
    return new GenericConnectionEtlAdapter(provider, syncResponses);
  }

  return new GenericConnectionEtlAdapter(provider.key, syncResponses, provider);
}
