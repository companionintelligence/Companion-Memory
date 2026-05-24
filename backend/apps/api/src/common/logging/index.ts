import { Module, Global } from '@nestjs/common';

import { LoggerService } from './services/LoggerService';

@Global()
@Module({
  providers: [LoggerService],
  exports: [LoggerService],
})
export class LoggingModule {}

export { LoggerService };
export { RequestLoggerMiddleware } from './middleware/RequestLoggerMiddleware';
