import { LOCAL_TOOLS_OFF_REFUSAL, isLocalWriteRequest } from '@ci/common';
import { describe, expect, it } from 'vitest';

/**
 * The same cases as the appliance's `toolsOff.test.ts`: the detector is a port, pattern for pattern,
 * and these are what keep the two surfaces refusing the same requests.
 */
describe('isLocalWriteRequest', () => {
  it.each([
    'Add a task to buy milk',
    'Remember that my locker code hint is QA-teal',
    'Forget everything about my Amazon orders',
    'Add a task to call the dentist.',
    'add a to-do for renewing my passport',
    'Create a reminder for Friday at 9',
    'Make a note of that',
    'Schedule a meeting with Sam tomorrow',
    'Book an appointment with the dentist',
    'Add milk to my shopping list',
    'Put the dentist on my calendar',
    'Save this to my notes',
    'Remember to call mom',
    'Remember: my gym locker is 42',
    'Note that I prefer tea',
    'Remind me to take my pills at 8',
    'Remind me in ten minutes',
    'Forget my old address',
    'Forget about my Amazon orders',
    'Delete my notes about Paris',
    'Remove the task about the dentist',
    'Erase everything you know about Sam',
    'Delete all my reminders',
    'Mark the oat milk task as done',
    'Check off buy milk as complete',
    'Complete the dentist task',
    'Cancel my 3pm meeting',
    'Move the dentist appointment to Friday',
    'Reschedule my meeting with Sam',
    'Rename the passport task',
    'Change the due date for the passport task',
    'Please add a task to buy milk',
    'Hey, could you add a task to buy milk?',
    'Can you please remember that I like tea',
    "I'd like you to forget everything about my Amazon orders",
    'Go ahead and delete my notes about Paris',
    'ok so remind me to call mom',
    'Add a task to buy milk\n\nthanks',
    '  ADD  A  TASK  TO BUY MILK  ',
    'I’d like you to forget everything about my Amazon orders',
  ])('catches %j', (prompt) => {
    expect(isLocalWriteRequest(prompt)).toBe(true);
  });

  it.each([
    'What tasks do I have?',
    'What is my favorite cuisine?',
    'When did I last buy something on Amazon and what was it?',
    'In one sentence, what is the capital of France?',
    'Remember when we went to Lisbon?',
    'Remember the name of my dentist?',
    'Do you remember that I like tea?',
    'Did I add a task to buy milk?',
    'How do I add a task?',
    'Can you tell me what I forgot to do?',
    'Add up my spending this month',
    'Add 2 and 3',
    'Make a list of my tasks',
    'Make a task list for my week',
    'Create a summary of my week',
    'Remove the adjectives from this sentence',
    'Delete the first paragraph of my essay',
    'Complete the sentence: the quick brown fox',
    'Cancel culture is an interesting topic',
    'Move on to the next question',
    'Change the subject',
    'Update me on my tasks',
    'Remind me what I did yesterday',
    'Forget it',
    'What did I note about the passport?',
    'Show me my notes about Paris',
    'Write a note to Sam saying I will be late',
    'Have I ever eaten sushi?',
    'What tasks do I have? Also add a task to buy milk',
    'Schedule',
    '',
    '   ',
  ])('lets %j through to the model', (prompt) => {
    expect(isLocalWriteRequest(prompt)).toBe(false);
  });

  it('treats null and undefined as nothing to refuse', () => {
    expect(isLocalWriteRequest(null)).toBe(false);
    expect(isLocalWriteRequest(undefined)).toBe(false);
  });

  it('tells the person why, and what to do instead', () => {
    expect(LOCAL_TOOLS_OFF_REFUSAL).toMatch(/nothing was changed/);
    expect(LOCAL_TOOLS_OFF_REFUSAL).toMatch(/ask it as a question/);
  });
});
