import { type SeedPerson } from './types';

export const JOHN_SMITH: SeedPerson = {
  id: '019b80f8-77e9-75fa-843e-42cab7b4c7d5',
  name: 'John Smith',
  description:
    "I am the 'Architect of Action'. I see family life as a complex system that needs optimization, and I channel my anxiety into endurance cycling and planning our lives with precision.",
  properties: {
    first_name: 'John',
    last_name: 'Smith',
    age: 42,
    family_role: 'father',
    occupation: 'Software Engineer',
    interests: ['Road Cycling', 'Systems Optimization', 'Endurance Hiking'],
  },
};

export const SARAH_SMITH: SeedPerson = {
  id: '019b80f8-77ea-7088-a776-7c6ddfd5cfba',
  name: 'Sarah Smith',
  description:
    "My wife, the 'Quiet Center' of our home. She balances my intensity with her grounding presence, finding sanctuary in her art and yoga while helping me connect with my own emotions.",
  properties: {
    first_name: 'Sarah',
    last_name: 'Smith',
    age: 40,
    family_role: 'mother',
    occupation: 'Marketing Manager',
    interests: ['Yoga', 'Literature', 'Solitary Art', 'Mindfulness'],
  },
};

export const EMMA_SMITH: SeedPerson = {
  id: '019b80f8-77eb-75ea-829c-6cab32c2c4de',
  name: 'Emma Smith',
  description:
    "Our daughter, the 'Emerging Conscience'. She challenges us daily with her passionate advocacy and deep empathy, often serving as the family's emotional barometer.",
  properties: {
    first_name: 'Emma',
    last_name: 'Smith',
    age: 14,
    family_role: 'daughter',
    occupation: 'Student',
    interests: ['Social Activism', 'Creative Writing', 'Visual Arts'],
  },
};

export const LUCAS_SMITH: SeedPerson = {
  id: '019b80f8-77ec-76f6-ae6d-af1795306f66',
  name: 'Lucas Smith',
  description:
    "Our son, the 'Spark of Joy'. He lives entirely in the moment, a tactile 'doer' like me who brings lightness and play to our lives, reminding me not to take everything so seriously.",
  properties: {
    first_name: 'Lucas',
    last_name: 'Smith',
    age: 10,
    family_role: 'son',
    occupation: 'Student',
    interests: ['Soccer', 'Lego', 'Outdoor Play', 'Video Games'],
  },
};

export const FAMILY: SeedPerson[] = [JOHN_SMITH, SARAH_SMITH, EMMA_SMITH, LUCAS_SMITH];
