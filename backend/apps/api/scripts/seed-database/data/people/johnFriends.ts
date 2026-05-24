import type { SeedPerson } from './types';

export const TOM_WILSON: SeedPerson = {
  id: '019b80f8-77f1-72cc-9bd4-938fc879daa7',
  name: 'Tom Wilson',
  description:
    'My go-to hiking partner. As a fellow Architect, he appreciates structure as much as I do. We tackle trails with calculated precision.',
  properties: {
    first_name: 'Tom',
    last_name: 'Wilson',
    age: 43,
    occupation: 'Architect',
    interests: ['Endurance Hiking', 'Structural Design', 'Craft Beer'],
  },
};

export const JESSICA_LEE: SeedPerson = {
  id: '019b80f8-77f2-7331-ada3-7dd6e0b403ed',
  name: 'Jessica Lee',
  description:
    'A neighbor who grounds us. She respects our autonomy while offering a low-pressure way for our families to connect.',
  properties: {
    first_name: 'Jessica',
    last_name: 'Lee',
    age: 39,
    occupation: 'High School Teacher',
    interests: ['Community Gardening', 'Education', 'Local History'],
  },
};

export const CHRIS_MARTIN: SeedPerson = {
  id: '019b80f8-77f3-7724-8b4d-6de450468ad2',
  name: 'Chris Martin',
  description:
    "The 'Pacer'. Chris is the only one who can match my pace on the bike, pushing me hard enough to finally silence my anxious mind.",
  properties: {
    first_name: 'Chris',
    last_name: 'Martin',
    age: 41,
    occupation: 'Financial Analyst',
    interests: ['Road Cycling', 'Data Analytics', 'Triathlon Training'],
  },
};

export const MARK_THOMPSON: SeedPerson = {
  id: '019b80f8-77fd-75d4-863f-29dde0880cac',
  name: 'Mark Thompson',
  description:
    'My college roommate. We bond over optimizing the chemistry of brewing beer—a connection to a simpler time before mid-life pressures.',
  properties: {
    first_name: 'Mark',
    last_name: 'Thompson',
    age: 42,
    occupation: 'CPA / Accountant',
    interests: ['Home Brewing', 'Spreadsheets', 'BBQ Science'],
  },
};

export const LAURA_GARCIA: SeedPerson = {
  id: '019b80f8-77fe-7c94-9982-67946f4e64bb',
  name: 'Laura Garcia',
  description:
    "A kindred spirit for Sarah. While I don't know her well, I appreciate how she encourages Sarah's intellectual side through their book club.",
  properties: {
    first_name: 'Laura',
    last_name: 'Garcia',
    age: 38,
    occupation: 'Head Librarian',
    interests: ['Literary Fiction', 'Art History', 'Tea Culture'],
  },
};

export const STEVE_MILLER: SeedPerson = {
  id: '019b80f8-77ff-7165-9d58-c2baf9e33346',
  name: 'Steve Miller',
  description:
    "The 'Gear Head'. We can talk for hours about the engineering constraints of our bikes, satisfying my need to analyze how things work.",
  properties: {
    first_name: 'Steve',
    last_name: 'Miller',
    age: 44,
    occupation: 'Sales Director (Tech)',
    interests: ['Bicycle Mechanics', 'Wine Collecting', 'Gadgets'],
  },
};

export const AMANDA_BROWN: SeedPerson = {
  id: '019b80f8-7801-7dbb-82c2-a203f66ed680',
  name: 'Amanda Brown',
  description:
    'A soccer mom who helps us navigate the messy reality of sports schedules without the pressure of perfection.',
  properties: {
    first_name: 'Amanda',
    last_name: 'Brown',
    age: 39,
    occupation: 'Freelance Copywriter',
    interests: ['Youth Sports', 'Creative Writing', 'School Board'],
  },
};

export const BRIAN_WILSON: SeedPerson = {
  id: '019b80f8-7802-7761-a918-9314dd01f61d',
  name: 'Brian Wilson',
  description:
    "My functional strength coach. He helps me 'engineer' my body to handle the physical stress of my lifestyle.",
  properties: {
    first_name: 'Brian',
    last_name: 'Wilson',
    age: 30,
    occupation: 'Kinesiologist / Trainer',
    interests: ['Functional Mobility', 'Bio-hacking', 'Rugby'],
  },
};

export const KAREN_DAVIS: SeedPerson = {
  id: '019b80f8-7803-77fd-8d51-42dad9562413',
  name: 'Karen Davis',
  description:
    'A geologist and hiker who appeals to my love of competence. I can actually relax when she plans a trip because I trust her expertise.',
  properties: {
    first_name: 'Karen',
    last_name: 'Davis',
    age: 46,
    occupation: 'Field Geologist',
    interests: ['Geomorphology', 'Nature Photography', 'Rock Climbing'],
  },
};

export const PAUL_ANDERSON: SeedPerson = {
  id: '019b80f8-7804-7e02-966d-2e092c1c3c11',
  name: 'Paul Anderson',
  description:
    'A mentor I met at the coffee shop. He challenges my constant need for action, teaching me the value of just sitting still.',
  properties: {
    first_name: 'Paul',
    last_name: 'Anderson',
    age: 55,
    occupation: 'Retired Engineer',
    interests: ['Espresso', 'Philosophy', 'Chess'],
  },
};

export const JOHN_FRIENDS: SeedPerson[] = [
  TOM_WILSON,
  JESSICA_LEE,
  CHRIS_MARTIN,
  MARK_THOMPSON,
  LAURA_GARCIA,
  STEVE_MILLER,
  AMANDA_BROWN,
  BRIAN_WILSON,
  KAREN_DAVIS,
  PAUL_ANDERSON,
];
