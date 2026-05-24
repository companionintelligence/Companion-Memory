import {
  EMMA_SMITH,
  EMMA_FRIENDS,
  JOHN_SMITH,
  JOHN_FRIENDS,
  JOHN_COWORKERS,
  LUCAS_SMITH,
  LUCAS_FRIENDS,
  SARAH_SMITH,
  SARAH_COWORKERS,
  SARAH_FRIENDS,
} from '../people';

import { ASSOCIATE_PREFERENCES } from './associatePreferences';
import { ASSOCIATE_RELATIONS } from './associateRelations';
import { EMMA_DISLIKES, EMMA_PREFERS } from './emmaPreferences';
import { JOHN_DISLIKES, JOHN_PREFERS } from './johnPreferences';
import { LUCAS_DISLIKES, LUCAS_PREFERS } from './lucasPreferences';
import { SARAH_DISLIKES, SARAH_PREFERS } from './sarahPreferences';
import { SMITH_FAMILY } from './smithFamily';
import type { SeedRelationship } from './types';
import { RelationshipType } from './types';

export const RELATIONSHIPS: SeedRelationship[] = [
  ...SMITH_FAMILY,

  ...JOHN_PREFERS,
  ...JOHN_DISLIKES,
  ...JOHN_COWORKERS.map(({ id }) => ({
    fromNodeId: JOHN_SMITH.id,
    fromNodeType: 'person',
    toNodeId: id,
    toNodeType: 'person',
    strength: 0.9,
    type: RelationshipType.WORKS_WITH,
  })),
  ...JOHN_FRIENDS.map(({ id }) => ({
    fromNodeId: JOHN_SMITH.id,
    fromNodeType: 'person',
    toNodeId: id,
    toNodeType: 'person',
    strength: 0.9,
    type: RelationshipType.FRIENDS_WITH,
  })),
  // ...JOHN_ITEMS.map(({ id }) => ({
  //   fromNodeId: JOHN_SMITH.id,
  //   toNodeId: id,
  //   strength: 0.9,
  //   type: RelationshipType.OWNS,
  // })),

  ...SARAH_PREFERS,
  ...SARAH_DISLIKES,
  ...SARAH_FRIENDS.map(({ id }) => ({
    fromNodeId: SARAH_SMITH.id,
    fromNodeType: 'person',
    toNodeId: id,
    toNodeType: 'person',
    strength: 0.9,
    type: RelationshipType.FRIENDS_WITH,
  })),
  ...SARAH_COWORKERS.map(({ id }) => ({
    fromNodeId: SARAH_SMITH.id,
    fromNodeType: 'person',
    toNodeId: id,
    toNodeType: 'person',
    strength: 0.9,
    type: RelationshipType.WORKS_WITH,
  })),
  // ...SARAH_ITEMS.map(({ id }) => ({
  //   fromNodeId: SARAH_SMITH.id,
  //   toNodeId: id,
  //   strength: 0.9,
  //   type: RelationshipType.OWNS,
  // })),

  ...EMMA_PREFERS,
  ...EMMA_DISLIKES,
  ...EMMA_FRIENDS.map(({ id }) => ({
    fromNodeId: EMMA_SMITH.id,
    fromNodeType: 'person',
    toNodeId: id,
    toNodeType: 'person',
    strength: 0.85,
    type: RelationshipType.FRIENDS_WITH,
  })),
  // ...EMMA_ITEMS.map(({ id }) => ({
  //   fromNodeId: EMMA_SMITH.id,
  //   toNodeId: id,
  //   strength: 0.9,
  //   type: RelationshipType.OWNS,
  // })),

  ...LUCAS_PREFERS,
  ...LUCAS_DISLIKES,
  ...LUCAS_FRIENDS.map(({ id }) => ({
    fromNodeId: LUCAS_SMITH.id,
    fromNodeType: 'person',
    toNodeId: id,
    toNodeType: 'person',
    strength: 0.85,
    type: RelationshipType.FRIENDS_WITH,
  })),
  // ...LUCAS_ITEMS.map(({ id }) => ({
  //   fromNodeId: LUCAS_SMITH.id,
  //   toNodeId: id,
  //   strength: 0.9,
  //   type: RelationshipType.OWNS,
  // })),

  ...ASSOCIATE_PREFERENCES,
  ...ASSOCIATE_RELATIONS,
];
