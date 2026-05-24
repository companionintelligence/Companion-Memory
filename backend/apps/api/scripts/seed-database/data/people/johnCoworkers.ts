import type { SeedPerson } from './types';

export const DAVID_CHEN: SeedPerson = {
  id: 'aefc262e-8f35-459c-85b1-6f598d243da0',
  name: 'David Chen',
  description:
    'A Senior Frontend Engineer whose code cleanliness rivals my own. We bond over optimizing everything from our code to our caffeine intake.',
  properties: {
    first_name: 'David',
    last_name: 'Chen',
    age: 35,
    occupation: 'Senior Frontend Engineer',
    interests: ['Code Architecture', 'Specialty Coffee', 'Minimalism'],
  },
};

export const EMILY_WHITE: SeedPerson = {
  id: 'cc6ca9cc-79c2-4010-9f45-84c8bf5e7012',
  name: 'Emily White',
  description:
    "Our Product Manager. She brings a military precision to requirements that I crave, and she's one of the few who can keep up with me on a hike.",
  properties: {
    first_name: 'Emily',
    last_name: 'White',
    age: 38,
    occupation: 'Product Manager',
    interests: ['Endurance Hiking', 'Project roadmaps', 'Travel'],
  },
};

export const MARCUS_JOHNSON: SeedPerson = {
  id: '1bebeb67-3b8e-4d26-83c8-629cc3334656',
  name: 'Marcus Johnson',
  description:
    'My infrastructure ally. As a DevOps Specialist, he ensures our systems are robust, and we often talk cycling gear during downtime.',
  properties: {
    first_name: 'Marcus',
    last_name: 'Johnson',
    age: 40,
    occupation: 'DevOps Engineer',
    interests: ['Road Cycling', 'CI/CD Pipelines', 'Automation'],
  },
};

export const SARAH_JENKINS: SeedPerson = {
  id: '98d83184-caf4-4250-a40c-d3277a3916be',
  name: 'Sarah Jenkins',
  description:
    'A QA Engineer who really pushes me. Her ability to break my systems forces me to build bulletproof solutions, which I begrudgingly respect.',
  properties: {
    first_name: 'Sarah',
    last_name: 'Jenkins',
    age: 29,
    occupation: 'QA Engineer',
    interests: ['Edge Case Testing', 'Logic Puzzles', 'Strategy Games'],
  },
};

export const MICHAEL_CHANG: SeedPerson = {
  id: 'b8b3437f-2de9-43ec-87c6-aff3a2605e97',
  name: 'Michael Chang',
  description:
    'A fellow backend architect. We can debate database sharding and API efficiency for hours, satisfying my need for structural perfection.',
  properties: {
    first_name: 'Michael',
    last_name: 'Chang',
    age: 32,
    occupation: 'Backend Engineer',
    interests: ['System Scalability', 'API Design', 'Sci-Fi Novels'],
  },
};

export const LISA_PATEL: SeedPerson = {
  id: '7d9f427e-0429-4911-9873-c3d7180ea79b',
  name: 'Lisa Patel',
  description:
    "The empathy to my pragmatism. She reminds me that user behavior isn't always efficient, balancing my focus on raw speed.",
  properties: {
    first_name: 'Lisa',
    last_name: 'Patel',
    age: 28,
    occupation: 'UX Designer',
    interests: ['User Psychology', 'Interface Design', 'Modern Art'],
  },
};

export const ROBERT_VANCE: SeedPerson = {
  id: '93993d57-9e86-4d6c-bac7-b76ebb9e34c6',
  name: 'Robert Vance',
  description:
    'My Engineering Manager. He knows how to channel my intensity and anxiety into productive architectural improvements.',
  properties: {
    first_name: 'Robert',
    last_name: 'Vance',
    age: 45,
    occupation: 'Engineering Manager',
    interests: ['Team Leadership', 'Mentorship', 'Gourmet Cooking'],
  },
};

export const JENNIFER_WU: SeedPerson = {
  id: '3a57b4ce-8cec-4713-ae96-2295530598b9',
  name: 'Jennifer Wu',
  description:
    'Our Data Scientist and gatekeeper of truth. I rely on her statistical models to validate my optimization theories.',
  properties: {
    first_name: 'Jennifer',
    last_name: 'Wu',
    age: 31,
    occupation: 'Data Scientist',
    interests: ['Algorithms', 'Statistical Analysis', 'Classical Piano'],
  },
};

export const KEVIN_OCONNOR: SeedPerson = {
  id: 'd290e238-2ed8-4aad-9e3d-53986def4471',
  name: "Kevin O'Connor",
  description:
    'The hardware veteran. When my software optimizations hit physical limits, Kevin helps me squeeze performance out of the bare metal.',
  properties: {
    first_name: 'Kevin',
    last_name: "O'Connor",
    age: 36,
    occupation: 'System Administrator',
    interests: ['Linux Kernels', 'Server Hardware', 'Vintage Motorcycles'],
  },
};

export const RACHEL_GREEN: SeedPerson = {
  id: '443a5dff-e18a-4455-bbfa-efc3d6647c6d',
  name: 'Rachel Green',
  description:
    'Our Scrum Master. She uses Agile ceremonies to pace me, mirroring the mindfulness techniques Sarah tries to teach me at home.',
  properties: {
    first_name: 'Rachel',
    last_name: 'Green',
    age: 33,
    occupation: 'Scrum Master',
    interests: ['Agile Methodology', 'Work-Life Balance', 'Meditation'],
  },
};

export const JOHN_COWORKERS: SeedPerson[] = [
  DAVID_CHEN,
  EMILY_WHITE,
  MARCUS_JOHNSON,
  SARAH_JENKINS,
  MICHAEL_CHANG,
  LISA_PATEL,
  ROBERT_VANCE,
  JENNIFER_WU,
  KEVIN_OCONNOR,
  RACHEL_GREEN,
];
