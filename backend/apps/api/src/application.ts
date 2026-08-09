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
// Aliased: our own schedule domain (@ci/domains/schedule) exports a ScheduleModule too.
import { ScheduleModule as NestCronModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import * as Sentry from '@sentry/nestjs';

import { RequestContextMiddleware } from '@ci/common/context';
import { HealthController } from '@ci/common/controllers/HealthController';
import { MapsConfigController } from '@ci/common/controllers/MapsConfigController';
import { TelemetryConfigController } from '@ci/common/controllers/TelemetryConfigController';
import { FeatureModule } from '@ci/common/feature';
import { GlobalExceptionsFilter } from '@ci/common/filters';
import { IdFormatGuard } from '@ci/common/guards';
import { LoggingModule, LoggerService, RequestLoggerMiddleware } from '@ci/common/logging';
import { BodyParserMiddleware } from '@ci/common/middleware';
import config from '@ci/configuration';
import { ActivityModule } from '@ci/domains/activity';
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
import { GeocodeModule } from '@ci/domains/geocode';
import { GraphModule } from '@ci/domains/graph';
import { GraphQLModule } from '@ci/domains/graphql';
import { IngestModule } from '@ci/domains/ingest';
import { IntelligenceModule } from '@ci/domains/intelligence';
import { LLMModule } from '@ci/domains/llm';
import { MaintenanceModule } from '@ci/domains/maintenance';
import { McpModule } from '@ci/domains/mcp';
import { MemoryModule } from '@ci/domains/memory';
import { NotesModule } from '@ci/domains/notes';
import { OnboardingModule } from '@ci/domains/onboarding';
import { PairingModule } from '@ci/domains/pairing';
import { ParsingModule } from '@ci/domains/parsing';
import { PersonaModule } from '@ci/domains/persona';
import { PersonalizationModule } from '@ci/domains/personalization';
import { PipelineModule } from '@ci/domains/pipeline';
import { PlanningModule } from '@ci/domains/planning';
import { PositionModule } from '@ci/domains/position';
import { PowerSyncModule } from '@ci/domains/powersync';
import { PredictionsModule } from '@ci/domains/predictions';
import { PythonFunctionsModule } from '@ci/domains/python-functions';
import { ScheduleModule } from '@ci/domains/schedule';
import { SearchIngressModule } from '@ci/domains/search-ingress';
import { SearchNextModule } from '@ci/domains/search-next';
import { SmartRotationModule } from '@ci/domains/smart-rotation';
import { SummariesModule } from '@ci/domains/summaries';
import { ToolsModule } from '@ci/domains/tools';
import { UserModule } from '@ci/domains/user';
import { UserSnapshotsModule } from '@ci/domains/user-snapshots';
import { flushTelemetry, isTelemetryEnabled } from '@ci/instrument';

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
      // Primary app schema is `ci`; tables are referenced schema-qualified, but
      // user-defined types (e.g. the enum `ci.communication_direction`) are
      // emitted UNqualified by TypeORM in casts, so `ci` must be on the
      // search_path for them to resolve. `public` stays for extensions/pgboss.
      extra: { options: '-c search_path=ci,public' },
    }),
    FeatureModule,
    LoggingModule,
    EventEmitterModule.forRoot(),
    NestCronModule.forRoot(),
    PairingModule,
    ActivityModule,
    AgentModule,
    AuditModule,
    AuthModule,
    PortalAuthModule,
    BrowserActivityModule,
    ConnectionsModule,
    DeviceModule,
    ParsingModule,
    EtlModule,
    EventsModule,
    // Registers the generic pipeline worker, the stage registry and the
    // dead-letter reaper. Ordered after EventsModule because every stage runs on
    // a pg-boss queue that EventsModule discovers from listener registration.
    PipelineModule,
    FilesModule,
    GraphModule,
    GraphQLModule,
    IngestModule,
    IntelligenceModule,
    LLMModule,
    McpModule,
    OnboardingModule,
    PersonalizationModule,
    PersonaModule,
    PlanningModule,
    PositionModule,
    PowerSyncModule,
    PredictionsModule,
    PythonFunctionsModule,
    ToolsModule,
    MemoryModule,
    GeocodeModule,
    MaintenanceModule,
    NotesModule,
    ScheduleModule,
    SmartRotationModule,
    SearchIngressModule,
    SearchNextModule,
    SummariesModule,
    UserModule,
    UserSnapshotsModule,
  ],
  controllers: [HealthController, MapsConfigController, TelemetryConfigController],
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
    // These handlers own the exit path, so they also own reporting the crash:
    // a bare `process.exit(1)` truncates Sentry's async transport and the report
    // is lost.
    //
    // But deferring the exit to a promise continuation puts it behind the event
    // loop, so with reporting OFF — the shipped default — we exit synchronously
    // exactly as before, and telemetry cannot change crash timing at all. Only
    // when a DSN is configured do we take the bounded flush first.
    const exitAfterReporting = () => {
      if (!isTelemetryEnabled()) {
        process.exit(1);
      }

      void flushTelemetry().finally(() => process.exit(1));
    };

    process.on('unhandledRejection', (reason: unknown) => {
      const error =
        reason instanceof Error ? reason : new Error(String(reason ?? 'Unknown unhandled rejection'));

      this.logger.error(error, 'Unhandled rejection');
      Sentry.captureException(error);

      exitAfterReporting();
    });

    process.on('uncaughtException', (error: Error) => {
      this.logger.error(error, 'Uncaught exception');
      Sentry.captureException(error);

      exitAfterReporting();
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

  async onApplicationShutdown(signal?: string) {
    this.logger.log('Application stopped', {
      signal: signal ?? 'EXIT',
    });

    await flushTelemetry();
  }
}
