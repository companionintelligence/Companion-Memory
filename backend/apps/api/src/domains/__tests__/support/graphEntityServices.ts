import type { DataSource } from 'typeorm';

import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import {
  ConceptEntity,
  ConceptService,
  GraphDeltaWriter,
  PersonEntity,
  PersonService,
  PlaceEntity,
  PlaceService,
} from '@ci/domains/memory';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE THREE SERVICES `memory.forget` PURGES A PERSON, A PLACE AND A CONCEPT THROUGH.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `ForgetKnowledgeTool` sends a `Person`, a `Location` or `Place` and a `Concept` node to
 * `PersonService.purge`, `PlaceService.purge` and `ConceptService.purge`. A tool suite that deletes
 * nodes of those kinds, even ones it only uses as the far end of an edge, needs the real services
 * behind it: a stub would answer "not a function" and say nothing about whether the node is gone.
 *
 * The services announce their removals through the `signalling` the suite hands in, as the real ones
 * do, so a case that watches for `ConceptRemovedEvent` sees it.
 */

/** The entities a `DataSource` must be given for these services' repositories. */
export const GRAPH_ENTITY_ENTITIES = [PersonEntity, PlaceEntity, ConceptEntity];

export function graphEntityServices(dataSource: DataSource, signalling: EventService, logger: LoggerService) {
  return {
    people: new PersonService(dataSource.getRepository(PersonEntity), logger, signalling),
    places: new PlaceService(
      dataSource.getRepository(PlaceEntity),
      signalling,
      new GraphDeltaWriter(dataSource, logger),
    ),
    concepts: new ConceptService(dataSource.getRepository(ConceptEntity), logger, signalling),
  };
}
