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
      const latitude = place.properties?.latitude;
      const longitude = place.properties?.longitude;

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
          // create() does not derive locationPoint from properties — only
          // update() does that lat/lng conversion, and only from top-level
          // fields, never from inside properties. Every seeded place carries
          // real coordinates in properties.{latitude,longitude}; without this,
          // no seeded place ever gets a queryable location_point at all.
          ...(typeof latitude === 'number' &&
            typeof longitude === 'number' && {
              locationPoint: { type: 'Point', coordinates: [longitude, latitude] },
            }),
        },
      );
    }

    bar.increment();
  }

  bar.stop();
}
