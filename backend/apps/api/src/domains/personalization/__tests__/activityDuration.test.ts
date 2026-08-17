import { estimateActivityDurationMinutes, parseExplicitDuration } from '../activityDuration';

describe('parseExplicitDuration', () => {
  it('reads a single hour count', () => {
    expect(parseExplicitDuration('the movie is 2 hours')).toBe(120);
  });

  it('averages a range', () => {
    expect(parseExplicitDuration('usually 2-3 hours')).toBe(150);
  });

  it('reads minutes', () => {
    expect(parseExplicitDuration('soccer is 90 minutes')).toBe(90);
  });
});

describe('estimateActivityDurationMinutes', () => {
  it('gives a soccer match 90 minutes', () => {
    expect(estimateActivityDurationMinutes('Soccer game with Wes')).toBe(90);
  });

  it('gives a movie about two and a half hours', () => {
    expect(estimateActivityDurationMinutes('Movie at the ArcLight')).toBe(150);
  });

  it('treats planning as a 45-minute block, not a 30-minute tick', () => {
    expect(estimateActivityDurationMinutes('Plan Your Trip to Japan')).toBe(45);
  });

  it('stretches a long multi-stop night', () => {
    expect(
      estimateActivityDurationMinutes(
        "I met with Wes in Venice and went to griffin's in century city. he just moved from NYC to LA",
      ),
    ).toBe(150);
  });

  it('prefers an explicit length over the keyword default', () => {
    expect(estimateActivityDurationMinutes('soccer match, 2 hours')).toBe(120);
  });
});
