import { SpentHubAssertions } from '../utils/spentHubAssertions';

const NOW = 1_700_000_000_000;

describe('SpentHubAssertions', () => {
  it('lets a key be spent once', () => {
    const spent = new SpentHubAssertions();

    expect(spent.spend('nonce-a', NOW + 30_000, NOW)).toBe(true);
    expect(spent.spend('nonce-a', NOW + 30_000, NOW + 1)).toBe(false);
    expect(spent.spend('nonce-b', NOW + 30_000, NOW + 1)).toBe(true);
  });

  it('remembers a key until its header set stops verifying, and forgets it after', () => {
    const spent = new SpentHubAssertions();
    spent.spend('nonce-d', NOW + 30_000, NOW);

    // At expiresAt the header set still verifies (the skew check is inclusive), so it must still be spent.
    expect(spent.spend('nonce-d', NOW + 30_000, NOW + 30_000)).toBe(false);
    expect(spent.spend('nonce-d', NOW + 60_000, NOW + 30_001)).toBe(true);
  });

  it('refuses to spend what it has no room to remember', () => {
    const spent = new SpentHubAssertions(2);
    spent.spend('nonce-a', NOW + 30_000, NOW);
    spent.spend('nonce-b', NOW + 30_000, NOW);

    expect(spent.spend('nonce-c', NOW + 30_000, NOW)).toBe(false);
    // Room comes back as keys expire.
    expect(spent.spend('nonce-c', NOW + 60_000, NOW + 30_001)).toBe(true);
  });
});
