import { type TestingModule } from '@nestjs/testing';
import { type MultiBar } from 'cli-progress';

import { EventService } from '@ci/domains/memory';

import { EVENTS } from './data/events';
import { JOHN_SMITH } from './data/users';

export async function seedEvents(module: TestingModule, multibar: MultiBar) {
  const eventService = module.get(EventService);

  const bar = multibar.create(EVENTS.length, 0, { task: 'Events' });

  for (const event of EVENTS) {
    const existingEvent = await eventService.findById(
      {
        userId: JOHN_SMITH.id,
      },
      event.id,
    );

    if (existingEvent == null) {
      await eventService.create(
        {
          userId: JOHN_SMITH.id,
        },
        {
          id: event.id,
          title: event.title,
          description: event.description,
          start_time: event.start_time,
          end_time: event.end_time,
          location_entity_id: event.location_entity_id,
          participant_entity_ids: event.participant_entity_ids,
          organizer_entity_id: event.organizer_entity_id,
          user: {
            id: JOHN_SMITH.id,
          },
        },
      );
    } else {
      await eventService.update({ userId: JOHN_SMITH.id }, event.id, {
        title: event.title,
        description: event.description,
        start_time: event.start_time,
        end_time: event.end_time,
      });
    }

    bar.increment();
  }

  bar.stop();
}
