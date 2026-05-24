import type { CreateNoteDto } from '@ci/domains/notes/types';

import { JOHN_SMITH } from './users';

type SeedNote = RequiredFields<CreateNoteDto, 'id'> & {
  userId: string;
};

export const NOTES: SeedNote[] = [
  {
    id: '88f15aa5-667e-42ba-85bd-9ab4b6150f40',
    title: 'Bike maintenance',
    content:
      'Drop off the Tarmac at the shop. The shifting is skipping in the 3rd cog. Might need a new cassette.',
    userId: JOHN_SMITH.id,
  },
  {
    id: '5dbd8a60-fbf5-4e26-b1d8-aa92c360b19d',
    title: "Sarah's Birthday",
    content:
      'Brainstorming ideas: maybe a weekend in Ojai or that cooking class she mentioned? Need to book at least 3 weeks out.',
    userId: JOHN_SMITH.id,
  },
  {
    id: 'e93730d6-e84e-465a-826a-2c8679d7f50c',
    title: 'Backyard Project',
    content:
      'Need to measure the patio for the new planter boxes. Thinking 12ft by 2ft along the back fence.',
    userId: JOHN_SMITH.id,
  },
  {
    id: 'dcbfdc0f-c49a-4c6e-a3bc-6fbff8b1d0c1',
    title: 'Work - API Latency',
    content:
      'Look into the redis caching layer. It seems like cache misses are spiking during the morning standup window. Maybe increase TTL?',
    userId: JOHN_SMITH.id,
  },
  {
    id: '0d7459f7-a401-43d9-ae37-d657aa8bbfb1',
    title: 'Lucas Soccer',
    content:
      'Talk to the coach about his playing time. He seemed bummed after the last game. Also need to sign up for snack duty.',
    userId: JOHN_SMITH.id,
  },
  {
    id: '15de4a97-3ba2-49c5-853e-7dc9fef82e17',
    title: "Emma's Art Supplies",
    content:
      "Remember to pick up more charcoal at Art Supply Warehouse. She's going through it fast. Maybe get her that easel she looked at?",
    userId: JOHN_SMITH.id,
  },
  {
    id: 'f89ba5b6-77ff-4a7c-9e2a-a82dfa15daf4',
    title: 'Grocery List',
    content: 'Almond milk, coffee beans (get the blend from Zinc), avocados, sourdough, spicy hummus.',
    userId: JOHN_SMITH.id,
  },
  {
    id: '7346baa5-a70a-4af6-a68a-9ec2d9fe1744',
    title: 'Book Recs',
    content:
      'Ask Robert what that sci-fi book was he mentioned during the 1:1. Something about three bodies?',
    userId: JOHN_SMITH.id,
  },
  {
    id: '3c33389e-9fd3-460c-94a9-56804b6c6262',
    title: 'Home Audio',
    content:
      'The Sonos in the living room keeps cutting out. Need to reset the router or check the mesh point location.',
    userId: JOHN_SMITH.id,
  },
  {
    id: '14209109-e0e5-4719-9e53-651432b8c5da',
    title: 'Vacation Planning',
    content:
      'Look into flights for summer. Maybe Italy? Or just Hawaii again? need to check blackout dates for work.',
    userId: JOHN_SMITH.id,
  },
  {
    id: '81e47779-da10-4faa-b12e-d300d8018e90',
    title: 'Frontend Sync',
    content:
      "Make sure to bring up the component library consistency issue in tomorrow's sync. The buttons are all over the place.",
    userId: JOHN_SMITH.id,
  },
  {
    id: '248f8594-8d5d-4714-addb-2cf8fc134c26',
    title: 'Gift for Mom',
    content:
      "Call her on Sunday. Send flowers for Mother's Day early this year so they actually arrive on time.",
    userId: JOHN_SMITH.id,
  },
  {
    id: '2f5b807d-bd80-416e-915f-57ece18d56c9',
    title: 'Investment Check',
    content: 'Review the 401k allocation. Feels a bit too heavy on bonds right now given the market shifts.',
    userId: JOHN_SMITH.id,
  },
  {
    id: '011675b2-10b4-46ec-914b-9efbaf5d2a59',
    title: 'Car Service',
    content: "Schedule the Tesla for tire rotation. It's been 10k miles. Check the alignment too.",
    userId: JOHN_SMITH.id,
  },
  {
    id: 'ddcf71f7-1093-4479-a7af-157de7919860',
    title: 'Date Night Idea',
    content:
      "Reservations at Nick's for Friday at 7pm? need to check availability. Alternatively, try that new sushi spot.",
    userId: JOHN_SMITH.id,
  },
  {
    id: '957e3981-1397-464a-b1b9-a56d1f9c5b17',
    title: 'Coding Idea',
    content:
      'Maybe we could use vector search for the documentation too? Not just the main content. value add for new devs.',
    userId: JOHN_SMITH.id,
  },
  {
    id: '4cb539f4-2091-43fe-9eda-6e4a5b54d74c',
    title: 'Health Check',
    content: 'Schedule dermatologist appointment. Overdue for a check-up. Also need to refill allergy meds.',
    userId: JOHN_SMITH.id,
  },
  {
    id: '6f9696fd-e8bc-4baa-ac85-39a8c35b3c8a',
    title: 'Wine Club',
    content:
      "Pick up the shipment from the winery. It's been sitting there for two weeks. Don't let it bake in the heat.",
    userId: JOHN_SMITH.id,
  },
  {
    id: 'cd2bf09a-ae97-415d-a5d2-b86ab1d400bd',
    title: 'Morning Routine',
    content:
      'Try to wake up at 5:30 tomorrow to get a solid hour of deep work in before the kids wake up. Coffee auto-start?',
    userId: JOHN_SMITH.id,
  },
  {
    id: 'b6d07c3f-61dc-4bbb-978e-b11c3330672f',
    title: 'Podcast',
    content: 'Start listening to that new episode on focus tools. Sounds relevant for the deep work blocks.',
    userId: JOHN_SMITH.id,
  },
];
