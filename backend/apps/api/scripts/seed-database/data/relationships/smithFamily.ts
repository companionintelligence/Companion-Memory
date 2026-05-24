import { RelationshipType } from '@ci/domains/graph';
import { type CreateRelationshipDto } from '@ci/domains/graph/types';

import * as people from '../people';
import * as places from '../places';

export const SMITH_FAMILY: CreateRelationshipDto[] = [
  {
    fromNodeId: people.JOHN_SMITH.id,
    fromNodeType: 'person',
    toNodeId: people.SARAH_SMITH.id,
    toNodeType: 'person',
    type: RelationshipType.SPOUSE,
    strength: 1.0,
    properties: {
      married_since: '2008-06-15',
      anniversary: 'June 15',
    },
  },
  {
    fromNodeId: people.SARAH_SMITH.id,
    fromNodeType: 'person',
    toNodeId: people.JOHN_SMITH.id,
    toNodeType: 'person',
    type: RelationshipType.SPOUSE,
    strength: 1.0,
    properties: {
      married_since: '2008-06-15',
      anniversary: 'June 15',
    },
  },
  {
    fromNodeId: people.JOHN_SMITH.id,
    fromNodeType: 'person',
    toNodeId: people.EMMA_SMITH.id,
    toNodeType: 'person',
    type: RelationshipType.PARENT_OF,
    strength: 1.0,
    properties: {
      relationship: 'father-daughter',
    },
  },
  {
    fromNodeId: people.SARAH_SMITH.id,
    fromNodeType: 'person',
    toNodeId: people.EMMA_SMITH.id,
    toNodeType: 'person',
    type: RelationshipType.PARENT_OF,
    strength: 1.0,
    properties: {
      relationship: 'mother-daughter',
    },
  },
  {
    fromNodeId: people.JOHN_SMITH.id,
    fromNodeType: 'person',
    toNodeId: people.LUCAS_SMITH.id,
    toNodeType: 'person',
    type: RelationshipType.PARENT_OF,
    strength: 1.0,
    properties: {
      relationship: 'father-son',
    },
  },
  {
    fromNodeId: people.SARAH_SMITH.id,
    fromNodeType: 'person',
    toNodeId: people.LUCAS_SMITH.id,
    toNodeType: 'person',
    type: RelationshipType.PARENT_OF,
    strength: 1.0,
    properties: {
      relationship: 'mother-son',
    },
  },
  {
    fromNodeId: people.EMMA_SMITH.id,
    fromNodeType: 'person',
    toNodeId: people.LUCAS_SMITH.id,
    toNodeType: 'person',
    type: RelationshipType.SIBLING_OF,
    strength: 1.0,
    properties: {
      relationship: 'older-sister',
      age_gap: 4,
    },
  },
  {
    fromNodeId: people.LUCAS_SMITH.id,
    fromNodeType: 'person',
    toNodeId: people.EMMA_SMITH.id,
    toNodeType: 'person',
    type: RelationshipType.SIBLING_OF,
    strength: 1.0,
    properties: {
      relationship: 'younger-brother',
      age_gap: 4,
    },
  },
  {
    fromNodeId: people.JOHN_SMITH.id,
    fromNodeType: 'person',
    toNodeId: places.SMITH_FAMILY_HOME.id,
    toNodeType: 'place',
    type: RelationshipType.LIVES_IN,
    strength: 1.0,
    properties: {
      since: '2015-06-01',
    },
  },
  {
    fromNodeId: people.SARAH_SMITH.id,
    fromNodeType: 'person',
    toNodeId: places.SMITH_FAMILY_HOME.id,
    toNodeType: 'place',
    type: RelationshipType.LIVES_IN,
    strength: 1.0,
    properties: {
      since: '2015-06-01',
    },
  },
  {
    fromNodeId: people.EMMA_SMITH.id,
    fromNodeType: 'person',
    toNodeId: places.SMITH_FAMILY_HOME.id,
    toNodeType: 'place',
    type: RelationshipType.LIVES_IN,
    strength: 1.0,
    properties: {
      since: '2015-06-01',
    },
  },
  {
    fromNodeId: people.LUCAS_SMITH.id,
    fromNodeType: 'person',
    toNodeId: places.SMITH_FAMILY_HOME.id,
    toNodeType: 'place',
    type: RelationshipType.LIVES_IN,
    strength: 1.0,
    properties: {
      since: '2015-06-01',
    },
  },
];
