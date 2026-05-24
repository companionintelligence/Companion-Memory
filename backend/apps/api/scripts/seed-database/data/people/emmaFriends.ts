import type { SeedPerson } from './types';

export const ZOE_RICHARDS: SeedPerson = {
  id: 'a42a7736-b094-48fd-a59f-5d648204f707',
  name: 'Zoe Richards',
  description:
    "Emma's 'partner in crime'. She feeds Emma's intensity for social causes, dragging her to marches that sometimes baffle me.",
  properties: {
    first_name: 'Zoe',
    last_name: 'Richards',
    age: 14,
    occupation: 'Student',
    interests: ['Activism', 'Environmental Science', 'Debate'],
  },
};

export const MIA_WONG: SeedPerson = {
  id: '747ef879-f542-462e-b524-89ca74825acc',
  name: 'Mia Wong',
  description:
    "Emma's artistic collaborator. They spend hours in silence, which validates Emma's need for introspection.",
  properties: {
    first_name: 'Mia',
    last_name: 'Wong',
    age: 14,
    occupation: 'Student',
    interests: ['Digital Art', 'Poetry', 'Anime'],
  },
};

export const OLIVER_CROSS: SeedPerson = {
  id: 'b02f761a-563b-4ea3-b5a8-6ebeed205399',
  name: 'Oliver Cross',
  description:
    "The drama enthusiast. He encourages Emma to express her 'big feelings' on stage, which is probably healthy for her.",
  properties: {
    first_name: 'Oliver',
    last_name: 'Cross',
    age: 15,
    occupation: 'Student',
    interests: ['Theater', 'Musical Theater', 'Vintage Clothing'],
  },
};

export const SOPHIA_LEE: SeedPerson = {
  id: '21ab66b0-d694-4003-9775-0fd7bb0a0369',
  name: 'Sophia Lee',
  description:
    "Jessica's daughter. A lifelong friend who offers Emma a safe, normal teenage escape when the emotional intensity gets too high.",
  properties: {
    first_name: 'Sophia',
    last_name: 'Lee',
    age: 14,
    occupation: 'Student',
    interests: ['Pop Music', 'TikTok', 'Baking'],
  },
};

export const HARPER_VANCE: SeedPerson = {
  id: '7ae8b338-22f7-4ac7-a155-36ee48d49590',
  name: 'Harper Vance',
  description:
    'The disruptor. She questions authority even more than Emma does, which makes me nervous but forces us to examine our values.',
  properties: {
    first_name: 'Harper',
    last_name: 'Vance',
    age: 15,
    occupation: 'Student',
    interests: ['Punk Rock', 'Skateboarding', 'Zines'],
  },
};

export const AIDEN_BROOKS: SeedPerson = {
  id: '66ff3eb6-a3ad-4759-88cf-5aa9a2283bd3',
  name: 'Aiden Brooks',
  description:
    "Emma's intellectual rival. He challenges her empathy with logic, helping shapen her arguments before she brings them to me.",
  properties: {
    first_name: 'Aiden',
    last_name: 'Brooks',
    age: 14,
    occupation: 'Student',
    interests: ['Philosophy', 'Coding', 'Chess'],
  },
};

export const ISABELLA_GOMEZ: SeedPerson = {
  id: 'b0b921bb-cdc5-49b6-a6f0-a7b81a7136e1',
  name: 'Isabella Gomez',
  description:
    'The compassionate listener. She provides the emotional co-regulation that I sometimes struggle to give Emma myself.',
  properties: {
    first_name: 'Isabella',
    last_name: 'Gomez',
    age: 14,
    occupation: 'Student',
    interests: ['Psychology', 'Volunteering', 'Animals'],
  },
};

export const JACKSON_HAYES: SeedPerson = {
  id: '3266c7d8-e145-42bd-9f10-9f9651835dd8',
  name: 'Jackson Hayes',
  description:
    'The music snob. He gives Emma a cultural identity distinct from ours, introducing her to indie bands and vinyl.',
  properties: {
    first_name: 'Jackson',
    last_name: 'Hayes',
    age: 15,
    occupation: 'Student',
    interests: ['Guitar', 'Indie Music', 'Photography'],
  },
};

export const LILY_CHEN: SeedPerson = {
  id: '0581385b-59ee-45f5-a77a-7fcf59075b19',
  name: 'Lily Chen',
  description:
    'An online-literate friend who helps Emma channel her advocacy into digital formats like blogging.',
  properties: {
    first_name: 'Lily',
    last_name: 'Chen',
    age: 14,
    occupation: 'Student',
    interests: ['Blogging', 'Graphic Design', 'Social Media'],
  },
};

export const CHLOE_LEWIS: SeedPerson = {
  id: 'b5964965-feed-4c54-b770-fe7283d7bdcd',
  name: 'Chloe Lewis',
  description:
    "Rebecca's daughter. Being older, she acts as a mentor to Emma, guiding her through the teenage years that Sarah and I find daunting.",
  properties: {
    first_name: 'Chloe',
    last_name: 'Lewis',
    age: 16,
    occupation: 'Student',
    interests: ['College Prep', 'Journalism', 'Feminism'],
  },
};

export const EMMA_FRIENDS: SeedPerson[] = [
  ZOE_RICHARDS,
  MIA_WONG,
  OLIVER_CROSS,
  SOPHIA_LEE,
  HARPER_VANCE,
  AIDEN_BROOKS,
  ISABELLA_GOMEZ,
  JACKSON_HAYES,
  LILY_CHEN,
  CHLOE_LEWIS,
];
