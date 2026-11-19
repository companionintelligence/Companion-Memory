import { PeerAnswerCollectionCron } from './PeerAnswerCollectionCron';

function make(enabled: boolean) {
  const outbound = { collectOpenAnswers: jest.fn().mockResolvedValue({ checked: 0, answered: 0 }) };
  const features = { isFeatureEnabled: jest.fn().mockResolvedValue(enabled) };
  const logger = { setContext: jest.fn(), log: jest.fn() };

  return {
    cron: new PeerAnswerCollectionCron(outbound as never, features as never, logger as never),
    outbound,
  };
}

describe('PeerAnswerCollectionCron', () => {
  it('collects while the ask feature is on', async () => {
    const { cron, outbound } = make(true);

    await cron.collectOpenAnswers();

    expect(outbound.collectOpenAnswers).toHaveBeenCalledTimes(1);
  });

  it('does nothing while it is off', async () => {
    const { cron, outbound } = make(false);

    await cron.collectOpenAnswers();

    expect(outbound.collectOpenAnswers).not.toHaveBeenCalled();
  });
});
