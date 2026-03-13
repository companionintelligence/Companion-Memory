import os from 'node:os';

import { logs, SeverityNumber, type Logger as OtelLogger } from '@opentelemetry/api-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';

interface OtelLoggingOptions {
  enabled: boolean;
  endpoint: string;
  serviceName: string;
  environment?: string;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

let otelLogger: OtelLogger | null = null;

const severityMap: Record<LogLevel, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

const normalizeAttributes = (attributes: Record<string, unknown>): Record<string, unknown> => {
  const normalized: Record<string, unknown> = { ...attributes };

  const error = attributes.err;

  if (error instanceof Error) {
    normalized.errorMessage = error.message;
    normalized.errorStack = error.stack;
    delete normalized.err;
  }

  return normalized;
};

export const initOtelLogger = (options: OtelLoggingOptions): OtelLogger | null => {
  if (otelLogger || !options.enabled || !options.endpoint) {
    return otelLogger;
  }

  const resource = new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: options.serviceName,
    [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: options.environment ?? process.env.NODE_ENV ?? 'development',
    [SemanticResourceAttributes.HOST_NAME]: os.hostname(),
  });

  const exporter = new OTLPLogExporter({ url: options.endpoint });
  const provider = new LoggerProvider({ resource });
  provider.addLogRecordProcessor(new BatchLogRecordProcessor(exporter));
  logs.setGlobalLoggerProvider(provider);

  otelLogger = provider.getLogger(options.serviceName);
  return otelLogger;
};

export const emitOtelLog = (level: LogLevel, message: string | undefined, attributes: Record<string, unknown>) => {
  if (!otelLogger) {
    return;
  }

  const body = message ?? '';
  const severityNumber = severityMap[level] ?? SeverityNumber.INFO;

  otelLogger.emit({
    body,
    severityNumber,
    severityText: level.toUpperCase(),
    attributes: normalizeAttributes(attributes),
  });
};
