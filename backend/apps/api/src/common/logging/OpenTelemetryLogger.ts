import type { SeverityNumber } from '@opentelemetry/api-logs';
import { logs as logsApi } from '@opentelemetry/api-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';

type PrimitiveAttribute = boolean | number | string;
type PrimitiveAttributeList = PrimitiveAttribute[];
type OpenTelemetryAttributeValue = PrimitiveAttribute | PrimitiveAttributeList;

type LogLevel = 'debug' | 'error' | 'info' | 'warn';

export interface OpenTelemetryLogParams {
  obj: Record<string, unknown>;
  msg?: string;
}

export interface OpenTelemetryLoggerConfig {
  enabled: boolean;
  serviceName: string;
  endpoint?: string;
  logsEndpoint?: string;
}

interface OpenTelemetryLogRecord {
  attributes: Record<string, OpenTelemetryAttributeValue>;
  body: string;
  severityNumber: SeverityNumber;
  severityText: Uppercase<LogLevel>;
}

export interface OpenTelemetryLogBridge {
  emit(level: LogLevel, params: OpenTelemetryLogParams): void;
  endpoint?: string;
  enabled: boolean;
  shutdown(): Promise<void>;
}

const SEVERITY_NUMBER_BY_LEVEL: Record<LogLevel, SeverityNumber> = {
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
};

const isPrimitiveAttribute = (value: unknown): value is PrimitiveAttribute =>
  typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string';

const isPrimitiveAttributeList = (value: unknown): value is PrimitiveAttributeList =>
  Array.isArray(value) && value.every(isPrimitiveAttribute);

const stringifyAttribute = (value: unknown) => {
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const toAttributeValue = (value: unknown): OpenTelemetryAttributeValue => {
  if (isPrimitiveAttribute(value) || isPrimitiveAttributeList(value)) {
    return value;
  }

  return stringifyAttribute(value);
};

const toBody = (params: OpenTelemetryLogParams) => {
  if (params.msg) {
    return params.msg;
  }

  if ('data' in params.obj) {
    return stringifyAttribute(params.obj['data']);
  }

  if ('err' in params.obj) {
    return stringifyAttribute(params.obj['err']);
  }

  return 'log';
};

export const normalizeOpenTelemetryLogsEndpoint = ({
  endpoint,
  logsEndpoint,
}: Pick<OpenTelemetryLoggerConfig, 'endpoint' | 'logsEndpoint'>) => {
  const preferredEndpoint = logsEndpoint?.trim();

  if (preferredEndpoint) {
    return preferredEndpoint;
  }

  const baseEndpoint = endpoint?.trim().replace(/\/+$/, '');

  if (!baseEndpoint) {
    return undefined;
  }

  return `${baseEndpoint}/v1/logs`;
};

export const createOpenTelemetryLogRecord = (
  level: LogLevel,
  params: OpenTelemetryLogParams,
): OpenTelemetryLogRecord => {
  const attributes: Record<string, OpenTelemetryAttributeValue> = {};

  for (const [key, value] of Object.entries(params.obj)) {
    if (value === undefined) {
      continue;
    }

    if (key === 'err' && value instanceof Error) {
      attributes['exception.type'] = value.name;
      attributes['exception.message'] = value.message;

      if (value.stack) {
        attributes['exception.stacktrace'] = value.stack;
      }

      continue;
    }

    if (key === 'data' && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [dataKey, dataValue] of Object.entries(value)) {
        if (dataValue === undefined) {
          continue;
        }

        attributes[`data.${dataKey}`] = toAttributeValue(dataValue);
      }

      continue;
    }

    attributes[key] = toAttributeValue(value);
  }

  return {
    severityNumber: SEVERITY_NUMBER_BY_LEVEL[level],
    severityText: level.toUpperCase() as Uppercase<LogLevel>,
    body: toBody(params),
    attributes,
  };
};

export const createOpenTelemetryLogBridge = (
  config: OpenTelemetryLoggerConfig,
): OpenTelemetryLogBridge | null => {
  if (!config.enabled) {
    return null;
  }

  const endpoint = normalizeOpenTelemetryLogsEndpoint(config);

  if (!endpoint) {
    return null;
  }

  try {
    const loggerProvider = new LoggerProvider({
      resource: resourceFromAttributes({
        'service.name': config.serviceName,
      }),
      processors: [new BatchLogRecordProcessor(new OTLPLogExporter({ url: endpoint }))],
    });

    logsApi.setGlobalLoggerProvider(loggerProvider);

    const logger = loggerProvider.getLogger(config.serviceName);

    return {
      enabled: true,
      endpoint,
      emit(level, params) {
        logger.emit(createOpenTelemetryLogRecord(level, params));
      },
      shutdown() {
        return loggerProvider.shutdown();
      },
    };
  } catch (error) {
    console.error('Failed to initialize OpenTelemetry log export', error);

    return null;
  }
};
