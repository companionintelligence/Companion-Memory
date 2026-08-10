import { isLegacyReviewPrompt, promotionValueText } from '../promotionCandidatePayload';

describe('promotionCandidatePayload', () => {
  it('extracts value text from payload and evidence', () => {
    expect(promotionValueText({ inferredText: '  around 7am  ' }, [{ text: 'ignored' }])).toBe('around 7am');
    expect(promotionValueText({}, [{ text: 'Hiking' }])).toBe('Hiking');
  });

  it('detects legacy review prompt templates', () => {
    expect(isLegacyReviewPrompt('Companion found a possible interest: "07:00"')).toBe(true);
    expect(isLegacyReviewPrompt('Is it right that you wake up around 7am?')).toBe(false);
  });
});
