import { Catch, ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';

import { LoggerService } from '@ci/common/logging';

// HTTP status codes that represent expected application flow, not errors
const EXPECTED_HTTP_STATUSES = new Set([
  HttpStatus.BAD_REQUEST, // 400
  HttpStatus.UNAUTHORIZED, // 401
  HttpStatus.FORBIDDEN, // 403
  HttpStatus.NOT_FOUND, // 404
  HttpStatus.METHOD_NOT_ALLOWED, // 405
  HttpStatus.CONFLICT, // 409
  HttpStatus.UNPROCESSABLE_ENTITY, // 422
  HttpStatus.TOO_MANY_REQUESTS, // 429
]);

@Catch()
export class GlobalExceptionsFilter extends BaseExceptionFilter {
  constructor(private readonly logger: LoggerService) {
    super();
    this.logger.setContext(GlobalExceptionsFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost) {
    const contextType = host.getType<string>();
    const isHttpException = exception instanceof HttpException;
    const status = isHttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const isExpectedError = EXPECTED_HTTP_STATUSES.has(status);

    const error = exception instanceof Error ? exception : new Error(String(exception));

    if (isExpectedError) {
      this.logger.warn(error);
    } else {
      this.logger.error(error);
    }

    if (contextType === 'graphql') {
      throw exception;
    }

    super.catch(exception, host);
  }
}
