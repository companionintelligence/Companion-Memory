import { ModelTierRouter } from '../services/ModelTierRouter';

describe('ModelTierRouter', () => {
  const router = new ModelTierRouter();

  it('keeps small, shallow tasks on-device', () => {
    const d = router.decide({ estimatedInputTokens: 500, toolDepth: 2 });

    expect(d.tier).toBe('on_device');
    expect(d.downgraded).toBe(false);
  });

  it('escalates when the context exceeds the on-device window', () => {
    const d = router.decide({ estimatedInputTokens: 20_000, cloudAvailable: true });

    expect(d.tier).toBe('private_cloud');
    expect(d.profile.maxContextTokens).toBe(32_768);
    expect(d.downgraded).toBe(false);
  });

  it('escalates for deep reasoning and deep tool chains', () => {
    expect(router.decide({ reasoningLevel: 'deep', cloudAvailable: true }).tier).toBe('private_cloud');
    expect(router.decide({ toolDepth: 8, cloudAvailable: true }).tier).toBe('private_cloud');
  });

  it('pins on-device when localOnly is set, marking it downgraded', () => {
    const d = router.decide({ estimatedInputTokens: 20_000, localOnly: true, cloudAvailable: true });

    expect(d.tier).toBe('on_device');
    expect(d.downgraded).toBe(true);
    expect(d.reasons.some((r) => r.includes('localOnly'))).toBe(true);
  });

  it('localOnly overrides an explicit forceTier=private_cloud (privacy first)', () => {
    const d = router.decide({ forceTier: 'private_cloud', localOnly: true });

    expect(d.tier).toBe('on_device');
    expect(d.downgraded).toBe(true);
  });

  it('falls back on-device when escalation is wanted but the cloud tier is down', () => {
    const d = router.decide({ requiresLargeContext: true, cloudAvailable: false });

    expect(d.tier).toBe('on_device');
    expect(d.downgraded).toBe(true);
    expect(d.reasons.some((r) => r.includes('cloud unavailable'))).toBe(true);
  });

  it('honours an explicit forceTier when reachable', () => {
    expect(router.decide({ forceTier: 'private_cloud', cloudAvailable: true }).tier).toBe('private_cloud');
    expect(router.decide({ forceTier: 'on_device', estimatedInputTokens: 99_999 }).tier).toBe('on_device');
  });

  it('forceTier=private_cloud falls back on-device when the cloud is down', () => {
    const d = router.decide({ forceTier: 'private_cloud', cloudAvailable: false });

    expect(d.tier).toBe('on_device');
    expect(d.downgraded).toBe(true);
  });

  it('defaults reasoning level to moderate and carries it through', () => {
    expect(router.decide({}).reasoningLevel).toBe('moderate');
    expect(router.decide({ reasoningLevel: 'light' }).reasoningLevel).toBe('light');
  });

  it('judges context against a caller-supplied window instead of the estimate', () => {
    // 20k tokens escalates against the estimated 8k on-device profile...
    expect(router.decide({ estimatedInputTokens: 20_000, cloudAvailable: true }).tier).toBe('private_cloud');

    // ...but not when the caller says the on-device model really holds 128k.
    const d = router.decide({
      estimatedInputTokens: 20_000,
      cloudAvailable: true,
      onDeviceContextTokens: 131_072,
    });

    expect(d.tier).toBe('on_device');
    expect(d.downgraded).toBe(false);
    // The decision reports the window it was judged against, not the estimate.
    expect(d.profile.maxContextTokens).toBe(131_072);
  });

  it('leaves the estimated profile alone when no window is supplied', () => {
    expect(router.decide({ estimatedInputTokens: 10 }).profile.maxContextTokens).toBe(8_192);
  });

  it('exposes both tier profiles', () => {
    const tiers = router.getProfiles().map((p) => p.tier);

    expect(tiers).toEqual(['on_device', 'private_cloud']);
  });
});
