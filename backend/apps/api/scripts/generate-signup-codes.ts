import { input } from '@inquirer/prompts';
import { Test } from '@nestjs/testing';

import { LoggerService } from '@ci/common/logging';
import { AgentModule } from '@ci/domains/agent';
import { SignupCodeService } from '@ci/domains/auth';
import { EtlModule } from '@ci/domains/etl';
import { EventService, LocalEventService } from '@ci/domains/events';
import { GraphQLModule } from '@ci/domains/graphql';
import { LLMModule } from '@ci/domains/llm';
import { McpModule } from '@ci/domains/mcp';
import { ToolsModule } from '@ci/domains/tools';

import { App } from '../src/application';

(async function () {
  const createFilteredLogger = () => {
    const logger = new LoggerService();

    logger.error = () => {};

    logger.warn = () => {};

    logger.log = () => {};

    logger.debug = () => {};

    return logger;
  };

  const module = await Test.createTestingModule({
    imports: [App],
  })
    .overrideProvider(LoggerService)
    .useFactory({
      factory: createFilteredLogger,
    })
    .overrideProvider(EventService)
    .useClass(LocalEventService)
    .overrideModule(AgentModule)
    .useModule(class {})
    .overrideModule(EtlModule)
    .useModule(class {})
    .overrideModule(GraphQLModule)
    .useModule(class {})
    .overrideModule(LLMModule)
    .useModule(class {})
    .overrideModule(McpModule)
    .useModule(class {})
    .overrideModule(ToolsModule)
    .useModule(class {})
    .compile();

  await module.init();

  const signupCodeService = module.get(SignupCodeService);

  const numCodes = await input({
    message: 'Number of signup codes to generate:',
    validate: (value) =>
      (value.trim() !== '' && parseInt(value) > 0) ||
      'Number of codes is required and must be an integer > 0',
  });

  let exitCode = 0;
  const codes: string[] = [];

  try {
    for (let i = 0; i < parseInt(numCodes); i++) {
      const signupCode = await signupCodeService.create();

      codes.push(signupCode.signup_code);
    }

    console.log(`\nSuccessfully created codes:\n\n${codes.join('\n')}\n`);
  } catch (err) {
    console.error('\nFailed to create some codes:', (err as Error).message);

    if (codes.length > 0) {
      console.log('\nBut did create these codes', codes);
    }

    exitCode = 1;
  }

  await module.close();

  process.exit(exitCode);
})();
