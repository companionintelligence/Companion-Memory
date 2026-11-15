import { planningCommitmentSignal } from '../planningCommitmentSignal';

const USER = '0190c3f2-0000-7000-8000-000000000001';
const FLAG = 'PLANNING_COMMITMENT_DECISION';

function ingressReply(isCommitment: boolean): Response {
  return new Response(
    JSON.stringify({
      user_id: USER,
      intent: 'store_task',
      intent_confidence: 0.7,
      intent_distribution: {},
      is_commitment: isCommitment,
      commitment_probability: isCommitment ? 0.9 : 0.1,
      sensitivity: 0,
      sensitivity_distribution: {},
      calibrated: true,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('planningCommitmentSignal', () => {
  const previous = process.env[FLAG];

  afterEach(() => {
    jest.restoreAllMocks();

    if (previous === undefined) {
      delete process.env[FLAG];
    } else {
      process.env[FLAG] = previous;
    }
  });

  it('makes no request and reports no signal while PLANNING_COMMITMENT_DECISION is off', async () => {
    delete process.env[FLAG];
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(ingressReply(false));

    await expect(planningCommitmentSignal(USER, 'Your verification code is 918273')).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('asks /decision/ingress with the message text and returns is_commitment when the flag is on', async () => {
    process.env[FLAG] = 'true';
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(ingressReply(false));

    await expect(planningCommitmentSignal(USER, 'Subject\nPlease send the report')).resolves.toBe(false);

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];

    expect(url).toContain(`/decision/ingress?user_id=${USER}`);
    expect(JSON.parse(String(init.body))).toEqual({ text: 'Subject\nPlease send the report' });
  });

  it('reports no signal when the sidecar fails, so the caller keeps its outcome', async () => {
    process.env[FLAG] = '1';
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 503 }));

    await expect(planningCommitmentSignal(USER, 'anything')).resolves.toBeUndefined();
  });
});
