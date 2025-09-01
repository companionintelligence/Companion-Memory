import type { LoggerService as NestLoggerService } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
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

  log(message: string, context?: string): void {
    this.logger.info({ context }, message);
  }

  error(message: string, trace?: string, context?: string): void {
    this.logger.error({ context, trace }, message);
  }

  warn(message: string, context?: string): void {
    this.logger.warn({ context }, message);
  }

  debug(message: string, context?: string): void {
    this.logger.debug({ context }, message);
  }

  verbose(message: string, context?: string): void {
    this.logger.trace({ context }, message);
  }
}
