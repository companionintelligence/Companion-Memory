import { Injectable } from '@nestjs/common';

import type {
  ConnectionEtlAdapter,
  EtlPipelineContext,
  EtlPipelineRunResult,
  ExtractStageResult,
  LoadStageResult,
  TransformStageResult,
} from './types';

@Injectable()
export class ConnectionPipelineOrchestrator {
  async run(
    adapter: ConnectionEtlAdapter,
    context: Omit<EtlPipelineContext, 'startedAt'>,
  ): Promise<EtlPipelineRunResult> {
    const runContext: EtlPipelineContext = {
      ...context,
      startedAt: new Date(),
    };

    const extract = await adapter.extract(runContext);
    const transform = await adapter.transform(runContext, extract);
    const load = await adapter.load(runContext, transform);

    return {
      extract,
      transform,
      load,
      completedAt: new Date(),
    };
  }

  static summarizeExtract(
    records: Array<{ data?: unknown; api?: string; syncState?: Record<string, unknown> }>,
  ): ExtractStageResult {
    const checkpoint: Record<string, unknown> = {};

    const normalizedRecords = records.map((record) => {
      if (record.api && record.syncState) {
        checkpoint[record.api] = record.syncState;
      }

      return {
        stream: record.api ?? 'unknown',
        scope: record.api ?? 'unknown',
        payload: record.data ?? null,
        cursor: record.syncState,
      };
    });

    return {
      records: normalizedRecords,
      checkpoint,
      errors: [],
    };
  }

  static emptyTransform(): TransformStageResult {
    return {
      records: [],
      errors: [],
    };
  }

  static emptyLoad(): LoadStageResult {
    return {
      writtenCount: 0,
      errors: [],
    };
  }

  static buildFallbackContext(
    context: EtlPipelineContext['request'],
    connection: EtlPipelineContext['connection'],
  ): EtlPipelineContext {
    return {
      request: context,
      connection,
      startedAt: new Date(),
    };
  }
}
