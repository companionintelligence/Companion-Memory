import { LoggerService as NestLoggerService } from '@nestjs/common';
export declare class LoggerService implements NestLoggerService {
    private readonly logger;
    constructor(context?: string);
    log(message: any, context?: string): void;
    error(message: any, trace?: string, context?: string): void;
    warn(message: any, context?: string): void;
    debug(message: any, context?: string): void;
    verbose(message: any, context?: string): void;
}
