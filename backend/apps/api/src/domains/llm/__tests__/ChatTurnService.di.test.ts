import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { EventService, LocalEventService } from '@ci/domains/events';
import { LLMModule } from '@ci/domains/llm';
import { FileChunkService } from '@ci/domains/parsing';

import { STUBBED_MODULES, createQuietLogger } from '../../../../scripts/support/admin-testing-module';
import { App } from '../../../application';
import { ChatTurnService } from '../services/ChatTurnService';

/**
 * `ChatTurnService` reads the text of an attached PDF through `FileChunkService`, an `@Optional()`
 * constructor parameter: a hand-built instance (every unit test) has none, and a document then reads
 * as having no text available. That is the right behaviour for a unit test and a silent failure in the
 * app, where Nest gives an `@Optional()` parameter it cannot resolve `undefined` without a word. So
 * this builds the real module graph, as `make seed` does, and checks the service was handed a real one.
 *
 * It needs no Postgres: `compile()` resolves and constructs providers but runs no lifecycle hook, so a
 * DataSource that answers the few calls TypeORM's repository factory makes is enough.
 */
const fakeRepository = new Proxy(
  {},
  {
    // `then` has to stay undefined. A Proxy that answers every key with a function is a thenable, and
    // Nest awaits provider instances: awaiting one whose `then` ignores its callbacks hangs forever.
    get: (_target, property) => (property === 'then' ? undefined : () => undefined),
  },
);

const fakeDataSource = {
  entityMetadatas: [],
  options: { type: 'postgres' },
  manager: {},
  getRepository: () => fakeRepository,
  isInitialized: true,
  destroy: async () => undefined,
} as unknown as DataSource;

describe('ChatTurnService dependency injection', () => {
  it('is given the parse pipeline by the module graph, so an attached PDF has text to read', async () => {
    let builder = Test.createTestingModule({ imports: [App] })
      .overrideProvider(LoggerService)
      .useFactory({ factory: createQuietLogger })
      .overrideProvider(EventService)
      .useClass(LocalEventService)
      .overrideProvider(DataSource)
      .useValue(fakeDataSource);

    // The real LLM module is the point; every other module the admin scripts stub stays stubbed.
    for (const { real, stub } of STUBBED_MODULES) {
      if (real !== LLMModule) {
        builder = builder.overrideModule(real).useModule(stub);
      }
    }

    const module = await builder.compile();

    try {
      const service = module.get(ChatTurnService, { strict: false });
      const chunks = (service as unknown as { fileChunkService?: unknown }).fileChunkService;

      expect(chunks).toBeDefined();
      expect(chunks).toBe(module.get(FileChunkService, { strict: false }));
    } finally {
      await module.close();
    }
  });
});
