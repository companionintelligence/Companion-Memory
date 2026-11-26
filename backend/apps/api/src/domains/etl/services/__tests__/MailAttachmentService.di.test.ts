import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { EtlModule } from '@ci/domains/etl';
import { EventService, LocalEventService } from '@ci/domains/events';

import { STUBBED_MODULES, createQuietLogger } from '../../../../../scripts/support/admin-testing-module';
import { App } from '../../../../application';
import { GmailTransformService } from '../Google/transform/TransformGmail';
import { MailAttachmentService } from '../MailAttachmentService';
import { OutlookMailTransformService } from '../Microsoft/transform/TransformOutlookMail';

/**
 * Both mail transforms save attachments through `MailAttachmentService`, which takes four
 * providers from three other domains. A transform handed no attachment service would import every
 * message without its files and say nothing, so this builds the real module graph, as `make seed`
 * does, and checks that the service can be constructed and that both transforms were given it.
 *
 * It needs no Postgres: `compile()` resolves and constructs providers but runs no lifecycle hook,
 * so a DataSource that answers the few calls TypeORM's repository factory makes is enough.
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

describe('MailAttachmentService dependency injection', () => {
  it('is constructed by the module graph and handed to both mail transforms', async () => {
    let builder = Test.createTestingModule({ imports: [App] })
      .overrideProvider(LoggerService)
      .useFactory({ factory: createQuietLogger })
      .overrideProvider(EventService)
      .useClass(LocalEventService)
      .overrideProvider(DataSource)
      .useValue(fakeDataSource);

    // The real ETL module is the point; every other module the admin scripts stub stays stubbed.
    for (const { real, stub } of STUBBED_MODULES) {
      if (real !== EtlModule) {
        builder = builder.overrideModule(real).useModule(stub);
      }
    }

    const module = await builder.compile();

    try {
      const attachments = module.get(MailAttachmentService, { strict: false });
      const held = (service: object) => (service as { mailAttachments?: unknown }).mailAttachments;

      expect(attachments).toBeInstanceOf(MailAttachmentService);
      expect(held(module.get(GmailTransformService, { strict: false }))).toBe(attachments);
      expect(held(module.get(OutlookMailTransformService, { strict: false }))).toBe(attachments);
    } finally {
      await module.close();
    }
  }, 60_000);
});
