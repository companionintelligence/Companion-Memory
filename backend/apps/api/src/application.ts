import {
  MiddlewareConsumer,
  Module,
  NestModule,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { IdFormatGuard } from '@ci/common/guards';
import { RequestContextMiddleware, RequestLoggerMiddleware } from '@ci/common/middleware';
import { LoggerService } from '@ci/common/services';
import config from '@ci/configuration';
import { AuthModule } from '@ci/domains/auth';
import { ConnectionsModule } from '@ci/domains/connections';
import { EventsModule } from '@ci/domains/events';
import { FilesModule } from '@ci/domains/files';
import { IntelligenceModule } from '@ci/domains/intelligence';
import { JobsModule } from '@ci/domains/jobs';
import { LLMModule } from '@ci/domains/llm';
import { MemoryModule } from '@ci/domains/memory';
import { ProvidersModule } from '@ci/domains/providers';
import { EmbeddingModule } from '@ci/domains/search';
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
      entities: [__dirname + '/domains/**/*Entity.{ts,js}'],
      logging: config.db.logging,
    }),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    AuthModule,
    EmbeddingModule,
    EventsModule,
    FilesModule,
    IntelligenceModule,
    JobsModule,
    LLMModule,
    MemoryModule,
    UserModule,
    ProvidersModule,
    ConnectionsModule,
  ],
  controllers: [],
  providers: [
    {
      provide: APP_GUARD,
      useClass: IdFormatGuard,
    },
  ],
})
export class App implements NestModule, OnApplicationBootstrap, OnApplicationShutdown {
  private logger = new LoggerService('application');

  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
    consumer.apply(RequestLoggerMiddleware).forRoutes('*');
  }

  onApplicationBootstrap() {
    this.logger.log('Application listening', {
      host: config.host,
      port: config.port,
    });
  }

  onApplicationShutdown(signal?: string) {
    this.logger.log('Application stopped', {
      signal,
    });
  }
}
