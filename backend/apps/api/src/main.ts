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

  app.enableShutdownHooks();

  await app.listen(config.port, config.host);
})();
