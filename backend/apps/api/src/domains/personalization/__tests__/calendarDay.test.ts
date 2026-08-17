import {
  calendarQuestion,
  cleanCandidateTitle,
  looksLikeGapNote,
  upcomingEventQuestion,
  formatDayForQuestion,
  namedDayInText,
  suggestPlanDay,
} from '../calendarDay';

const LA = 'America/Los_Angeles';
const SUNDAY = new Date('2026-08-16T22:00:00.000Z'); // Sunday afternoon PT

describe('suggestPlanDay', () => {
  it('picks tomorrow when the window still covers it', () => {
    expect(suggestPlanDay(LA, new Date('2026-08-23T21:10:00.000Z'), '', SUNDAY)).toBe('2026-08-17');
  });

  it('uses tomorrow when the text says tomorrow', () => {
    expect(
      suggestPlanDay(
        LA,
        new Date('2026-08-23T21:10:00.000Z'),
        'meeting with Michael scheduled for tomorrow',
        SUNDAY,
      ),
    ).toBe('2026-08-17');
  });

  it('prefers a weekday named in the rationale', () => {
    expect(suggestPlanDay(LA, new Date('2026-08-23T21:10:00.000Z'), 'catch Liam on Thursday', SUNDAY)).toBe(
      '2026-08-20',
    );
  });

  it('stays quiet when the window has already ended', () => {
    expect(suggestPlanDay(LA, new Date('2026-08-16T01:00:00.000Z'), '', SUNDAY)).toBeUndefined();
  });
});

describe('formatDayForQuestion', () => {
  it('says Thursday for a day later this week', () => {
    expect(formatDayForQuestion('2026-08-20', LA, SUNDAY)).toBe('Thursday');
  });

  it('says the month and ordinal when the day is further out', () => {
    expect(formatDayForQuestion('2026-07-31', LA, SUNDAY)).toBe('July 31st');
  });
});

describe('cleanCandidateTitle', () => {
  it('strips the generate-job wrapper including a named day', () => {
    expect(
      cleanCandidateTitle('I have a plan for you for Monday: Discuss Project Deadlines with the Team'),
    ).toBe('Discuss Project Deadlines with the Team');
  });

  it('does not leave the wrapper in the spoken question', () => {
    expect(
      calendarQuestion('I have a plan for you for Monday: Discuss Project Deadlines with the Team', 'Monday'),
    ).toBe('Want me to put "Discuss Project Deadlines with the Team" on your calendar for Monday?');
  });
});

describe('upcomingEventQuestion', () => {
  it('turns a gap note into a real question without a clock time', () => {
    expect(upcomingEventQuestion('You have coming up: Backlog Grooming (Mon Aug 17 18:00)', 'Monday')).toBe(
      'Anything I should know about Backlog Grooming on Monday?',
    );
  });

  it('flags a pasted upcoming note as not speakable', () => {
    expect(looksLikeGapNote('You have coming up: Backlog Grooming (Mon Aug 17 18:00)')).toBe(true);
    expect(looksLikeGapNote('Anything I should know about Backlog Grooming on Monday?')).toBe(false);
  });
});

describe('namedDayInText', () => {
  it('skips a weekday that would be today', () => {
    expect(namedDayInText('maybe Sunday', '2026-08-16', '2026-08-23')).toBe('2026-08-23');
  });
});
