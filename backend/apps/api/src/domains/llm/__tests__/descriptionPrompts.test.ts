import {
  VIDEO_DESCRIPTION_MAX_FRAMES,
  buildFramePrompt,
  buildMergePrompt,
  buildPrompt,
  parseDescription,
} from '../descriptionPrompts';

describe('buildPrompt', () => {
  it('places the context line after the rules and before the schema', () => {
    const prompt = buildPrompt('Context: the photo was taken on 2024-05-05.');

    expect(prompt.indexOf('Context:')).toBeGreaterThan(prompt.indexOf('only when it is legible'));
    expect(prompt.indexOf('Context:')).toBeLessThan(prompt.indexOf('Return a JSON object'));
  });
});

describe('buildFramePrompt', () => {
  it('prefixes the photo prompt with which frame this is and asks for this frame alone', () => {
    const prompt = buildFramePrompt(null, { index: 1, count: 3, atSeconds: 15, durationSeconds: 30 });

    expect(prompt).toContain('frame 2 of 3, taken in order from one video about 30s long, at 15s');
    expect(prompt).toContain('Describe only what this frame shows');
    // The photo rules follow unchanged, so a frame is described exactly as a photo is.
    expect(prompt).toContain('only when it is legible or unmistakable in the image');
    expect(prompt.indexOf('frame 2 of 3')).toBeLessThan(prompt.indexOf('Analyze this image'));
  });

  it('leaves the length out when the container did not say, and formats minutes', () => {
    expect(buildFramePrompt(null, { index: 0, count: 1, atSeconds: 0, durationSeconds: null })).toContain(
      'frame 1 of 1, taken in order from one video, at 0s',
    );
    expect(buildFramePrompt(null, { index: 0, count: 2, atSeconds: 95, durationSeconds: 190 })).toContain(
      'about 3m10s long, at 1m35s',
    );
  });

  it('carries the capture context like a photo prompt does', () => {
    const prompt = buildFramePrompt('Context: the video was recorded on 2023-10-26.', {
      index: 0,
      count: 1,
      atSeconds: 0,
      durationSeconds: null,
    });

    expect(prompt).toContain('Context: the video was recorded on 2023-10-26.');
  });
});

describe('buildMergePrompt', () => {
  const frames = [
    { atSeconds: 5, title: 'Squirrel on Boulder', description: 'A squirrel sits on a rock.' },
    { atSeconds: 15, title: 'Squirrel Climbing', description: 'The squirrel climbs a tree.' },
  ];

  it('lists the frame descriptions in time order and asks for one label for the clip', () => {
    const prompt = buildMergePrompt(frames, 30, null);

    expect(prompt).toContain('descriptions of 2 frames taken in order from one video, about 30s long');
    expect(prompt).toContain('- at 5s: Squirrel on Boulder — A squirrel sits on a rock.');
    expect(prompt).toContain('- at 15s: Squirrel Climbing — The squirrel climbs a tree.');
    expect(prompt.indexOf('at 5s')).toBeLessThan(prompt.indexOf('at 15s'));
    expect(prompt).toContain('what happens or changes over it');
    expect(prompt).toContain('never mention frames, stills, samples or timestamps');
    expect(prompt).not.toContain('Context:');
  });

  it('keeps the naming rule: a place or brand only from a frame description or the context line', () => {
    const prompt = buildMergePrompt(frames, null, 'Context: the video was recorded on 2023-10-26.');

    expect(prompt).toContain(
      'only when a frame description names it, or when the context below makes it clear',
    );
    expect(prompt.indexOf('Context:')).toBeGreaterThan(prompt.indexOf('only when a frame description'));
    expect(prompt.indexOf('Context:')).toBeLessThan(prompt.indexOf('Return a JSON object'));
  });
});

describe('parseDescription', () => {
  it('reads a bare object, a fenced one, and one wrapped in prose', () => {
    const value = { title: 'Rock Squirrel', description: 'A squirrel on a rock.' };
    const json = JSON.stringify(value);

    expect(parseDescription(json)).toEqual({ ok: true, value });
    expect(parseDescription('```json\n' + json + '\n```')).toEqual({ ok: true, value });
    expect(parseDescription('Sure! Here it is: ' + json + ' Hope that helps.')).toEqual({ ok: true, value });
  });

  it('says why an answer is not a label', () => {
    expect(parseDescription('not json at all')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('not JSON'),
    });
    expect(parseDescription('{"title": "only"}')).toMatchObject({ ok: false });
  });
});

it('samples a bounded number of frames per clip', () => {
  expect(VIDEO_DESCRIPTION_MAX_FRAMES).toBeGreaterThanOrEqual(3);
  expect(VIDEO_DESCRIPTION_MAX_FRAMES).toBeLessThanOrEqual(8);
});
