import * as concepts from '../concepts';
import * as people from '../people';

import { RelationshipType, type SeedRelationship } from './types';

export const LUCAS_PREFERS: SeedRelationship[] = [
  {
    fromNodeId: people.LUCAS_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.PIZZA.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 1.0,
    properties: {
      context: 'always loved',
    },
  },
  {
    fromNodeId: people.LUCAS_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.TACOS.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.95,
    properties: {
      context: 'always loved',
    },
  },
  {
    fromNodeId: people.LUCAS_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.BBQ.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.9,
    properties: {
      context: 'always loved',
    },
  },
  {
    fromNodeId: people.LUCAS_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.CHINESE_FOOD.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.85,
    properties: {
      context: 'discovered',
    },
  },
  {
    fromNodeId: people.LUCAS_SMITH.id,
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
    fromNodeId: people.LUCAS_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.ANIMATION.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 1.0,
    properties: {
      context: 'always loved',
    },
  },
  {
    fromNodeId: people.LUCAS_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.ACTION.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.95,
    properties: {
      context: 'discovered',
    },
  },
  {
    fromNodeId: people.LUCAS_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.SCIFI.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.9,
    properties: {
      context: 'discovered',
    },
  },
  {
    fromNodeId: people.LUCAS_SMITH.id,
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
    fromNodeId: people.LUCAS_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.GAMING.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 1.0,
    properties: {
      context: 'always loved',
    },
  },
  {
    fromNodeId: people.LUCAS_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.SWIMMING.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.95,
    properties: {
      context: 'childhood',
    },
  },
  {
    fromNodeId: people.LUCAS_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.CYCLING.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.9,
    properties: {
      context: 'discovered',
    },
  },
  {
    fromNodeId: people.LUCAS_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.HIKING.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.8,
    properties: {
      context: 'recent',
    },
  },
  {
    fromNodeId: people.LUCAS_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.SMOOTHIES.id,
    toNodeType: 'concept',
    type: RelationshipType.PREFERS,
    strength: 0.95,
    properties: {
      context: 'always loved',
    },
  },
];

export const LUCAS_DISLIKES: SeedRelationship[] = [
  {
    fromNodeId: people.LUCAS_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.VEGETARIAN.id,
    toNodeType: 'concept',
    type: RelationshipType.DISLIKES,
    strength: 0.85,
    properties: {
      reason: 'likes meat',
    },
  },
  {
    fromNodeId: people.LUCAS_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.SEAFOOD.id,
    toNodeType: 'concept',
    type: RelationshipType.DISLIKES,
    strength: 0.95,
    properties: {
      reason: 'yuck!',
    },
  },
  {
    fromNodeId: people.LUCAS_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.ROMANCE.id,
    toNodeType: 'concept',
    type: RelationshipType.DISLIKES,
    strength: 0.9,
    properties: {
      reason: 'boring',
    },
  },
  {
    fromNodeId: people.LUCAS_SMITH.id,
    fromNodeType: 'person',
    toNodeId: concepts.YOGA.id,
    toNodeType: 'concept',
    type: RelationshipType.DISLIKES,
    strength: 0.8,
    properties: {
      reason: 'too slow',
    },
  },
];
