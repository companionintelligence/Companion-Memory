import { type TestingModule } from '@nestjs/testing';
import { type MultiBar } from 'cli-progress';

import { CommunicationService } from '@ci/domains/memory';

import { COMMUNICATIONS } from './data/communications';
import { JOHN_SMITH } from './data/users';

export async function seedCommunications(module: TestingModule, multibar: MultiBar) {
  const communicationService = module.get(CommunicationService);

  const bar = multibar.create(COMMUNICATIONS.length, 0, { task: 'Communications' });

  for (const record of COMMUNICATIONS) {
    const existingCommunication = await communicationService.findById(
      {
        userId: JOHN_SMITH.id,
      },
      record.id,
    );

    if (existingCommunication == null) {
      await communicationService.create(
        {
          userId: JOHN_SMITH.id,
        },
        {
          id: record.id,
          subject: record.subject,
          preview: record.preview,
          content: record.content,
          communication_type: record.communication_type,
          direction: record.direction,
          time: record.time,
          from_entity_id: record.from_entity_id,
          to_entity_ids: record.to_entity_ids,
        },
      );
    }

    bar.increment();
  }

  bar.stop();
}
