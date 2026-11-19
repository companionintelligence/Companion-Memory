import {
  boundSearchPage,
  compactSearchHit,
  ENTRY_WINDOW_CHARACTERS,
  PAGE_CHARACTER_BUDGET,
  readEntryWindow,
  stringCapFor,
} from '../compactSearchHit';

/**
 * The shape of a real `knowledge_search` email hit, as OpenClaw received it over MCP on
 * 2026-11-13 (names, addresses and tokens replaced): every column of ci.communications, most of
 * them unset, and a body that is mostly calendar links.
 */
const TRACKING = 'eid=YnJzNzU0ZDZpcTBwNDllNGpxdWFsMHFnZjQgYmFyYW5reWxlMzBAbQ&tok=MjEjYmFyYW5reWxl';
const emailHit = {
  id: '01a189b1-3fb0-735b-bb12-e0f725c88137',
  type: 'communication' as const,
  link: '/communications/01a189b1-3fb0-735b-bb12-e0f725c88137',
  time: new Date('2025-05-19T18:19:46.000Z'),
  userId: '01a18985-db11-754b-bc27-96424b49413e',
  communicationType: 'email',
  deviceId: null,
  direction: 'inbound',
  threadId: '196e9c5f776a3882',
  fromEntityId: '01a189a9-0b31-7369-9a17-95cb1cd4d43c',
  toEntityIds: ['01a1899f-e1a9-7569-88a3-1baa30dd8356'],
  participantsMetadata: {
    cc: [],
    to: [{ name: 'Sam Owner', type: 'to', email: 'owner@example.com' }],
    bcc: [],
    from: [{ name: 'Google Calendar', type: 'from', email: 'calendar-notification@google.com' }],
  },
  metadata: {},
  subject: 'Notification: Reservation at a restaurant @ Mon May 19, 2025 2:30pm',
  content:
    'You have an upcoming event\r\n\r\n\r\n\r\nReservation at a restaurant\r\n' +
    `View all event details  \r\nhttps://calendar.google.com/calendar/event?action=VIEW&${TRACKING}\r\n` +
    'Short link https://g.co/calendar stays.\r\n',
  attachments: [],
  durationSeconds: null,
  sentimentScore: null,
  category: 'personal',
  summary: null,
  connectionId: '01a1899d-de36-75e3-8524-fa6da4ad5c75',
  isEncrypted: false,
  isArchived: false,
  preview: 'Reservation at a restaurant on Monday May 19, 2025',
  sourceType: 'ETL',
  sourceSystem: 'email',
  sourceId: 'calendar-d76a51c2@google.com',
};

describe('compactSearchHit', () => {
  it('keeps what the email says and drops the rest of its row', () => {
    expect(compactSearchHit(emailHit, 4_000)).toEqual({
      id: emailHit.id,
      type: 'communication',
      link: emailHit.link,
      time: '2025-05-19T18:19:46.000Z',
      communicationType: 'email',
      direction: 'inbound',
      threadId: '196e9c5f776a3882',
      participantsMetadata: {
        to: [{ name: 'Sam Owner', type: 'to', email: 'owner@example.com' }],
        from: [{ name: 'Google Calendar', type: 'from', email: 'calendar-notification@google.com' }],
      },
      subject: emailHit.subject,
      content:
        'You have an upcoming event\n\nReservation at a restaurant\n' +
        'View all event details\nhttps://calendar.google.com/…\n' +
        'Short link https://g.co/calendar stays.',
      category: 'personal',
      preview: emailHit.preview,
      sourceSystem: 'email',
    });
  });

  it('writes the identity first, so a reader that cuts the tail keeps it', () => {
    expect(Object.keys(compactSearchHit(emailHit, 4_000)).slice(0, 3)).toEqual(['id', 'type', 'link']);
  });

  it('caps a long string and says how much was cut', () => {
    const hit = compactSearchHit({ id: 'n1', type: 'note', text: 'x'.repeat(1_000) }, 300);

    expect(hit.text).toBe(
      `${'x'.repeat(300)}…[700 more characters; call knowledge_get with this id for the rest]`,
    );
  });

  it('bounds an array and says how many it left out', () => {
    const hit = compactSearchHit(
      { id: 'e1', type: 'event', attendees: Array.from({ length: 13 }, (_, i) => `guest ${i}`) },
      300,
    );

    expect(hit.attendees).toHaveLength(11);
    expect((hit.attendees as string[]).at(-1)).toBe('…and 3 more');
  });

  it('drops bookkeeping inside nested objects too', () => {
    const hit = compactSearchHit(
      {
        id: 'p1',
        type: 'person',
        name: 'A Restaurant',
        properties: { contact_type: 'email', connection_id: 'c1', owner_user_id: 'u1' },
      },
      300,
    );

    expect(hit).toEqual({
      id: 'p1',
      type: 'person',
      name: 'A Restaurant',
      properties: { contact_type: 'email' },
    });
  });

  it('keeps numbers, true and zero', () => {
    expect(
      compactSearchHit({ id: 't1', type: 'task', priority: 0, isRecurring: true, score: 0.5 }, 300),
    ).toEqual({ id: 't1', type: 'task', priority: 0, isRecurring: true, score: 0.5 });
  });

  it('shares the string allowance across the page', () => {
    expect(stringCapFor(1)).toBe(4_000);
    expect(stringCapFor(3)).toBe(2_000);
    expect(stringCapFor(10)).toBe(600);
    expect(stringCapFor(100)).toBe(300);
    expect(stringCapFor(0)).toBe(4_000);
  });
});

