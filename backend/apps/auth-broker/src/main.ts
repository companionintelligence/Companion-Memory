import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import * as config from 'config';

import { AuthBrokerModule } from './auth-broker.module';
import { LoggerService } from './common/logger.service';

async function bootstrap() {
  const app = await NestFactory.create(AuthBrokerModule, {
    logger: new LoggerService('auth-broker'),
  });

  const express = app.getHttpAdapter().getInstance();
  express.set('trust proxy', true);
  express.disable('x-powered-by');

  app.useGlobalPipes(new ValidationPipe({ transform: true }));
  app.enableShutdownHooks();

  // Enable CORS for auth domains
  app.enableCors({
    origin: [
      'https://auth.companionintellience.io',
      'https://dev.companionintelligence.com',
      'http://localhost:3000',
    ],
    credentials: true,
  });

  const port = config.get<number>('authBroker.port') || 3001;
  const host = config.get<string>('authBroker.host') || '0.0.0.0';

  await app.listen(port, host);
  console.log(`Auth Broker Server running on ${host}:${port}`);
}

bootstrap();
