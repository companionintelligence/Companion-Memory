import { type CreateSummaryDto } from '@ci/domains/summaries';

type SeedSummary = RequiredFields<CreateSummaryDto, 'summaryId'>;

import { JOHN_SMITH } from './users';

export const SUMMARIES: SeedSummary[] = [
  {
    summaryId: '01936cb0-0000-7000-8000-000000000001',
    userId: JOHN_SMITH.id,
    periodStart: new Date('2026-01-13T09:00:00Z'),
    periodEnd: new Date('2026-01-13T10:00:00Z'),
    periodType: 'hourly',
    timezone: 'UTC',
    sourceTypes: ['browser_activity', 'files'],
    title: 'Hourly Summary',
    content: {
      tokens_used: 420,
      key_insights: [
        'Focused coding session working on GraphQL implementation.',
        'Multiple file edits in the backend API codebase.',
        'Consistent browser activity related to TypeScript documentation.',
        'High productivity hour with minimal context switching.',
      ],
      summary_text:
        'The user engaged in a focused coding session from 09:00 to 10:00, working primarily on backend GraphQL implementation. Browser activity showed consistent reference to TypeScript and NestJS documentation, indicating active learning and development work.',
      activity_counts: {
        files: 8,
        total: 23,
        events: 0,
        api_logs: 0,
        messages: 0,
        positions: 0,
        activities: 0,
        measurements: 0,
        communications: 0,
        screen_captures: 0,
        browser_activity: 15,
      },
      structured_data: {
        tags: ['coding', 'backend_development', 'graphql', 'typescript', 'focused_work'],
        anomalies: [],
        key_insights: [
          'Focused coding session working on GraphQL implementation.',
          'Multiple file edits in the backend API codebase.',
          'Consistent browser activity related to TypeScript documentation.',
          'High productivity hour with minimal context switching.',
        ],
        summary_text:
          'The user engaged in a focused coding session from 09:00 to 10:00, working primarily on backend GraphQL implementation. Browser activity showed consistent reference to TypeScript and NestJS documentation, indicating active learning and development work.',
        notable_events: [
          'Created new SummaryEntity and SummaryService files.',
          'Multiple documentation lookups for TypeORM decorators.',
        ],
      },
    },
    confidenceScore: 1.0,
  },
  {
    summaryId: '01936cb0-0000-7000-8000-000000000004',
    userId: JOHN_SMITH.id,
    periodStart: new Date('2026-01-13T12:00:00Z'),
    periodEnd: new Date('2026-01-13T13:00:00Z'),
    periodType: 'hourly',
    timezone: 'UTC',
    sourceTypes: ['memory', 'relationships', 'browsing', 'places'],
    title: 'Anniversary Planning',
    content: {
      tokens_used: 156,
      key_insights: [
        "Book a 7:30 PM reservation at Carmine's Italian this weekend",
        'Compare availability and reviews for top Mexican spots nearby',
        'Text your babysitter to confirm availability for the night',
      ],
      summary_text:
        "Your anniversary is coming up. You and Sarah Smith most often dine at Carmine's Italian, The Willow Bistro, and El Camino Taqueria. I can book a table at your favorite, or suggest top-rated Mexican options within 25 miles—since they love Mexican.",
      activity_counts: {
        total: 10,
      },
      structured_data: {
        tags: ['Anniversary', 'Reservations', 'Planner'],
      },
    },
    confidenceScore: 0.95,
  },
  {
    summaryId: '01936cb0-0000-7000-8000-000000000002',
    userId: JOHN_SMITH.id,
    periodStart: new Date('2026-01-13T14:00:00Z'),
    periodEnd: new Date('2026-01-13T15:00:00Z'),
    periodType: 'hourly',
    timezone: 'UTC',
    sourceTypes: ['browser_activity', 'communications'],
    title: 'Hourly Summary',
    content: {
      tokens_used: 380,
      key_insights: [
        'Participated in team video meeting about feature planning.',
        'Reviewed pull requests and left feedback on GitHub.',
        'Responded to several Slack messages regarding project timelines.',
        'Brief context switch to check email and calendar.',
      ],
      summary_text:
        'The user had a collaboration-heavy hour from 14:00 to 15:00, participating in a team meeting and engaging in asynchronous communication. Activity included code reviews on GitHub and team coordination via Slack.',
      activity_counts: {
        files: 0,
        total: 18,
        events: 0,
        api_logs: 0,
        messages: 0,
        positions: 0,
        activities: 0,
        measurements: 0,
        communications: 7,
        screen_captures: 0,
        browser_activity: 11,
      },
      structured_data: {
        tags: ['meetings', 'collaboration', 'code_review', 'communication', 'team_coordination'],
        anomalies: [],
        key_insights: [
          'Participated in team video meeting about feature planning.',
          'Reviewed pull requests and left feedback on GitHub.',
          'Responded to several Slack messages regarding project timelines.',
          'Brief context switch to check email and calendar.',
        ],
        summary_text:
          'The user had a collaboration-heavy hour from 14:00 to 15:00, participating in a team meeting and engaging in asynchronous communication. Activity included code reviews on GitHub and team coordination via Slack.',
        notable_events: [
          'Video meeting: Feature planning discussion with engineering team.',
          'Reviewed 3 pull requests and provided detailed feedback.',
          'Coordinated sprint priorities with project manager.',
        ],
      },
    },
    confidenceScore: 0.95,
  },
  {
    summaryId: '01936cb0-0000-7000-8000-000000000005',
    userId: JOHN_SMITH.id,
    periodStart: new Date('2026-01-13T16:00:00Z'),
    periodEnd: new Date('2026-01-13T17:00:00Z'),
    periodType: 'hourly',
    timezone: 'UTC',
    sourceTypes: ['memory', 'events', 'people', 'locations'],
    title: 'Travel Coordination',
    content: {
      tokens_used: 142,
      key_insights: [
        'Draft an email to friends in Miami to coordinate a meetup',
        "Plan 3 fun activities around your hotel's location and schedule",
        'Block travel buffer time on your calendar',
      ],
      summary_text:
        "I noticed a flight to Miami in two weeks. Your friends in Miami include Ana, Marco, and Dev. Would you like me to send a warm note to them, or plan a short itinerary while you're there?",
      activity_counts: {
        total: 8,
      },
      structured_data: {
        tags: ['Travel', 'Friends', 'Planner'],
      },
    },
    confidenceScore: 0.92,
  },
  {
    summaryId: '01936cb0-0000-7000-8000-000000000003',
    userId: JOHN_SMITH.id,
    periodStart: new Date('2026-01-13T00:00:00Z'),
    periodEnd: new Date('2026-01-14T00:00:00Z'),
    periodType: 'daily',
    timezone: 'UTC',
    sourceTypes: ['browser_activity', 'files', 'communications'],
    title: 'Daily Summary',
    content: {
      tokens_used: 650,
      summary_text:
        'Productive day focused on backend development with balanced collaboration. Morning hours were highly productive with deep focus on implementing new GraphQL features. Afternoon included team meetings and code reviews. Evening showed lighter activity with documentation reading and planning for upcoming work.',
      activity_counts: {
        files: 24,
        total: 127,
        events: 0,
        api_logs: 3,
        messages: 0,
        positions: 0,
        activities: 0,
        measurements: 0,
        communications: 18,
        screen_captures: 0,
        browser_activity: 82,
      },
      structured_data: {
        tags: ['backend_development', 'graphql', 'team_collaboration', 'code_review', 'productive_day'],
        daily_rhythm: [
          'Morning: Peak productivity hours (08:00-12:00) focused on coding.',
          'Afternoon: Collaboration and meetings (13:00-17:00).',
          'Evening: Light activity with planning and documentation (18:00-20:00).',
        ],
        productivity_patterns: [
          'Highest focus during morning hours with minimal interruptions.',
          'Afternoon productivity balanced between meetings and code reviews.',
          'Clear separation between deep work and collaborative activities.',
          'Effective context switching between coding and communication tasks.',
        ],
        social_interactions: [
          'Team standup meeting at 09:30.',
          'Feature planning discussion with engineering team at 14:00.',
          'Multiple Slack conversations about project timelines and priorities.',
          'Code review collaboration with 3 team members on GitHub.',
        ],
        key_accomplishments: [
          'Implemented new Summary domain for backend API.',
          'Created SummaryEntity, SummaryService, and GraphQL types.',
          'Reviewed and approved 5 pull requests.',
          'Coordinated sprint planning with project manager.',
          'Updated technical documentation for new features.',
        ],
        notable_events: [
          'Completed major milestone: Summary feature backend implementation.',
          'Team decision to prioritize frontend integration for upcoming sprint.',
          'Identified and documented technical debt items for future cleanup.',
        ],
        mood_indicators: [
          'High engagement during coding sessions.',
          'Positive collaboration tone in team communications.',
          'Proactive in identifying improvement opportunities.',
        ],
      },
    },
    confidenceScore: 0.98,
  },
  {
    summaryId: '01936cb0-0000-7000-8000-000000000006',
    userId: JOHN_SMITH.id,
    periodStart: new Date('2026-01-14T09:00:00Z'),
    periodEnd: new Date('2026-01-14T10:00:00Z'),
    periodType: 'hourly',
    timezone: 'UTC',
    sourceTypes: ['memory', 'conversations', 'browsing', 'documents'],
    title: 'Dive Deeper on Interests',
    content: {
      tokens_used: 168,
      key_insights: [
        'Curated reading list from your recent articles and YouTube history: Product ML, experimentation, and growth analytics',
        "A new file has been saved locally with a summary of your Google Drive activity from the last two weeks related to work. I've summarized progress and highlighted next-step opportunities for the upcoming two weeks.",
      ],
      summary_text:
        'Here are high-impact follow‑ups based on your recent browser activity and reading. Your recent YouTube watch history shows an interest in machine learning for product analytics, so I compiled a focused reading list on that topic.',
      activity_counts: {
        total: 15,
      },
      structured_data: {
        tags: ['Productivity', 'Assistant', 'Summaries'],
      },
    },
    confidenceScore: 0.96,
  },
  {
    summaryId: '01936cb0-0000-7000-8000-000000000007',
    userId: JOHN_SMITH.id,
    periodStart: new Date('2026-01-14T12:00:00Z'),
    periodEnd: new Date('2026-01-14T13:00:00Z'),
    periodType: 'hourly',
    timezone: 'UTC',
    sourceTypes: ['memory', 'interests', 'chats', 'local_events'],
    title: "Kids' Hobbies",
    content: {
      tokens_used: 155,
      key_insights: [
        'Weekend cooking class at Little Chefs Studio (ages 7–12), plus a family-friendly recipe pack',
        'Summer camps short‑list based on interests (cooking, art, soccer) with registration deadlines',
        'Library maker‑space sessions near you; I can reserve spots and add to the family calendar',
      ],
      summary_text:
        'From recent chats, your kids have been enjoying cooking activities. I researched nearby activities they might love and put together a few options:',
      activity_counts: {
        total: 6,
      },
      structured_data: {
        tags: ['Family', 'Activities', 'Planner'],
      },
    },
    confidenceScore: 0.94,
  },
  {
    summaryId: '01936cb0-0000-7000-8000-000000000008',
    userId: JOHN_SMITH.id,
    periodStart: new Date('2026-01-14T15:00:00Z'),
    periodEnd: new Date('2026-01-14T16:00:00Z'),
    periodType: 'hourly',
    timezone: 'UTC',
    sourceTypes: ['vehicles', 'home', 'schedules'],
    title: 'Home & Car Upkeep',
    content: {
      tokens_used: 148,
      key_insights: [
        'Oil change due soon for your Honda Accord (last service ~4,900 miles ago). I can book with your usual shop',
        'Gutter cleaning recommended before the next rain—two providers have availability this week; want me to compare quotes?',
        'Replace HVAC filter (3 months elapsed); I can order the correct size and set a recurring reminder',
      ],
      summary_text: 'Quick maintenance wins to keep things running smoothly at home and on the road:',
      activity_counts: {
        total: 5,
      },
      structured_data: {
        tags: ['Maintenance', 'Home', 'Vehicle'],
      },
    },
    confidenceScore: 0.93,
  },
];
