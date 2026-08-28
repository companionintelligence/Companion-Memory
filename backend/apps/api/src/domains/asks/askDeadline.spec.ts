import { ASK_TTL_HOURS_ENV_VAR, DEFAULT_ASK_TTL_HOURS, askTtlHours, defaultAskExpiry } from './askDeadline';

/**
 * The TTL knob is a DURATION, not an enable/disable — and every unreadable
 * value has to fall back to the default rather than to "no deadline".
 *
 * That asymmetry is the whole point. An ask with no deadline is the state
 * `AskExpiryService` exists to end: an approved ask that outlives its owner's
 * attention is "a permanent, revocation-immune authorization to disclose in
 * full", because `AskService.complete` deliberately does not re-check the
 * standing grant on the owner-approved path.
 */

const NOW = new Date('2026-08-21T00:00:00.000Z');
const MS_PER_HOUR = 60 * 60 * 1000;

describe('askTtlHours — nothing readable means the default, never "forever"', () => {
  it('uses the built-in default when the operator has said nothing', () => {
    expect(askTtlHours({})).toBe(DEFAULT_ASK_TTL_HOURS);
  });

  it('honours a positive finite override', () => {
    expect(askTtlHours({ [ASK_TTL_HOURS_ENV_VAR]: '6' })).toBe(6);
    expect(askTtlHours({ [ASK_TTL_HOURS_ENV_VAR]: '0.5' })).toBe(0.5);
  });

  it.each([
    ['an empty string', ''],
    ['whitespace', '   '],
    ['a typo', 'seventy-two'],
    // `0` in particular reads as an attempt to switch the sweep off, which is
    // the one thing this knob may not do.
    ['zero', '0'],
    ['a negative', '-5'],
    ['Infinity', 'Infinity'],
    ['NaN', 'NaN'],
  ])('falls back to the default for %s', (_label, raw) => {
    expect(askTtlHours({ [ASK_TTL_HOURS_ENV_VAR]: raw })).toBe(DEFAULT_ASK_TTL_HOURS);
  });
});

describe('defaultAskExpiry', () => {
  it('is always in the future, by the configured duration', () => {
    expect(defaultAskExpiry(NOW, {}).getTime()).toBe(NOW.getTime() + DEFAULT_ASK_TTL_HOURS * MS_PER_HOUR);
    expect(defaultAskExpiry(NOW, { [ASK_TTL_HOURS_ENV_VAR]: '2' }).getTime()).toBe(
      NOW.getTime() + 2 * MS_PER_HOUR,
    );
  });

  it('cannot be pushed into the past, which would expire every ask on the next sweep', () => {
    expect(defaultAskExpiry(NOW, { [ASK_TTL_HOURS_ENV_VAR]: '-1' }).getTime()).toBeGreaterThan(NOW.getTime());
  });
});
