import type { SeedPerson } from './types';

export const JULIAN_THORNE: SeedPerson = {
  id: 'b4acc4b7-8f7c-4946-a5b5-307967a6094c',
  name: 'Julian Thorne',
  description:
    "Sarah's Art Director. He's chaotic where she is ordered, but she anchors his creativity into something actionable.",
  properties: {
    first_name: 'Julian',
    last_name: 'Thorne',
    age: 44,
    occupation: 'Art Director',
    interests: ['Abstract Art', 'Typography', 'Espresso'],
  },
};

export const CHLOE_MASTERS: SeedPerson = {
  id: '3669bbd4-c5c2-468e-a5e2-3dbfc4e2e324',
  name: 'Chloe Masters',
  description: 'A Junior Associate Sarah mentors. I think she reminds Sarah of her younger, more rigid self.',
  properties: {
    first_name: 'Chloe',
    last_name: 'Masters',
    age: 24,
    occupation: 'Marketing Associate',
    interests: ['Social Trends', 'Career Growth', 'Fashion'],
  },
};

export const DANIEL_KIM: SeedPerson = {
  id: 'c0a2af57-c0af-4418-b545-08d37fb37d7a',
  name: 'Daniel Kim',
  description:
    'A Senior Data Analyst who speaks the language of control. He gives Sarah the metrics she needs to justify her intuitive decisions.',
  properties: {
    first_name: 'Daniel',
    last_name: 'Kim',
    age: 36,
    occupation: 'Marketing Data Analyst',
    interests: ['Big Data', 'Excel', 'Chess'],
  },
};

export const BRAD_REYNOLDS: SeedPerson = {
  id: 'd9db28d6-e87b-4690-96e6-e8231a135ddf',
  name: 'Brad Reynolds',
  description:
    'The Sales Director. He has a kinetic energy similar to mine, so Sarah knows exactly how to handle him during heated meetings.',
  properties: {
    first_name: 'Brad',
    last_name: 'Reynolds',
    age: 43,
    occupation: 'Sales Director',
    interests: ['Golf', 'Networking', 'Sales Psychology'],
  },
};

export const AISHA_JONES: SeedPerson = {
  id: 'c3f5c542-0573-44a1-9972-035a3fec10b3',
  name: 'Aisha Jones',
  description:
    'The Social Media Manager. Sarah acts as a stabilizing force for her, ensuring the brand remains intentional rather than reactive.',
  properties: {
    first_name: 'Aisha',
    last_name: 'Jones',
    age: 27,
    occupation: 'Social Media Manager',
    interests: ['TikTok Trends', 'Digital Culture', 'Photography'],
  },
};

export const ELIAS_VANCE: SeedPerson = {
  id: '137f66ff-1e1d-493d-a8da-eb2a89ec1d1f',
  name: 'Elias Vance',
  description:
    'A Senior Copywriter. He and Sarah are fellow introverts who obsess over narrative flow in the quiet corner of the office.',
  properties: {
    first_name: 'Elias',
    last_name: 'Vance',
    age: 48,
    occupation: 'Senior Copywriter',
    interests: ['Classic Literature', 'Screenwriting', 'Jazz'],
  },
};

export const KATHERINE_OMALLEY: SeedPerson = {
  id: '3ffd5b88-f316-4f43-a732-6a6e367682f0',
  name: "Katherine O'Malley",
  description:
    "Sarah's VP of Marketing. She values Sarah's gentle strength and relies on her to be the emotional barometer of the team.",
  properties: {
    first_name: 'Katherine',
    last_name: "O'Malley",
    age: 52,
    occupation: 'VP of Marketing',
    interests: ['Leadership Strategy', 'Mentorship', 'Wine'],
  },
};

export const SAM_RIVERA: SeedPerson = {
  id: 'adb7123b-48d1-4b73-9717-c0413360363a',
  name: 'Sam Rivera',
  description:
    "Marketing Ops. He builds the automated workflows that satisfy Sarah's need for predictability.",
  properties: {
    first_name: 'Sam',
    last_name: 'Rivera',
    age: 31,
    occupation: 'Marketing Operations',
    interests: ['Automation', 'CRM Tools', 'Gaming'],
  },
};

export const GRACE_STERLING: SeedPerson = {
  id: '4ec625b5-08c1-4a33-816a-bb777bc26338',
  name: 'Grace Sterling',
  description:
    'Public Relations. She handles the external crises with steel, allowing Sarah to handle the internal culture with empathy.',
  properties: {
    first_name: 'Grace',
    last_name: 'Sterling',
    age: 39,
    occupation: 'Public Relations Lead',
    interests: ['Crisis Management', 'News', 'Politics'],
  },
};

export const MORGAN_WELLS: SeedPerson = {
  id: '89898080-bfba-40ab-8e2d-05d9cd775032',
  name: 'Morgan Wells',
  description:
    'The Event Coordinator. Sarah provides the sanctuary Morgan needs to organize chaotic corporate retreats.',
  properties: {
    first_name: 'Morgan',
    last_name: 'Wells',
    age: 33,
    occupation: 'Event Coordinator',
    interests: ['Event Planning', 'Interior Design', 'Hospitality'],
  },
};

export const SARAH_COWORKERS: SeedPerson[] = [
  JULIAN_THORNE,
  CHLOE_MASTERS,
  DANIEL_KIM,
  BRAD_REYNOLDS,
  AISHA_JONES,
  ELIAS_VANCE,
  KATHERINE_OMALLEY,
  SAM_RIVERA,
  GRACE_STERLING,
  MORGAN_WELLS,
];
