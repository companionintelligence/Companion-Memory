import type { RequestContext } from '@ci/common/context';

export interface EtlPipelineConnection {
  id: string;
  providerId: string;
  userId: string;
  activeEndpoints: string[];
  syncState: Record<string, unknown> | null;
}

export interface EtlPipelineContext {
  request: RequestContext;
  connection: EtlPipelineConnection;
  startedAt: Date;
}

export interface EtlExtractRecord {
  stream: string;
  scope: string;
  payload: unknown;
  cursor?: Record<string, unknown>;
}

export interface EtlCanonicalRecord {
  stream: string;
  scope: string;
  kind: string;
  payload: unknown;
  metadata?: Record<string, unknown>;
}

export interface ExtractStageResult {
  records: EtlExtractRecord[];
  checkpoint: Record<string, unknown>;
  errors: string[];
}

export interface TransformStageResult {
  records: EtlCanonicalRecord[];
  errors: string[];
}

export interface LoadStageResult {
  writtenCount: number;
  errors: string[];
}

export interface EtlPipelineRunResult {
  extract: ExtractStageResult;
  transform: TransformStageResult;
  load: LoadStageResult;
  completedAt: Date;
}

export interface ConnectionEtlAdapter {
  providerKey: string;
  extract(context: EtlPipelineContext): Promise<ExtractStageResult>;
  transform(context: EtlPipelineContext, extract: ExtractStageResult): Promise<TransformStageResult>;
  load(context: EtlPipelineContext, transform: TransformStageResult): Promise<LoadStageResult>;
}
