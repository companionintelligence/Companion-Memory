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

import { RequestContextMiddleware } from '@ci/common/context';
import { HealthController } from '@ci/common/controllers/HealthController';
import { FeatureModule } from '@ci/common/feature';
import { GlobalExceptionsFilter } from '@ci/common/filters';
import { IdFormatGuard } from '@ci/common/guards';
import { LoggingModule, LoggerService, RequestLoggerMiddleware } from '@ci/common/logging';
import { BodyParserMiddleware } from '@ci/common/middleware';
import config from '@ci/configuration';
import { AgentModule } from '@ci/domains/agent';
import { AuditModule } from '@ci/domains/audit';
import { AuthModule } from '@ci/domains/auth';
import { PortalAuthModule } from '@ci/domains/auth/PortalAuthModule';
import { BrowserActivityModule } from '@ci/domains/browser-activity';
import { ConnectionsModule } from '@ci/domains/connections';
import { DeviceModule } from '@ci/domains/devices';
import { EtlModule } from '@ci/domains/etl';
import { EventsModule } from '@ci/domains/events';
import { FilesModule } from '@ci/domains/files';
import { GraphModule } from '@ci/domains/graph';
import { GraphQLModule } from '@ci/domains/graphql';
import { IntelligenceModule } from '@ci/domains/intelligence';
import { LLMModule } from '@ci/domains/llm';
import { McpModule } from '@ci/domains/mcp';
import { MemoryModule } from '@ci/domains/memory';
import { NotesModule } from '@ci/domains/notes';
import { OnboardingModule } from '@ci/domains/onboarding';
import { PositionModule } from '@ci/domains/position';
import { PredictionsModule } from '@ci/domains/predictions';
import { SearchIngressModule } from '@ci/domains/search-ingress';
import { SearchNextModule } from '@ci/domains/search-next';
import { SummariesModule } from '@ci/domains/summaries';
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
      logging: [...(config.environment['database.query.logging'] ? (['error', 'query'] as const) : [])],
    }),
    FeatureModule,
    LoggingModule,
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    AgentModule,
    AuditModule,
    AuthModule,
    PortalAuthModule,
    BrowserActivityModule,
    ConnectionsModule,
    DeviceModule,
    EtlModule,
    EventsModule,
    FilesModule,
    GraphModule,
    GraphQLModule,
    IntelligenceModule,
    LLMModule,
    McpModule,
    OnboardingModule,
    PositionModule,
    PredictionsModule,
    ToolsModule,
    MemoryModule,
    NotesModule,
    SearchIngressModule,
    SearchNextModule,
    SummariesModule,
    UserModule,
  ],
  controllers: [HealthController],
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
    consumer.apply(BodyParserMiddleware).forRoutes('*');
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
