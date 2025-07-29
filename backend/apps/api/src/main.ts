import { NestFactory } from '@nestjs/core';

import { App } from '@ci/application';
import { LoggerService } from '@ci/common/services';
import config from '@ci/configuration';

(async function () {
  const app = await NestFactory.create(App, {
    logger: new LoggerService('application'),
  });

  const express = app.getHttpAdapter().getInstance();

  express.set('trust proxy', true);
  express.disable('x-powered-by');

  // Enable CORS for frontend communication
  app.enableCors({
    origin: [
      'https://dev.companionintelligence.com',
      'http://localhost:5173',
      'http://localhost:3000',
      'http://localhost:8080',
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: [
      'Origin',
      'X-Requested-With',
      'Content-Type',
      'Accept',
      'Authorization',
      'Cache-Control',
      'X-Forwarded-For',
      'X-Real-IP',
    ],
    credentials: true,
    preflightContinue: false,
    optionsSuccessStatus: 204,
  });

  app.enableShutdownHooks();

  await app.listen(config.port, config.host);
})();
