const MOCK_COMMUNICATIONS_BASE = [
  {
    __typename: 'CommunicationType' as const,
    id: 'communication-0',
    subject: 'Q4 Roadmap Review',
    preview: 'Please review the attached slides for the Q4 roadmap discussion happening this Friday.',
  },
  {
    __typename: 'CommunicationType' as const,
    id: 'communication-1',
    subject: 'Client Feedback Summary',
    preview: 'Here is a summary of the feedback received from the client regarding the latest release.',
  },
  {
    __typename: 'CommunicationType' as const,
    id: 'communication-2',
    subject: 'Urgent: Server Downtime',
    preview:
      'We are experiencing intermittent downtime on the main server. The DevOps team is investigating.',
  },
  {
    __typename: 'CommunicationType' as const,
    id: 'communication-3',
    subject: 'Holiday Party Invitation',
    preview: 'You are cordially invited to the annual holiday party! Please RSVP by next week.',
  },
  {
    __typename: 'CommunicationType' as const,
    id: 'communication-4',
    subject: 'New Policy Update',
    preview: 'Please read the updated remote work policy attached to this email.',
  },
  {
    __typename: 'CommunicationType' as const,
    id: 'communication-5',
    subject: 'Weekly Standup Notes',
    preview: 'Here are the notes from today’s standup meeting. Action items are highlighted in bold.',
  },
  {
    __typename: 'CommunicationType' as const,
    id: 'communication-6',
    subject: 'Design Mockups for Approval',
    preview: 'The design team has finalized the mockups for the new dashboard. Please review and approve.',
  },
  {
    __typename: 'CommunicationType' as const,
    id: 'communication-7',
    subject: 'Budget Approval Request',
    preview: 'Requesting approval for the software license renewal budget for the upcoming year.',
  },
  {
    __typename: 'CommunicationType' as const,
    id: 'communication-8',
    subject: 'Team Lunch Vote',
    preview: 'We are planning a team lunch next Wednesday. Please vote for your preferred restaurant.',
  },
  {
    __typename: 'CommunicationType' as const,
    id: 'communication-9',
    subject: 'Security Training Reminder',
    preview: 'This is a reminder to complete the mandatory security training by the end of the month.',
  },
  {
    __typename: 'CommunicationType' as const,
    id: 'communication-10',
    subject: 'Project Alpha Status Update',
    preview: 'Project Alpha is currently on track. We have completed the initial development phase.',
  },
  {
    __typename: 'CommunicationType' as const,
    id: 'communication-11',
    subject: 'Welcome New Hires',
    preview: 'Please join me in welcoming our new team members starting today!',
  },
];

const COMMUNICATION_TYPES = ['email', 'sms', 'email', 'imessage'];

export const MOCK_COMMUNICATIONS = MOCK_COMMUNICATIONS_BASE.map((communication, i) => ({
  ...communication,
  time: `2026-0${(i % 9) + 1}-12T14:30:00Z`,
  type: COMMUNICATION_TYPES[i % COMMUNICATION_TYPES.length],
  direction: i % 2 === 0 ? 'incoming' : 'outgoing',
  from: { __typename: 'PersonType' as const, id: `person-${i}`, name: 'Sample Sender' },
}));
