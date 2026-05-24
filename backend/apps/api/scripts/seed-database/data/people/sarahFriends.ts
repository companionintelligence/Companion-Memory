import type { SeedPerson } from './types';

export const MAYA_PATEL: SeedPerson = {
  id: '95d84024-41b8-43d0-8b2c-351c1d04be98',
  name: 'Maya Patel',
  description:
    "Sarah's yoga instructor and close friend. She encourages Sarah to be vulnerable, providing a safe harbor outside our family logic.",
  properties: {
    first_name: 'Maya',
    last_name: 'Patel',
    age: 38,
    occupation: 'Holistic Health Coach',
    interests: ['Meditation', 'Ayurveda', 'Hiking'],
    relationship_type: 'Close Friend',
    notes: 'A safe harbor for Sarah. They do not discuss family logistics.',
  },
};

export const ELENA_RODRIGUEZ: SeedPerson = {
  id: 'a44f7563-4236-43c6-9c03-3c526089305f',
  name: 'Elena Rodriguez',
  description:
    "A former colleague of Sarah's. She matches Sarah's ambition but offers a safe space to vent about corporate burnout.",
  properties: {
    first_name: 'Elena',
    last_name: 'Rodriguez',
    age: 41,
    occupation: 'Creative Director',
    interests: ['Modern Art', 'Wine Tasting', 'Travel'],
    relationship_type: 'Professional/Social',
    notes: 'Understand the "healthy perfectionism" struggle in a work context.',
  },
};

export const CLAIRE_THOMPSON: SeedPerson = {
  id: '22c377a0-c300-4aee-b6e9-f5c0813dfcb1',
  name: 'Claire Thompson',
  description:
    "Sarah's 'quiet' friend. They share a love for literature and comfortable silence, which is very different from my high-energy friendships.",
  properties: {
    first_name: 'Claire',
    last_name: 'Thompson',
    age: 42,
    occupation: 'Museum Curator',
    interests: ['Classic Literature', 'Oil Painting', 'Indie Films'],
    relationship_type: 'Intellectual Companion',
    notes: 'Met at a gallery opening. They often sit in comfortable silence.',
  },
};

export const RACHEL_BENNETT: SeedPerson = {
  id: 'd145b85e-3a2e-4fcd-a703-d742b06152be',
  name: 'Rachel Bennett',
  description:
    "The mother of Lucas's friend. She's pragmatic and bubbly, helping pull Sarah out of her head and into the community.",
  properties: {
    first_name: 'Rachel',
    last_name: 'Bennett',
    age: 39,
    occupation: 'Interior Designer',
    interests: ['Home Decor', 'Cooking', 'Community Events'],
    relationship_type: 'Parent Friend',
    notes: 'Helps Sarah embrace the messy reality of raising a 10-year-old boy.',
  },
};

export const JESSICA_MILLER: SeedPerson = {
  id: 'ac13927c-d52a-4a32-b73d-d41f533ad01f',
  name: "Jessica 'Jess' Miller",
  description:
    "Sarah's college roommate. She knew Sarah before the kids and the career, reminding her of her fun, unstructured side.",
  properties: {
    first_name: 'Jessica',
    last_name: 'Miller',
    age: 40,
    occupation: 'Journalist',
    interests: ['Politics', 'Travel', 'Photography'],
    relationship_type: 'Old Friend',
    notes: 'The only one who calls her "Sah." A link to her pre-marriage identity.',
  },
};

export const NINA_KOVAC: SeedPerson = {
  id: '332d06bf-711e-4c76-a341-b8798e3375cd',
  name: 'Nina Kovac',
  description:
    'A local artist and mentor to Sarah. She challenges Sarah to embrace imperfection in her pottery, something I struggle to understand.',
  properties: {
    first_name: 'Nina',
    last_name: 'Kovac',
    age: 55,
    occupation: 'Ceramicist / Studio Owner',
    interests: ['Sculpture', 'Gardening', 'Jazz'],
    relationship_type: 'Mentor',
    notes: 'Challenges Sarah to let the clay be "imperfect." A mentor for her "gentle nature."',
  },
};

export const REBECCA_LEWIS: SeedPerson = {
  id: 'a50a1f55-7530-4550-87c6-04b946c4d571',
  name: 'Rebecca Lewis',
  description:
    "A family therapist and mom in Emma's class. She helps Sarah navigate the emotional complexity of raising our daughter.",
  properties: {
    first_name: 'Rebecca',
    last_name: 'Lewis',
    age: 43,
    occupation: 'Family Therapist',
    interests: ['Psychology', 'Walking', 'Coffee'],
    relationship_type: 'Parent Friend',
    notes: 'Provides Sarah with perspective on Emma’s intense emotional advocacy.',
  },
};

export const DAVID_WU: SeedPerson = {
  id: '72fd544c-2048-4c65-ad81-82aec368c667',
  name: 'David Wu',
  description:
    'A retired executive who mentored Sarah. I know she respects his quiet leadership and consults him on career moves.',
  properties: {
    first_name: 'David',
    last_name: 'Wu',
    age: 58,
    occupation: 'CMO (Retired)',
    interests: ['Golf', 'Business Strategy', 'Philanthropy'],
    relationship_type: 'Professional Mentor',
    notes: 'Sarah consults him when she feels her "gentle nature" is being mistaken for passivity at work.',
  },
};

export const KAREN_VOS: SeedPerson = {
  id: 'ab5b2109-a63a-4bfe-98f5-f957760c0fb6',
  name: 'Karen Vos',
  description:
    "Our next-door neighbor. It's a low-stakes relationship that provides us with a sense of local stability and fresh garden produce.",
  properties: {
    first_name: 'Karen',
    last_name: 'Vos',
    age: 62,
    occupation: 'Librarian',
    interests: ['Gardening', 'Baking', 'Bird Watching'],
    relationship_type: 'Neighbor',
    notes: 'Provides a sense of local stability. Often exchanges produce from the garden.',
  },
};

export const MARK_OCONNELL: SeedPerson = {
  id: 'ef0c3a83-930b-4d40-919f-8acbfda59f5f',
  name: "Mark O'Connell",
  description:
    "My cycling friend, though he and Sarah bond over cooking. He's one of the few who can bridge my intensity with Sarah's introspection.",
  properties: {
    first_name: 'Mark',
    last_name: "O'Connell",
    age: 44,
    occupation: 'Architect',
    interests: ['Cycling', 'Culinary Arts', 'Design'],
    relationship_type: 'Family Friend',
    notes:
      'One of the few people who can navigate both John’s intensity and Sarah’s introspection effortlessly.',
  },
};

export const SARAH_FRIENDS: SeedPerson[] = [
  MAYA_PATEL,
  ELENA_RODRIGUEZ,
  CLAIRE_THOMPSON,
  RACHEL_BENNETT,
  JESSICA_MILLER,
  NINA_KOVAC,
  REBECCA_LEWIS,
  DAVID_WU,
  KAREN_VOS,
  MARK_OCONNELL,
];
