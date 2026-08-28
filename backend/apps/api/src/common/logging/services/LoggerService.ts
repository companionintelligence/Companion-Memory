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

  /**
   * Fold one argument into the pino call, hoisting an Error out of the data.
   *
   * pino's serializers run on TOP-LEVEL keys only, and everything a caller
   * passes as structured context is nested under `data`. So an Error left in
   * there is serialized by `JSON.stringify`, which sees no enumerable
   * properties on an Error and writes `{}` — message, stack and cause all
   * silently gone.
   *
   * That is why the hoist exists rather than a rule telling call sites not to
   * do it: until it did, no argument shape carried a human sentence, a
   * serialized error AND the context the error is about at the same time
   * (`error(sentence, err)` drops the context; `error({ ...context }, err)`
   * drops the sentence), so call sites reached for `error(err, { message })`
   * instead — which logs the raw error text as `msg` and buries the sentence
   * in `data.message`, making those failures grep differently from every
   * sibling's. All three now fit: `error(sentence, { err, ...context })`.
   *
   * Only an actual `Error` under `err`/`error` moves. A string in either key —
   * `{ error: err.message }`, which plenty of call sites pass — is data and
   * stays data.
   */
  private absorb(
    source: Record<string, unknown>,
    obj: Record<string, unknown>,
    data: Record<string, unknown>,
  ) {
    for (const [key, value] of Object.entries(source)) {
      if ((key === 'err' || key === 'error') && value instanceof Error) {
        obj.err = value;
      } else {
        data[key] = value;
      }
    }
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
      this.absorb(context, obj, data);
    }

    if (message instanceof Error) {
      obj.err = message;
      msg = message.message;
    } else if (typeof message === 'string') {
      msg = message;
    } else if (message && typeof message === 'object') {
      this.absorb(message, obj, data);
    }

    if (Object.keys(data).length > 0) {
      obj.data = data;
    }

    return { obj, msg };
  }
}
