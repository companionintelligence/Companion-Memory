import * as concepts from '../concepts';
import * as people from '../people';

import { RelationshipType, type SeedRelationship } from './types';

export const EMMA_PREFERS: SeedRelationship[] = [
  {
    fromNodeId: people.EMMA_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.PIZZA.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.95,
    properties: {
      context: 'always loved',
    },
  },
  {
    fromNodeId: people.EMMA_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.MEXICAN_FOOD.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.9,
    properties: {
      context: 'always loved',
    },
  },
  {
    fromNodeId: people.EMMA_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.SUSHI.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.85,
    properties: {
      context: 'discovered',
    },
  },
  {
    fromNodeId: people.EMMA_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.ITALIAN_CUISINE.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.8,
    properties: {
      context: 'childhood',
    },
  },
  {
    fromNodeId: people.EMMA_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.THAI_FOOD.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.7,
    properties: {
      context: 'recent',
    },
  },
  {
    fromNodeId: people.EMMA_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.ANIMATION.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.9,
    properties: {
      context: 'childhood',
    },
  },
  {
    fromNodeId: people.EMMA_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.ROMANCE.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.85,
    properties: {
      context: 'discovered',
    },
  },
  {
    fromNodeId: people.EMMA_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.COMEDY.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.85,
    properties: {
      context: 'always loved',
    },
  },
  {
    fromNodeId: people.EMMA_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.DRAMA.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.75,
    properties: {
      context: 'recent',
    },
  },
  {
    fromNodeId: people.EMMA_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.PAINTING.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.95,
    properties: {
      context: 'discovered',
    },
  },
  {
    fromNodeId: people.EMMA_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.READING.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.85,
    properties: {
      context: 'childhood',
    },
  },
  {
    fromNodeId: people.EMMA_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.DANCING.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.8,
    properties: {
      context: 'recent',
    },
  },
  {
    fromNodeId: people.EMMA_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.WRITING.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.75,
    properties: {
      context: 'recent',
    },
  },
  {
    fromNodeId: people.EMMA_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.SMOOTHIES.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.9,
    properties: {
      context: 'always loved',
    },
  },
  {
    fromNodeId: people.EMMA_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.TEA.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.7,
    properties: {
      context: 'discovered',
    },
  },
];

export const EMMA_DISLIKES: SeedRelationship[] = [
  {
    fromNodeId: people.EMMA_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.HORROR.id,
    toNodeType: 'concept',
    type: RelationshipType.DISLIKES,
    strength: 1.0,
    properties: {
      reason: 'nightmares',
    },
  },
  {
    fromNodeId: people.EMMA_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.SEAFOOD.id,
    toNodeType: 'concept',
    type: RelationshipType.DISLIKES,
    strength: 0.9,
    properties: {
      reason: 'texture issues',
    },
  },
  {
    fromNodeId: people.EMMA_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.RUNNING.id,
    toNodeType: 'concept',
    type: RelationshipType.DISLIKES,
    strength: 0.7,
    properties: {
      reason: 'prefer other activities',
    },
  },
];
