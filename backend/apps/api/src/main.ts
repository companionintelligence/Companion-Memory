import { NestFactory } from '@nestjs/core';
import * as express from 'express';

import { App } from '@ci/application';
import { LoggerService } from '@ci/common/services';
import config from '@ci/configuration';

(async function () {
  const app = await NestFactory.create(App, {
    logger: new LoggerService('application'),
  });

  const expressInstance = app.getHttpAdapter().getInstance();

  expressInstance.set('trust proxy', true);
  expressInstance.disable('x-powered-by');

  // Increase the body size limit for Express
  expressInstance.use(express.json({ limit: '50mb' }));
  expressInstance.use(express.urlencoded({ limit: '50mb', extended: true }));

  app.enableShutdownHooks();

  await app.listen(config.port, config.host);
})();
