import {
  gmailApiLabelsToTakeout,
  headersFromGmailApi,
  headersFromOutlookMessage,
  liveMailDropReason,
} from '../human_correspondence';

describe('gmailApiLabelsToTakeout', () => {
  it('rewrites Gmail API labelIds into Takeout X-Gmail-Labels spelling', () => {
    expect(gmailApiLabelsToTakeout(['CATEGORY_PROMOTIONS', 'SPAM'])).toBe('CATEGORY PROMOTIONS,SPAM');
  });
});

describe('headersFromGmailApi', () => {
  it('injects labelIds as X-Gmail-Labels so the archive gate can read them', () => {
    const headers = headersFromGmailApi({
      headers: [
        { name: 'Subject', value: 'Deal' },
        { name: 'From', value: 'Shop <news@shop.example>' },
        { name: 'List-Unsubscribe', value: '<mailto:unsub@shop.example>' },
      ],
      labelIds: ['CATEGORY_PROMOTIONS', 'INBOX'],
    });

    expect(headers['X-Gmail-Labels']).toBe('CATEGORY PROMOTIONS,INBOX');
    expect(headers['List-Unsubscribe']).toBe('<mailto:unsub@shop.example>');
  });
});

describe('headersFromOutlookMessage', () => {
  it('maps junk inference to a Junk label and copies RFC bulk headers', () => {
    const headers = headersFromOutlookMessage({
      subject: 'Win big',
      from: { emailAddress: { name: 'Spam', address: 'a@bad.example' } },
      inferenceClassification: 'junk',
      internetMessageHeaders: [{ name: 'List-Unsubscribe', value: '<mailto:u@bad.example>' }],
    });

    expect(headers['X-Gmail-Labels']).toMatch(/Junk/i);
    expect(headers['List-Unsubscribe']).toBe('<mailto:u@bad.example>');
    expect(headers.From).toBe('Spam <a@bad.example>');
  });

  it('maps Other + high importance so a transactional Other message can be rescued', () => {
    const headers = headersFromOutlookMessage({
      subject: 'Your bill',
      inferenceClassification: 'other',
      importance: 'high',
    });

    expect(headers['X-Gmail-Labels'].toLowerCase()).toContain('category updates');
    expect(headers['X-Gmail-Labels'].toLowerCase()).toContain('important');
  });
});

describe('liveMailDropReason', () => {
  it('drops a newsletter under the archive slug bulk_filtered', () => {
    expect(
      liveMailDropReason({
        headers: {
          From: 'Shop <news@shop.example>',
          Subject: '50% off',
          'List-Unsubscribe': '<mailto:unsub@shop.example>',
        },
      }),
    ).toBe('bulk_filtered');
  });

  it('drops a draft under the archive slug draft', () => {
    expect(
      liveMailDropReason({
        headers: { Subject: 'unsent', From: 'me@example.com' },
        isExplicitDraft: true,
      }),
    ).toBe('draft');
  });

  it('keeps ordinary human mail', () => {
    expect(
      liveMailDropReason({
        headers: {
          From: 'Alice <alice@example.com>',
          Subject: 'Lunch tomorrow?',
        },
      }),
    ).toBeNull();
  });

  it('keeps a receipt that the bulk gate would otherwise drop', () => {
    expect(
      liveMailDropReason({
        headers: {
          From: 'Amazon <no-reply@amazon.com>',
          Subject: 'Your receipt from Amazon',
          'List-Unsubscribe': '<mailto:unsub@amazon.com>',
        },
        bodyText: 'Order total: $12.00',
      }),
    ).toBeNull();
  });

  it('does not drop when includeBulk is set', () => {
    expect(
      liveMailDropReason({
        headers: {
          From: 'Shop <news@shop.example>',
          Subject: '50% off',
          'List-Unsubscribe': '<mailto:unsub@shop.example>',
        },
        includeBulk: true,
      }),
    ).toBeNull();
  });
});
