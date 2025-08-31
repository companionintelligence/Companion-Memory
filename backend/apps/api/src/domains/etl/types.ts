// ETL V2 Types
export interface ApiEndpointConfig {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly endpoint: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly headers?: Record<string, string>;
  readonly queryParams?: Record<string, string>;
  readonly rateLimit?: {
    requests: number;
    window: number; // in seconds
  };
  readonly pagination?: {
    type: 'offset' | 'cursor' | 'page';
    param: string;
    limit?: number;
  };
  readonly dependencies?: string[]; // other endpoint IDs this depends on
}

export interface EtlTransformMap {
  readonly id: string;
  readonly name: string;
  readonly sourceEndpoint: string;
  readonly targetSchema: string;
  readonly transformations: EtlTransformation[];
}

export interface EtlTransformation {
  readonly type: 'map' | 'filter' | 'transform' | 'aggregate' | 'join';
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly operation?: string;
  readonly params?: Record<string, unknown>;
}

export interface EtlJob {
  readonly id: string;
  readonly connectionId: string;
  readonly endpointConfigId: string;
  readonly transformMapId?: string;
  readonly schedule?: string; // cron expression
  readonly enabled: boolean;
  readonly lastRun?: Date;
  readonly nextRun?: Date;
  readonly status: 'idle' | 'running' | 'success' | 'error';
  readonly metadata?: Record<string, unknown>;
}

export interface EtlCollectionResult {
  readonly jobId: string;
  readonly endpointId: string;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
  readonly recordsProcessed: number;
  readonly timestamp: Date;
}

// Queue types extending the existing queue system
export enum EtlQueues {
  DATA_COLLECTION = 'etl.data.collection',
  TRANSFORM = 'etl.transform',
  SCHEDULE = 'etl.schedule',
}

export interface DataCollectionPayload {
  jobId: string;
  connectionId: string;
  endpointConfigId: string;
}

export interface TransformPayload {
  jobId: string;
  transformMapId: string;
  sourceData: unknown;
}

export interface SchedulePayload {
  jobId: string;
}