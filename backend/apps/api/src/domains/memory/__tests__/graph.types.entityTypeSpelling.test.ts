import { getMetadataArgsStorage } from 'typeorm';

import { normalizeEmbeddableType } from '@ci/common/embeddings';
import { entityTypeFor, type StagedEntity } from '@ci/domains/import';

import { BaseEntity } from '../entities/BaseEntity';
import { ENTITY_TYPES, canonicalEntityType, isStorableEntityType, sameEntityType } from '../graph.types';
// Loads every entity class MemoryModule registers, so TypeORM's metadata below
// holds each STI child of ci.entities.
import '../index';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW A GRAPH WRITE SPELLS `entity_type`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `memory.remember` wrote the type exactly as the model spelled it. Qwen spells
 * it `person` and `place`: `valid_entity_type` (`^[A-Z][A-Za-z]*$`) refuses
 * those, so the write failed after the tool had answered and the job
 * dead-lettered. A `PERSON` was stored, and then PersonService's STI repository
 * (`entity_type = 'Person'`) could not see it, and `entities_linked_uniq`
 * treated it as a type of its own. The Postgres half is
 * WriteKnowledgeTool.entityTypeSpelling.integration.test.ts.
 */

describe('canonicalEntityType', () => {
  it.each(ENTITY_TYPES)('spells %s its own way in any case, with any surrounding whitespace', (type) => {
    expect(canonicalEntityType(type)).toBe(type);
    expect(canonicalEntityType(type.toLowerCase())).toBe(type);
    expect(canonicalEntityType(type.toUpperCase())).toBe(type);
    expect(canonicalEntityType(`  ${type.toLowerCase()}\n`)).toBe(type);
  });

  it('spells the types Qwen writes the way ci.entities stores them', () => {
    expect(canonicalEntityType('person')).toBe('Person');
    expect(canonicalEntityType('place')).toBe('Place');
    expect(canonicalEntityType('concept')).toBe('Concept');
    expect(canonicalEntityType('organization')).toBe('Organization');
    expect(canonicalEntityType('event')).toBe('Event');
  });

  it('leaves a type the graph has never held exactly as it was given', () => {
    for (const type of ['Restaurant', 'restaurant', ' Restaurant ', 'coffee shop', 'PERSONS', 'Persona']) {
      expect(canonicalEntityType(type)).toBe(type);
    }
  });
});

describe('isStorableEntityType', () => {
  it('accepts what valid_entity_type accepts: letters only, a capital first', () => {
    for (const type of ['Person', 'PERSON', 'PerSon', 'Restaurant', 'X']) {
      expect(isStorableEntityType(type)).toBe(true);
    }
  });

  it('refuses what valid_entity_type refuses', () => {
    for (const type of ['person', 'place', ' Person', 'Person ', 'Coffee Shop', 'Coffee_Shop', 'Type2', '']) {
      expect(isStorableEntityType(type)).toBe(false);
    }
  });

  it('holds every known type in its canonical spelling', () => {
    for (const type of ENTITY_TYPES) {
      expect(isStorableEntityType(canonicalEntityType(type.toLowerCase()))).toBe(true);
    }
  });
});

describe('sameEntityType', () => {
  it('reads another case or surrounding whitespace as the stored type', () => {
    expect(sameEntityType('Person', 'person')).toBe(true);
    expect(sameEntityType('Person', ' PERSON ')).toBe(true);
    expect(sameEntityType('Restaurant', 'restaurant')).toBe(true);
    // A row stored under a case variant before this fix still reads as its type.
    expect(sameEntityType('PERSON', 'Person')).toBe(true);
  });

  it('reads another name for the stored type as that type', () => {
    expect(sameEntityType('Person', 'contact')).toBe(true);
    expect(sameEntityType('Contact', 'Person')).toBe(true);
    expect(sameEntityType('Location', 'place')).toBe(true);
    expect(sameEntityType('Place', 'Location')).toBe(true);
    expect(sameEntityType('Item', 'thing')).toBe(true);
    expect(sameEntityType('Object', 'item')).toBe(true);
    expect(sameEntityType('PERSON', 'contact')).toBe(true);
  });

  it('keeps different types apart', () => {
    expect(sameEntityType('Concept', 'person')).toBe(false);
    expect(sameEntityType('Person', 'Concept')).toBe(false);
    expect(sameEntityType('Person', 'organization')).toBe(false);
    expect(sameEntityType('Event', 'Content')).toBe(false);
    // A catalog model is what a thing IS; an Item is one the user owns.
    expect(sameEntityType('Product', 'item')).toBe(false);
    expect(sameEntityType('Restaurant', 'Cafe')).toBe(false);
    expect(sameEntityType('Restaurant', 'Place')).toBe(false);
    // Nothing groups the types with no record of their own with each other.
    expect(sameEntityType('Pet', 'Group')).toBe(false);
    expect(sameEntityType('Goal', 'Tag')).toBe(false);
  });
});

/**
 * The known set is ENTITY_TYPES. These pin it to what the rest of the codebase
 * stores, so a type added elsewhere without it fails here instead of being
 * written in a model's spelling.
 */
describe('the known types are the ones the codebase stores', () => {
  it('holds every STI discriminator on ci.entities, spelled the way TypeORM writes and scopes it', () => {
    const discriminators = getMetadataArgsStorage()
      .discriminatorValues.filter(
        ({ target }) => typeof target === 'function' && target.prototype instanceof BaseEntity,
      )
      .map(({ value }) => String(value));

    // Person, Concept, Content, File, Item, Event, Communication today.
    expect(discriminators.length).toBeGreaterThanOrEqual(7);
    for (const type of discriminators) {
      expect(ENTITY_TYPES).toContain(type);
      expect(canonicalEntityType(type.toLowerCase())).toBe(type);
    }
  });

  it('holds every type the importer files an entity under', () => {
    const staged = [
      'contact',
      'person',
      'place',
      'location',
      'address',
      'product',
      'object',
      'music_genre',
      '',
    ];

    for (const type of staged) {
      const filed = entityTypeFor({ type } as unknown as StagedEntity);

      expect(ENTITY_TYPES).toContain(filed);
    }
  });

  it('holds the types other writers store by literal', () => {
    // TransformFacebookLikes (liked Pages); DerivedRelationshipService (households).
    expect(ENTITY_TYPES).toEqual(expect.arrayContaining(['Organization', 'Group']));
  });

  it('groups other names for a type exactly as GRAPH_TYPE_ALIASES does for search', () => {
    for (const stored of ENTITY_TYPES) {
      for (const requested of ENTITY_TYPES) {
        if (stored === requested) {
          continue;
        }

        const kind = normalizeEmbeddableType(stored);
        const searchGroupsThem = kind !== null && kind === normalizeEmbeddableType(requested);

        expect([stored, requested, sameEntityType(stored, requested)]).toEqual([
          stored,
          requested,
          searchGroupsThem,
        ]);
      }
    }
  });
});
