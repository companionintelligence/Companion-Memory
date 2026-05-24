import * as concepts from '../concepts';
import * as people from '../people';

import { RelationshipType, type SeedRelationship } from './types';

export const SARAH_PREFERS: SeedRelationship[] = [
  {
    fromNodeId: people.SARAH_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.MEDITERRANEAN.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.95,
    properties: {
      context: 'acquired taste',
    },
  },
  {
    fromNodeId: people.SARAH_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.THAI_FOOD.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.9,
    properties: {
      context: 'always loved',
    },
  },
  {
    fromNodeId: people.SARAH_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.VEGETARIAN.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.85,
    properties: {
      context: 'discovered',
    },
  },
  {
    fromNodeId: people.SARAH_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.SUSHI.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.8,
    properties: {
      context: 'acquired taste',
    },
  },
  {
    fromNodeId: people.SARAH_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.ITALIAN_CUISINE.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.75,
    properties: {
      context: 'childhood',
    },
  },
  {
    fromNodeId: people.SARAH_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.DRAMA.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.9,
    properties: {
      context: 'always loved',
    },
  },
  {
    fromNodeId: people.SARAH_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.ROMANCE.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.85,
    properties: {
      context: 'always loved',
    },
  },
  {
    fromNodeId: people.SARAH_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.DOCUMENTARY.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.8,
    properties: {
      context: 'acquired taste',
    },
  },
  {
    fromNodeId: people.SARAH_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.COMEDY.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.75,
    properties: {
      context: 'discovered',
    },
  },
  {
    fromNodeId: people.SARAH_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.YOGA.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.95,
    properties: {
      context: 'discovered',
    },
  },
  {
    fromNodeId: people.SARAH_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.RUNNING.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.85,
    properties: {
      context: 'recent',
    },
  },
  {
    fromNodeId: people.SARAH_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.READING.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.8,
    properties: {
      context: 'childhood',
    },
  },
  {
    fromNodeId: people.SARAH_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.PAINTING.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.7,
    properties: {
      context: 'recent',
    },
  },
  {
    fromNodeId: people.SARAH_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.TEA.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.9,
    properties: {
      context: 'always loved',
    },
  },
  {
    fromNodeId: people.SARAH_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.WINE.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.85,
    properties: {
      context: 'acquired taste',
    },
  },
  {
    fromNodeId: people.SARAH_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.SMOOTHIES.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.8,
    properties: {
      context: 'discovered',
    },
  },
];

export const SARAH_DISLIKES: SeedRelationship[] = [
  {
    fromNodeId: people.SARAH_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.HORROR.id,
    toNodeType: 'concept',
    type: RelationshipType.DISLIKES,
    strength: 0.85,
    properties: {
      reason: 'too intense',
    },
  },
  {
    fromNodeId: people.SARAH_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.BBQ.id,
    toNodeType: 'concept',
    type: RelationshipType.DISLIKES,
    strength: 0.7,
    properties: {
      reason: 'health reasons',
    },
  },
  {
    fromNodeId: people.SARAH_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.BEER.id,
    toNodeType: 'concept',
    type: RelationshipType.DISLIKES,
    strength: 0.8,
    properties: {
      reason: 'taste preference',
    },
  },
];
