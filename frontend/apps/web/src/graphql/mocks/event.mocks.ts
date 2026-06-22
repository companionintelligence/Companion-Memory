const MOCK_EVENTS_BASE = [
  {
    __typename: 'EventType' as const,
    id: 'event-0',
    title: 'Annual General Meeting',
    description: 'Yearly meeting to discuss company performance and future strategy.',
  },
  {
    __typename: 'EventType' as const,
    id: 'event-1',
    title: 'Product Launch',
    description: 'Launch event for the new product line.',
  },
  {
    __typename: 'EventType' as const,
    id: 'event-2',
    title: 'Team Building Workshop',
    description: 'Workshop focused on improving team collaboration and communication.',
  },
  {
    __typename: 'EventType' as const,
    id: 'event-3',
    title: 'Quarterly Review',
    description: 'Review of the quarterly financial results and operational metrics.',
  },
  {
    __typename: 'EventType' as const,
    id: 'event-4',
    title: 'Holiday Party',
    description: 'Annual holiday celebration for all employees.',
  },
  {
    __typename: 'EventType' as const,
    id: 'event-5',
    title: 'Tech Talk: AI Trends',
    description: 'Presentation on the latest trends in artificial intelligence.',
  },
  {
    __typename: 'EventType' as const,
    id: 'event-6',
    title: 'Client Appreciation Dinner',
    description: 'Dinner event to thank our key clients for their partnership.',
  },
  {
    __typename: 'EventType' as const,
    id: 'event-7',
    title: 'Hackathon',
    description: '24-hour coding competition for developers.',
  },
  {
    __typename: 'EventType' as const,
    id: 'event-8',
    title: 'Marketing Summit',
    description: 'Summit for marketing professionals to share insights and strategies.',
  },
  {
    __typename: 'EventType' as const,
    id: 'event-9',
    title: 'Sales Kickoff',
    description: 'Kickoff meeting for the sales team to set goals for the year.',
  },
  {
    __typename: 'EventType' as const,
    id: 'event-10',
    title: 'Design Sprint',
    description:
      'Intensive 5-day process for answering critical business questions through design, prototyping, and testing ideas with customers.',
  },
  {
    __typename: 'EventType' as const,
    id: 'event-11',
    title: 'Charity Run',
    description: 'Company-sponsored run to raise funds for local charities.',
  },
];

const EVENT_SOURCES = ['google_calendar', 'apple_calendar', 'spotify', 'amazon'];

export const MOCK_EVENTS = MOCK_EVENTS_BASE.map((event, i) => ({
  ...event,
  startTime: `2026-0${(i % 9) + 1}-15T09:00:00Z`,
  eventType: 'event',
  locationName: i % 3 === 0 ? 'San Francisco, CA' : null,
  sourceSystem: EVENT_SOURCES[i % EVENT_SOURCES.length],
}));
