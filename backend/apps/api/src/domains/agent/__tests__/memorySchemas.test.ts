import { agentMemorySchema, recallSchema, turnSchema } from '../types';

/**
 * The `/memory/*` request schemas, pinned against the exact payloads CI-Mentra
 * (the Mentra smart-glasses bridge, platform "mentra") sends, plus the bounds
 * a caller can trip over.
 */
describe('recallSchema', () => {
  it("accepts CI-Mentra's recall payload", () => {
    const payload = { query: 'what did I say about the dentist?', maxResults: 6 };
    expect(recallSchema.parse(payload)).toEqual(payload);
  });

  it('accepts a recall without maxResults', () => {
    expect(recallSchema.safeParse({ query: 'anything' }).success).toBe(true);
  });

  it.each([21, 0, 2.5])('rejects maxResults %p (must be an integer 1–20)', (maxResults) => {
    expect(recallSchema.safeParse({ query: 'anything', maxResults }).success).toBe(false);
  });

  it('accepts the maxResults bounds 1 and 20', () => {
    expect(recallSchema.safeParse({ query: 'q', maxResults: 1 }).success).toBe(true);
    expect(recallSchema.safeParse({ query: 'q', maxResults: 20 }).success).toBe(true);
  });
});

describe('turnSchema', () => {
  it("accepts CI-Mentra's turn payload", () => {
    const payload = {
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
      sessionId: 'companion:u:default',
      platform: 'mentra',
    };
    expect(turnSchema.parse(payload)).toEqual(payload);
  });

  it('rejects an empty messages array', () => {
    expect(turnSchema.safeParse({ messages: [], platform: 'mentra' }).success).toBe(false);
  });
});

describe('agentMemorySchema', () => {
  it("accepts CI-Mentra's write payload", () => {
    const payload = {
      content: 'User mentioned their dentist appointment is on Friday.',
      title: 'Dentist appointment',
      source: 'mentra',
      sessionId: 'companion:u:default',
    };
    expect(agentMemorySchema.parse(payload)).toEqual(payload);
  });

  it('rejects a source longer than 50 characters', () => {
    expect(agentMemorySchema.safeParse({ content: 'x', source: 'm'.repeat(51) }).success).toBe(false);
    expect(agentMemorySchema.safeParse({ content: 'x', source: 'm'.repeat(50) }).success).toBe(true);
  });
});
