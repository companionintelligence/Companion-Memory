import { NestFactory } from '@nestjs/core';
import { urlencoded } from 'express';

import { App } from '@ci/application';
import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

(async function () {
  const app = await NestFactory.create(App, {
    bufferLogs: true,
  });

  const logger = await app.resolve(LoggerService);

  app.useLogger(logger);

  const express = app.getHttpAdapter().getInstance();

  express.set('trust proxy', true);
  express.disable('x-powered-by');

  // Note: JSON body parsing is now handled by DynamicBodyParserMiddleware
  // to allow per-route body size limits via @BodyLimit decorator
  app.use(urlencoded({ extended: true, limit: '100kb' }));

  app.enableShutdownHooks();

  await app.listen(config.port, config.host);
})();
