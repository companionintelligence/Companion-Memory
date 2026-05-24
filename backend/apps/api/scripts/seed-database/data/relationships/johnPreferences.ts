import * as concepts from '../concepts';
import * as people from '../people';

import { RelationshipType, type SeedRelationship } from './types';

export const JOHN_PREFERS: SeedRelationship[] = [
  {
    fromNodeId: people.JOHN_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.ITALIAN_CUISINE.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.9,
    properties: {
      context: 'childhood',
    },
  },
  {
    fromNodeId: people.JOHN_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.PIZZA.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.85,
    properties: {
      context: 'always loved',
    },
  },
  {
    fromNodeId: people.JOHN_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.BBQ.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.8,
    properties: {
      context: 'discovered',
    },
  },
  {
    fromNodeId: people.JOHN_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.THAI_FOOD.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.75,
    properties: {
      context: 'acquired taste',
    },
  },
  {
    fromNodeId: people.JOHN_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.SUSHI.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.7,
    properties: {
      context: 'recent',
    },
  },
  {
    fromNodeId: people.JOHN_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.SCIFI.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.95,
    properties: {
      context: 'always loved',
    },
  },
  {
    fromNodeId: people.JOHN_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.ACTION.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.85,
    properties: {
      context: 'always loved',
    },
  },
  {
    fromNodeId: people.JOHN_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.THRILLER.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.8,
    properties: {
      context: 'discovered',
    },
  },
  {
    fromNodeId: people.JOHN_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.DRAMA.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.65,
    properties: {
      context: 'acquired taste',
    },
  },
  {
    fromNodeId: people.JOHN_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.HIKING.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.8,
    properties: {
      context: 'discovered',
    },
  },
  {
    fromNodeId: people.JOHN_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.READING.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.75,
    properties: {
      context: 'childhood',
    },
  },
  {
    fromNodeId: people.JOHN_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.CYCLING.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.7,
    properties: {
      context: 'recent',
    },
  },
  {
    fromNodeId: people.JOHN_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.COFFEE.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.95,
    properties: {
      context: 'always loved',
    },
  },
  {
    fromNodeId: people.JOHN_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.BEER.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.7,
    properties: {
      context: 'discovered',
    },
  },
];

export const JOHN_DISLIKES: SeedRelationship[] = [
  {
    fromNodeId: people.JOHN_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.HORROR.id,
    toNodeType: 'concept',
    type: RelationshipType.DISLIKES,
    strength: 0.9,
    properties: {
      reason: 'too scary',
    },
  },
  {
    fromNodeId: people.JOHN_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.SEAFOOD.id,
    toNodeType: 'concept',
    type: RelationshipType.DISLIKES,
    strength: 0.7,
    properties: {
      reason: 'allergies',
    },
  },
  {
    fromNodeId: people.JOHN_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.DANCING.id,
    toNodeType: 'concept',
    type: RelationshipType.DISLIKES,
    strength: 0.6,
    properties: {
      reason: 'not my thing',
    },
  },
];
