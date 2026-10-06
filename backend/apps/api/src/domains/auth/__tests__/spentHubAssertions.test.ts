import { SpentHubAssertions } from '../utils/spentHubAssertions';

const NOW = 1_700_000_000_000;

describe('SpentHubAssertions', () => {
  it('lets a key be spent once', () => {
    const spent = new SpentHubAssertions();

    expect(spent.spend('nonce-a', NOW + 30_000, NOW)).toBe('spent');
    expect(spent.spend('nonce-a', NOW + 30_000, NOW + 1)).toBe('replayed');
    expect(spent.spend('nonce-b', NOW + 30_000, NOW + 1)).toBe('spent');
  });

  it('remembers a key until its header set stops verifying, and forgets it after', () => {
    const spent = new SpentHubAssertions();
    spent.spend('nonce-d', NOW + 30_000, NOW);

    // At expiresAt the header set still verifies (the skew check is inclusive), so it must still be spent.
    expect(spent.spend('nonce-d', NOW + 30_000, NOW + 30_000)).toBe('replayed');
    expect(spent.spend('nonce-d', NOW + 60_000, NOW + 30_001)).toBe('spent');
  });

  it('refuses to spend what it has no room to remember, and says so apart from a replay', () => {
    const spent = new SpentHubAssertions(2);
    spent.spend('nonce-a', NOW + 30_000, NOW);
    spent.spend('nonce-b', NOW + 30_000, NOW);

    expect(spent.spend('nonce-c', NOW + 30_000, NOW)).toBe('full');
    expect(spent.spend('nonce-a', NOW + 30_000, NOW)).toBe('replayed');
    // Room comes back as keys expire.
    expect(spent.spend('nonce-c', NOW + 60_000, NOW + 30_001)).toBe('spent');
    expect(spent.spend('nonce-a', NOW + 60_000, NOW + 30_001)).toBe('spent');
    expect(spent.spend('nonce-e', NOW + 60_000, NOW + 30_001)).toBe('full');
  });

  it('frees room from only the keys that have expired', () => {
    const spent = new SpentHubAssertions(2);
    spent.spend('nonce-a', NOW + 10_000, NOW);
    spent.spend('nonce-b', NOW + 30_000, NOW);

    expect(spent.spend('nonce-c', NOW + 40_000, NOW + 10_001)).toBe('spent');
    // nonce-b is still live, so the ledger is full again and nonce-b is still refused.
    expect(spent.spend('nonce-d', NOW + 40_000, NOW + 10_001)).toBe('full');
    expect(spent.spend('nonce-b', NOW + 30_000, NOW + 10_001)).toBe('replayed');
  });
});
