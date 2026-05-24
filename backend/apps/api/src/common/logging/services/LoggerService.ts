import { Injectable, Scope, type LoggerService as NestLoggerService } from '@nestjs/common';
import type { Logger as PinoLogger } from 'pino';
import pino from 'pino';

import { ContextService } from '@ci/common/context';
import config from '@ci/configuration';

type LogData = string | Record<string, unknown>;
type ErrorableLogData = Error | LogData;

interface PinoParams {
  obj: Record<string, unknown>;
  msg?: string;
}

const NEST_CONTEXT_DOWNGRADES = new Set([
  'GraphQLModule',
  'InstanceLoader',
  'NestApplication',
  'NestFactory',
  'RouterExplorer',
  'RoutesResolver',
]);

@Injectable({ scope: Scope.TRANSIENT })
export class LoggerService implements NestLoggerService {
  private logger: PinoLogger;

  private static rootLogger: PinoLogger = (() => {
    const isDevelopment = process.env.NODE_ENV !== 'production';

    return pino({
      level: config.logging.level ?? 'debug',
      serializers: {
        err: pino.stdSerializers.err,
        error: pino.stdSerializers.err,
      },
      transport: isDevelopment
        ? {
            target: 'pino-pretty',
            options: {
              ignore: 'pid,hostname',
            },
          }
        : undefined, // Default to JSON output
      mixin: () => {
        const traceId = ContextService.getTraceId();

        return traceId ? { traceId } : {};
      },
    });
  })();

  constructor() {
    this.logger = LoggerService.rootLogger;
  }

  setContext(context: string) {
    this.logger = LoggerService.rootLogger.child({ context });
  }

  log(message: LogData, context: LogData = {}) {
    const { obj, msg } = this.resolveArgs(message, context);

    const contextName = typeof obj['context'] === 'string' ? obj['context'] : '';

    if (contextName && NEST_CONTEXT_DOWNGRADES.has(contextName)) {
      this.logger.debug(obj, msg);
    } else {
      this.logger.info(obj, msg);
    }
  }

  error(message: ErrorableLogData, context: ErrorableLogData = {}) {
    const { obj, msg } = this.resolveArgs(message, context);
    this.logger.error(obj, msg);
  }

  warn(message: ErrorableLogData, context: ErrorableLogData = {}) {
    const { obj, msg } = this.resolveArgs(message, context);
    this.logger.warn(obj, msg);
  }

  debug(message: LogData, context: LogData = {}) {
    const { obj, msg } = this.resolveArgs(message, context);
    this.logger.debug(obj, msg);
  }

  private resolveArgs(message: ErrorableLogData, context: ErrorableLogData = {}): PinoParams {
    const obj: Record<string, unknown> = {};
    const data: Record<string, unknown> = {};
    let msg: string | undefined;

    if (context instanceof Error) {
      obj.err = context;
    } else if (typeof context === 'string') {
      obj.context = context;
    } else if (context && typeof context === 'object') {
      Object.assign(data, context);
    }

    if (message instanceof Error) {
      obj.err = message;
      msg = message.message;
    } else if (typeof message === 'string') {
      msg = message;
    } else if (message && typeof message === 'object') {
      Object.assign(data, message);
    }

    if (Object.keys(data).length > 0) {
      obj.data = data;
    }

    return { obj, msg };
  }
}
