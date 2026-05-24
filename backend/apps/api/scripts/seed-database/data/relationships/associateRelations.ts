import * as people from '../people';

import { RelationshipType, type SeedRelationship } from './types';

export const ASSOCIATE_RELATIONS: SeedRelationship[] = [
  {
    fromNodeId: people.KAREN_DAVIS.id,
    fromNodeType: 'person',
    toNodeId: people.CALEB_DAVIS.id,
    toNodeType: 'person',
    type: RelationshipType.PARENT_OF,
    strength: 1.0,
    properties: {
      relationship: 'mother-son',
    },
  },
  {
    fromNodeId: people.AMANDA_BROWN.id,
    fromNodeType: 'person',
    toNodeId: people.TYLER_BROWN.id,
    toNodeType: 'person',
    type: RelationshipType.PARENT_OF,
    strength: 1.0,
    properties: {
      relationship: 'mother-son',
    },
  },
  {
    fromNodeId: people.MAYA_PATEL.id,
    fromNodeType: 'person',
    toNodeId: people.LIAM_PATEL.id,
    toNodeType: 'person',
    type: RelationshipType.PARENT_OF,
    strength: 1.0,
    properties: {
      relationship: 'mother-son',
    },
  },
  {
    fromNodeId: people.JESSICA_LEE.id,
    fromNodeType: 'person',
    toNodeId: people.SOPHIA_LEE.id,
    toNodeType: 'person',
    type: RelationshipType.PARENT_OF,
    strength: 1.0,
    properties: {
      relationship: 'mother-daughter',
    },
  },
  {
    fromNodeId: people.REBECCA_LEWIS.id,
    fromNodeType: 'person',
    toNodeId: people.CHLOE_LEWIS.id,
    toNodeType: 'person',
    type: RelationshipType.PARENT_OF,
    strength: 1.0,
    properties: {
      relationship: 'mother-daughter',
    },
  },
  {
    fromNodeId: people.RACHEL_BENNETT.id,
    fromNodeType: 'person',
    toNodeId: people.LEO_RICCI.id,
    toNodeType: 'person',
    type: RelationshipType.PARENT_OF,
    strength: 1.0,
    properties: {
      relationship: 'mother-son',
    },
  },

  // Child -> Parent (Inverse)
  {
    fromNodeId: people.CALEB_DAVIS.id,
    fromNodeType: 'person',
    toNodeId: people.KAREN_DAVIS.id,
    toNodeType: 'person',
    type: RelationshipType.CHILD_OF,
    strength: 1.0,
    properties: {
      relationship: 'son-mother',
    },
  },
  {
    fromNodeId: people.TYLER_BROWN.id,
    fromNodeType: 'person',
    toNodeId: people.AMANDA_BROWN.id,
    toNodeType: 'person',
    type: RelationshipType.CHILD_OF,
    strength: 1.0,
    properties: {
      relationship: 'son-mother',
    },
  },
  {
    fromNodeId: people.LIAM_PATEL.id,
    fromNodeType: 'person',
    toNodeId: people.MAYA_PATEL.id,
    toNodeType: 'person',
    type: RelationshipType.CHILD_OF,
    strength: 1.0,
    properties: {
      relationship: 'son-mother',
    },
  },
  {
    fromNodeId: people.SOPHIA_LEE.id,
    fromNodeType: 'person',
    toNodeId: people.JESSICA_LEE.id,
    toNodeType: 'person',
    type: RelationshipType.CHILD_OF,
    strength: 1.0,
    properties: {
      relationship: 'daughter-mother',
    },
  },
  {
    fromNodeId: people.CHLOE_LEWIS.id,
    fromNodeType: 'person',
    toNodeId: people.REBECCA_LEWIS.id,
    toNodeType: 'person',
    type: RelationshipType.CHILD_OF,
    strength: 1.0,
    properties: {
      relationship: 'daughter-mother',
    },
  },
  {
    fromNodeId: people.LEO_RICCI.id,
    fromNodeType: 'person',
    toNodeId: people.RACHEL_BENNETT.id,
    toNodeType: 'person',
    type: RelationshipType.CHILD_OF,
    strength: 1.0,
    properties: {
      relationship: 'son-mother',
    },
  },
];
