import { provisionalTitleFromMessage, sidebarTitleFromModel } from '../threadTitle';

describe('sidebarTitleFromModel', () => {
  it('keeps about three title-case words', () => {
    expect(sidebarTitleFromModel('confirm home address')).toBe('Confirm Home Address');
  });

  it('strips thinking traces, quotes, and extra words', () => {
    expect(
      sidebarTitleFromModel('<think>hmm</think> "Parents vs home airport extra filler words here"'),
    ).toBe('Parents Vs Home Airport Extra Filler');
  });

  it('returns empty when the model said nothing usable', () => {
    expect(sidebarTitleFromModel('...')).toBe('');
  });
});

/**
 * What a thread is called when the model could not name it: the person's own first words. A title is a sidebar
 * label, so it is cut at a word boundary — and left bare, because an ellipsis on a label reads as a truncated one.
 */
describe('provisionalTitleFromMessage', () => {
  it('keeps a short message exactly as written', () => {
    expect(provisionalTitleFromMessage('What is on Brief?')).toBe('What is on Brief?');
  });

  it('collapses the whitespace a pasted or multi-line message carries', () => {
    expect(provisionalTitleFromMessage('  Plan   dinner\n\nfor   Friday  ')).toBe('Plan dinner for Friday');
  });

  it('cuts a long message at the last word that fits in 60 characters, with no ellipsis', () => {
    const message = 'Please summarise everything my family said about the move to Lisbon last spring';
    const title = provisionalTitleFromMessage(message);

    expect(title).toBe('Please summarise everything my family said about the move to');
    expect(title.length).toBeLessThanOrEqual(60);
    expect(message.startsWith(title)).toBe(true);
    expect(title).not.toMatch(/[.…]$/);
  });

  it('keeps a word that ends exactly on the limit', () => {
    const message = `${'a'.repeat(59)} next words`;

    expect(provisionalTitleFromMessage(message)).toBe('a'.repeat(59));
    expect(provisionalTitleFromMessage(`${'a'.repeat(60)} next`)).toBe('a'.repeat(60));
  });

  it('cuts a single unbroken token at the limit rather than returning nothing', () => {
    expect(provisionalTitleFromMessage('x'.repeat(200))).toBe('x'.repeat(60));
  });

  it('drops punctuation stranded by the cut', () => {
    const message = `${'word '.repeat(11)}and, then more`;

    expect(provisionalTitleFromMessage(message)).toBe(
      'word word word word word word word word word word word and',
    );
  });

  it('returns empty when there is nothing to use', () => {
    expect(provisionalTitleFromMessage('   \n ')).toBe('');
    expect(provisionalTitleFromMessage(null)).toBe('');
    expect(provisionalTitleFromMessage(undefined)).toBe('');
  });
});
