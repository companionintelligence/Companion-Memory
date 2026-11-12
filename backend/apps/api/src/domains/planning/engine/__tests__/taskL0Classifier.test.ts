import { classifyTaskL0, isTaskL0Class, TASK_L0_CLASSES } from '../taskL0Classifier';

describe('taskL0Classifier', () => {
  it('exposes the exact 8 canonical HBPE L0 classes', () => {
    expect(TASK_L0_CLASSES).toEqual([
      'WORK',
      'EXERCISE',
      'SOCIAL',
      'ERRAND',
      'LEISURE',
      'TRANSIT',
      'SLEEP',
      'UNKNOWN',
    ]);
    expect(isTaskL0Class('WORK')).toBe(true);
    expect(isTaskL0Class('ERRAND')).toBe(true);
    expect(isTaskL0Class('INVALID')).toBe(false);
  });

  it.each([
    ['Write the migration and open PR', null, 'WORK'],
    ['Prepare Q3 roadmap presentation for stakeholder sync', null, 'WORK'],
    ['Morning gym workout and 5k run', null, 'EXERCISE'],
    ['Evening yoga and stretching session', null, 'EXERCISE'],
    ['Dinner with Sarah and birthday celebration', null, 'SOCIAL'],
    ['Call mom to catch up', null, 'SOCIAL'],
    ["Pick up groceries at Trader Joe's and pharmacy prescription", null, 'ERRAND'],
    ['Schedule dentist appointment and pay electric bill', null, 'ERRAND'],
    ['Watch movie at the cinema and read novel', null, 'LEISURE'],
    ['Check in for SFO flight and head to airport', null, 'TRANSIT'],
    ['Take an afternoon power nap before bedtime', null, 'SLEEP'],
    ['Miscellaneous untitled thing', null, 'UNKNOWN'],
  ] as const)('classifies %s as %s', (title, description, expected) => {
    expect(classifyTaskL0(title, description)).toBe(expected);
  });

  it('weights title matches above secondary description/notes matches', () => {
    expect(
      classifyTaskL0(
        'Dentist appointment at 3pm',
        'Leave right after the sprint review meeting at work',
      ),
    ).toBe('ERRAND');
  });

  it('uses description or notes when the title is generic', () => {
    expect(
      classifyTaskL0(
        'Follow up on Friday',
        null,
        'Review the pull request and architecture RFC before deployment',
      ),
    ).toBe('WORK');
  });
});
