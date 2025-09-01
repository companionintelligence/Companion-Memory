import { Injectable, LoggerService as NestLoggerService } from '@nestjs/common';
import pino from 'pino';

@Injectable()
export class LoggerService implements NestLoggerService {
  private readonly logger: pino.Logger;

  constructor(context?: string) {
    this.logger = pino({
      name: context || 'auth-broker',
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    });
  }

  log(message: any, context?: string): void {
    this.logger.info({ context }, message);
  }

  error(message: any, trace?: string, context?: string): void {
    this.logger.error({ context, trace }, message);
  }

  warn(message: any, context?: string): void {
    this.logger.warn({ context }, message);
  }

  debug(message: any, context?: string): void {
    this.logger.debug({ context }, message);
  }

  verbose(message: any, context?: string): void {
    this.logger.trace({ context }, message);
  }
}