import { networkInterfaces } from 'node:os';

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
import { EmbeddingModule } from '@ci/domains/search';
import { ToolsModule } from '@ci/domains/tools';
import { UserModule } from '@ci/domains/user';

import { SpeechModule } from './domains/speech';

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
      logging: ['error', ...(config.environment['database.query.logging'] ? (['query'] as const) : [])],
    }),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    AuthModule,
    ConnectionsModule,
    EmbeddingModule,
    EventsModule,
    FilesModule,
    IntelligenceModule,
    JobsModule,
    LLMModule,
    ToolsModule,
    MemoryModule,
    SpeechModule,
    UserModule,
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

    this.logger.log('Application listening', {
      bindings,
    });
  }

  onApplicationShutdown(signal?: string) {
    this.logger.log('Application stopped', {
      signal,
    });
  }
}
