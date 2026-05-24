import { type TestingModule } from '@nestjs/testing';
import { type MultiBar } from 'cli-progress';

import { PlaceService } from '@ci/domains/memory';

import { PLACES } from './data/places';
import { JOHN_SMITH } from './data/users';

export async function seedPlaces(module: TestingModule, multibar: MultiBar) {
  const placeService = module.get(PlaceService);

  const bar = multibar.create(PLACES.length, 0, { task: 'Places' });

  for (const place of PLACES) {
    const existingPlace = await placeService.findById(
      {
        userId: JOHN_SMITH.id,
      },
      place.id,
    );

    if (existingPlace == null) {
      await placeService.create(
        {
          userId: JOHN_SMITH.id,
        },
        {
          id: place.id,
          name: place.name,
          ...(place.properties && {
            properties: place.properties,
          }),
        },
      );
    }

    bar.increment();
  }

  bar.stop();
}
