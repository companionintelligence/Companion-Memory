import {
  TOOLS_OFF_BASE_PROMPT,
  TOOLS_OFF_GUARD,
  TOOLS_OFF_REFUSAL,
  TOOLS_OFF_TURN_CONTEXT_HEADER,
  TOOLS_OFF_TURN_REMINDER,
  isWriteRequest,
} from '../toolsOff';

describe('isWriteRequest', () => {
  // The imperative requests an iOS QA run sent to a model with no tools, which
  // answered "I've added Buy Oat Milk to the planned tasks", "Okay." and
  // "I've forgotten everything about my Amazon orders" — none of it true.
  it.each([
    'Add a task to buy milk',
    'Remember that my locker code hint is QA-teal',
    'Forget everything about my Amazon orders',
  ])('catches the QA prompt %j', (prompt) => {
    expect(isWriteRequest(prompt)).toBe(true);
  });

  it.each([
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
  ])('catches %j', (prompt) => {
    expect(isWriteRequest(prompt)).toBe(true);
  });

  it.each([
    'Please add a task to buy milk',
    'Hey, could you add a task to buy milk?',
    'Can you please remember that I like tea',
    "I'd like you to forget everything about my Amazon orders",
    'Go ahead and delete my notes about Paris',
    'ok so remind me to call mom',
    'Add a task to buy milk\n\nthanks',
    '  ADD  A  TASK  TO BUY MILK  ',
  ])('sees through politeness and framing: %j', (prompt) => {
    expect(isWriteRequest(prompt)).toBe(true);
  });

  // The cost of a false positive is a refusal to a question a tool-less model
  // could have answered, so everything a person asks ABOUT their data, and every
  // piece of ordinary writing help, has to get through.
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
    'Schedule',
    '',
    '   ',
  ])('lets %j through to the model', (prompt) => {
    expect(isWriteRequest(prompt)).toBe(false);
  });

  it('treats null and undefined as nothing to refuse', () => {
    expect(isWriteRequest(null)).toBe(false);
    expect(isWriteRequest(undefined)).toBe(false);
  });

  it('matches curly apostrophes the way a phone keyboard types them', () => {
    expect(isWriteRequest('I’d like you to forget everything about my Amazon orders')).toBe(true);
  });

  it('counts only the start of the message', () => {
    expect(isWriteRequest('What tasks do I have? Also add a task to buy milk')).toBe(false);
  });
});

describe('the tool-less prompts', () => {
  const TOOL_NAMES =
    /\b(?:memory|knowledge|forecast|brief|places|insights|anomalies|suggestions|calendar|media)\.\w+/;
  // Everything the model reads that we wrote for a tool-less turn, bar the refusal the code itself says.
  const PROMPTS = [
    TOOLS_OFF_BASE_PROMPT,
    TOOLS_OFF_GUARD,
    TOOLS_OFF_TURN_REMINDER,
    TOOLS_OFF_TURN_CONTEXT_HEADER,
  ];

  it('names no tool anywhere, so nothing in them advertises a toolbox the turn does not have', () => {
    for (const text of [...PROMPTS, TOOLS_OFF_REFUSAL]) {
      expect(text).not.toMatch(TOOL_NAMES);
      expect(text).not.toMatch(
        /tool calls? in sequence|use the available tools|You have access to various tools/i,
      );
    }
  });

  it('keeps the surface names the base prompt relies on', () => {
    for (const surface of ['Memory', 'Plan', 'Forecast', 'Brief']) {
      expect(TOOLS_OFF_BASE_PROMPT).toContain(surface);
    }
  });

  it('points each surface at its own section of what the model is given, by the name the person uses', () => {
    expect(TOOLS_OFF_BASE_PROMPT).toContain('Answer from the Plan section');
    expect(TOOLS_OFF_BASE_PROMPT).toContain('Answer from the Forecast section');
    expect(TOOLS_OFF_BASE_PROMPT).toContain('Answer from the Brief section');
  });

  it('puts no live data heading in the system prompt: the data arrives with the question', () => {
    for (const marker of ['## Plan', '## Forecast', '## Brief', '## Stats']) {
      expect(TOOLS_OFF_BASE_PROMPT).not.toContain(marker);
      expect(TOOLS_OFF_GUARD).not.toContain(marker);
    }
  });

  it('uses none of our own names for the data: a model this small repeats the words it is given', () => {
    // "Live snapshots" came back in replies ("From your Plan: the open to-dos listed in the Live
    // snapshots"), and so did "the content between the markers".
    for (const text of PROMPTS) {
      expect(text).not.toMatch(/live snapshots?|snapshot|untrusted|markers?|system prompt/i);
    }
  });

  it('teaches by rule and not by worked example, which a 1B model copies back as the answer', () => {
    for (const text of PROMPTS) {
      expect(text).not.toMatch(/^\s*(?:User|Assistant)\s*:/im);
      expect(text).not.toMatch(/\bexamples?\b/i);
    }

    // The one sentence that is quoted is the refusal, and it is asked for only after "if you are asked to".
    expect(TOOLS_OFF_TURN_REMINDER.match(/"[^"]+"/g)).toHaveLength(1);
    expect(TOOLS_OFF_TURN_REMINDER).toMatch(
      /If you are asked to add[^"]*delete anything, reply: "I can't do that here/,
    );

    for (const text of [TOOLS_OFF_BASE_PROMPT, TOOLS_OFF_GUARD, TOOLS_OFF_TURN_CONTEXT_HEADER]) {
      expect(text).not.toContain("I can't do that here");
    }
  });

  it('tells the model it cannot act, cannot look things up, and must not say it did', () => {
    expect(TOOLS_OFF_GUARD).toMatch(/You cannot take actions in this chat/);
    expect(TOOLS_OFF_GUARD).toMatch(/cannot search Memory/);
    expect(TOOLS_OFF_GUARD).toMatch(/forget/);
    expect(TOOLS_OFF_GUARD).toMatch(/Never write tool names, function calls, code blocks or JSON/);
    expect(TOOLS_OFF_TURN_REMINDER).toMatch(/You cannot do things in this chat/);
    expect(TOOLS_OFF_TURN_REMINDER).toMatch(/nothing was changed/);
  });

  it('says plainly what to do when the answer is not in what it was given, and that the world is still fair game', () => {
    expect(TOOLS_OFF_TURN_REMINDER).toMatch(/answer from the information above/i);
    expect(TOOLS_OFF_TURN_REMINDER).toMatch(
      /If the answer about the user is not there, say you do not have it/,
    );
    expect(TOOLS_OFF_TURN_REMINDER).toMatch(/questions about the world you can answer normally/);
  });

  it('heads the data with what it is, not with its own name or with a list of its sections', () => {
    expect(TOOLS_OFF_TURN_CONTEXT_HEADER).toMatch(/^# /);
    expect(TOOLS_OFF_TURN_CONTEXT_HEADER).toMatch(/information about the user/i);
    // A heading that listed Plan, Forecast, Brief and stats read as the whole of what the model knew.
    for (const surface of ['Plan', 'Forecast', 'Brief', 'Stats']) {
      expect(TOOLS_OFF_TURN_CONTEXT_HEADER).not.toContain(surface);
    }
  });

  it('tells the person nothing was changed, and how to get out of a false positive', () => {
    expect(TOOLS_OFF_REFUSAL).toMatch(/nothing was changed/);
    expect(TOOLS_OFF_REFUSAL).toMatch(/ask it as a question/);
  });
});
