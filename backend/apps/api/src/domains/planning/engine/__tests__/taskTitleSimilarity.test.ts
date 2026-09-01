import {
  claimedSourceIds,
  findSimilarTitle,
  formatAlreadyTracked,
  newerDuplicateIds,
  normalizeTaskTitle,
  titlesAreSimilar,
} from '../taskTitleSimilarity';

describe('normalizeTaskTitle', () => {
  it('strips quotes and punctuation so the same job hashes the same', () => {
    expect(normalizeTaskTitle("Register for 'Network On Zoom'")).toBe(
      normalizeTaskTitle('Register for Network On Zoom'),
    );
  });
});

describe('titlesAreSimilar', () => {
  it('treats the Network On Zoom rephrasings as the same task', () => {
    const variants = [
      "Register for 'Network On Zoom'",
      'Register for Network On Zoom',
      "Register for the 'Network On Zoom' event to connect with professionals",
      'Register for the event to connect with professionals in Network On Zoom',
    ];

    for (const left of variants) {
      for (const right of variants) {
        expect(titlesAreSimilar(left, right)).toBe(true);
      }
    }
  });

  it('does not collapse unrelated work that shares a verb', () => {
    expect(titlesAreSimilar("Register for 'Network On Zoom'", 'Register for the dentist')).toBe(false);
    expect(titlesAreSimilar('Call mom', 'Call dad')).toBe(false);
    expect(titlesAreSimilar('Buy milk', 'Buy eggs')).toBe(false);
    expect(titlesAreSimilar('Pay the invoice', 'Reply to Sam')).toBe(false);
  });

  it('treats a shorter title as the same job when it is contained in a longer one', () => {
    expect(titlesAreSimilar('Call the vet', 'Call the vet about Mochi')).toBe(true);
  });
});

describe('findSimilarTitle / claimedSourceIds / formatAlreadyTracked', () => {
  it('finds the first near-duplicate in a backlog', () => {
    const match = findSimilarTitle('Register for Network On Zoom', [
      { title: 'Pay the invoice' },
      { title: "Register for 'Network On Zoom'" },
    ]);

    expect(match?.title).toBe("Register for 'Network On Zoom'");
  });

  it('collects source ids already stored on tasks', () => {
    expect(
      claimedSourceIds(
        [
          { metadata: { sourceCommunicationId: 'comm-1' } },
          { metadata: { sourceCommunicationId: ' comm-1 ' } },
          { metadata: {} },
          { metadata: { sourceCommunicationId: 'comm-2' } },
        ],
        'sourceCommunicationId',
      ),
    ).toEqual(new Set(['comm-1', 'comm-2']));
  });

  it('tells the model that an empty list is allowed', () => {
    const block = formatAlreadyTracked(["Register for 'Network On Zoom'", 'Pay the invoice']);

    expect(block).toContain('Already tracked');
    expect(block).toContain('Register for');
    expect(block).toContain('{"items":[]}');
    expect(block).toContain('empty list is better than a duplicate');
  });

  it('omits the block when there is nothing tracked yet', () => {
    expect(formatAlreadyTracked([])).toBe('');
  });

  it('keeps the oldest Network On Zoom card and drops the later rephrasings', () => {
    expect(
      newerDuplicateIds([
        {
          id: 'first',
          title: "Register for 'Network On Zoom'",
          status: 'proposed',
          createdAt: '2026-08-20T10:00:00.000Z',
        },
        {
          id: 'second',
          title: 'Register for Network On Zoom',
          status: 'proposed',
          createdAt: '2026-08-21T10:00:00.000Z',
        },
        {
          id: 'third',
          title: "Register for the 'Network On Zoom' event",
          status: 'proposed',
          createdAt: '2026-08-22T10:00:00.000Z',
        },
        {
          id: 'unrelated',
          title: 'Pay the invoice',
          status: 'proposed',
          createdAt: '2026-08-23T10:00:00.000Z',
        },
      ]),
    ).toEqual(['second', 'third']);
  });
});