describe('boundSearchPage', () => {
  const note = (i: number) => ({
    id: `n${i}`,
    type: 'note',
    link: `/notes/n${i}`,
    text: `${i} `.repeat(400),
  });

  it('leaves a page that fits alone', () => {
    const { items, omitted } = boundSearchPage([emailHit]);

    expect(omitted).toBe(0);
    expect(items[0]).toEqual(compactSearchHit(emailHit, stringCapFor(1)));
  });

  it('shortens strings until a full page fits, keeping every hit', () => {
    const hits = Array.from({ length: 25 }, (_, i) => note(i));
    const { items, omitted } = boundSearchPage(hits);

    expect(omitted).toBe(0);
    expect(items).toHaveLength(25);
    expect(JSON.stringify(items).length).toBeLessThanOrEqual(PAGE_CHARACTER_BUDGET);
    expect(items.every((item) => item.link === `/notes/${item.id}`)).toBe(true);
  });

  it('leaves trailing hits out when even the shortest strings do not fit, and counts them', () => {
    const hits = Array.from({ length: 80 }, (_, i) => note(i));
    const { items, omitted } = boundSearchPage(hits);

    expect(items.length + omitted).toBe(80);
    expect(omitted).toBeGreaterThan(0);
    expect(items.map((item) => item.id)).toEqual(hits.slice(0, items.length).map((hit) => hit.id));
    expect(JSON.stringify(items).length).toBeLessThanOrEqual(PAGE_CHARACTER_BUDGET);
  });

  it('always keeps the first hit', () => {
    const { items, omitted } = boundSearchPage([note(1), note(2)], 50);

    expect(items.map((item) => item.id)).toEqual(['n1']);
    expect(omitted).toBe(1);
  });
});

describe('compactSearchHit padding', () => {
  it('drops the invisible preheader padding marketing email carries', () => {
    const padding = '\u034f \u200c \ufeff '.repeat(60);
    const hit = compactSearchHit(
      { id: 'c1', type: 'communication', preview: `An update to your account ${padding}` },
      300,
    );

    expect(hit.preview).toBe('An update to your account');
  });
});

describe('readEntryWindow', () => {
  const longEmail = {
    ...emailHit,
    content: Array.from({ length: 250 }, (_, i) => `Line ${i}: use code SAVE${i} by Friday.`).join('\n'),
  };

  it('returns the longest text whole from offset, and every other string capped', () => {
    const window = readEntryWindow(longEmail);

    expect(window.textField).toBe('content');
    expect(window.offset).toBe(0);
    expect(window.textLength).toBeGreaterThan(ENTRY_WINDOW_CHARACTERS);
    expect(window.content).toHaveLength(ENTRY_WINDOW_CHARACTERS);
    expect(window.nextOffset).toBe(ENTRY_WINDOW_CHARACTERS);
    expect(window.subject).toBe(emailHit.subject);
    // `preview` repeats the head of the text, and the row's bookkeeping goes as on a search hit.
    expect(window).not.toHaveProperty('preview');
    expect(window).not.toHaveProperty('userId');
    expect(Object.keys(window).slice(0, 3)).toEqual(['id', 'type', 'link']);
  });

  it('reads the next window from nextOffset, and the last one has no nextOffset', () => {
    const first = readEntryWindow(longEmail);
    const second = readEntryWindow(longEmail, first.nextOffset);

    expect(second.offset).toBe(ENTRY_WINDOW_CHARACTERS);
    expect(second.nextOffset).toBeUndefined();
    expect(`${first.content}${second.content}`).toHaveLength(first.textLength!);
    expect(second.content).toContain('SAVE249');
  });

  it('returns a short entry whole', () => {
    const window = readEntryWindow({ id: 'n1', type: 'note', title: 'Groceries', content: 'milk, eggs' });

    expect(window).toMatchObject({ textField: 'content', textLength: 10, offset: 0, content: 'milk, eggs' });
    expect(window.nextOffset).toBeUndefined();
  });

  it('clamps an offset past the end to an empty last window', () => {
    const window = readEntryWindow({ id: 'n1', type: 'note', content: 'milk, eggs' }, 999);

    expect(window).toMatchObject({ offset: 10, content: '' });
    expect(window.nextOffset).toBeUndefined();
  });

  it('leaves an entry with no text as a compact hit', () => {
    expect(readEntryWindow({ id: 't1', type: 'task', priority: 0 })).toEqual({
      id: 't1',
      type: 'task',
      priority: 0,
    });
  });
});
