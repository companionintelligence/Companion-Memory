import { networkInterfaces } from 'node:os';
import path from 'node:path';

import {
  MiddlewareConsumer,
  Module,
  NestModule,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { GlobalExceptionsFilter } from '@ci/common/filters';
import { IdFormatGuard } from '@ci/common/guards';
import { LoggingModule, LoggerService } from '@ci/common/logging';
import { RequestContextMiddleware, RequestLoggerMiddleware } from '@ci/common/middleware';
import config from '@ci/configuration';
import { AuthModule } from '@ci/domains/auth';
import { BrowserActivityModule } from '@ci/domains/browser-activity';
import { ConnectionsModule } from '@ci/domains/connections';
import { DeviceModule } from '@ci/domains/devices';
import { EtlModule } from '@ci/domains/etl';
import { EventsModule } from '@ci/domains/events';
import { FilesModule } from '@ci/domains/files';
import { GraphQLModule } from '@ci/domains/graphql';
import { IntelligenceModule } from '@ci/domains/intelligence';
import { LLMModule } from '@ci/domains/llm';
import { MemoryModule } from '@ci/domains/memory';
import { OnboardingModule } from '@ci/domains/onboarding';
import { PositionModule } from '@ci/domains/position';
import { PromoteModule } from '@ci/domains/promote';
import { EmbeddingModule } from '@ci/domains/search';
import { SearchIngressModule } from '@ci/domains/search-ingress';
import { SearchNextModule } from '@ci/domains/search-next';
import { SpeechModule } from '@ci/domains/speech';
import { ToolsModule } from '@ci/domains/tools';
import { UserModule } from '@ci/domains/user';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: config.db.type,
      host: config.db.host,
      port: config.db.port,
      database: config.db.database,
      username: config.db.username,
      password: config.db.password,
      entities: [path.join(__dirname, 'domains/**/*Entity.{ts,js}')],
      logging: ['error', ...(config.environment['database.query.logging'] ? (['query'] as const) : [])],
    }),
    LoggingModule,
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    AuthModule,
    BrowserActivityModule,
    ConnectionsModule,
    DeviceModule,
    EmbeddingModule,
    EtlModule,
    EventsModule,
    FilesModule,
    GraphQLModule,
    IntelligenceModule,
    LLMModule,
    OnboardingModule,
    PositionModule,
    ToolsModule,
    MemoryModule,
    PromoteModule,
    SearchIngressModule,
    SearchNextModule,
    SpeechModule,
    UserModule,
  ],
  controllers: [],
  providers: [
    {
      provide: APP_GUARD,
      useClass: IdFormatGuard,
    },
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionsFilter,
    },
  ],
})
export class App implements NestModule, OnApplicationBootstrap, OnApplicationShutdown {
  constructor(private readonly logger: LoggerService) {
    this.logger.setContext('application');
  }

  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
    consumer.apply(RequestLoggerMiddleware).forRoutes('*');
  }

  onApplicationBootstrap() {
    process.on('unhandledRejection', (reason: unknown) => {
      const error =
        reason instanceof Error ? reason : new Error(String(reason ?? 'Unknown unhandled rejection'));

      this.logger.error(error, 'Unhandled rejection');

      process.exit(1);
    });

    process.on('uncaughtException', (error: Error) => {
      this.logger.error(error, 'Uncaught exception');

      process.exit(1);
    });

    let bindings: string[];

    if (config.host === '0.0.0.0') {
      const nets = networkInterfaces();

      bindings = Object.values(nets)
        .flatMap((netList) => netList || [])
        .filter((net) => net.family === 'IPv4')
        .map((net) => net.address)
        .map((address) => `http://${address}:${config.port}`);
    } else {
      bindings = [`http://${config.host}:${config.port}`];
    }

    this.logger.log('Application started', {
      bindings,
    });
  }

  onApplicationShutdown(signal?: string) {
    this.logger.log('Application stopped', {
      signal: signal ?? 'EXIT',
    });
  }
}
