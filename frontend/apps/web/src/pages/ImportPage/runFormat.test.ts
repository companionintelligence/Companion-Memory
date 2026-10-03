import { describe, expect, it } from 'vitest';

import {
  compactNumber,
  computeFraction,
  formatDuration,
  formatElapsed,
  formatRate,
  humanizeUnit,
  describeConcurrency,
  queueStateLabel,
  runStatusLabel,
  STAGE_BLURBS,
  stageLabel,
  stagePhase,
} from './runFormat';

describe('computeFraction', () => {
  it('returns null when there is no denominator', () => {
    // The load-bearing case. Null means indeterminate, and the bar animates
    // rather than inventing a width — a parse does not know how many records an
    // archive holds until it has read it.
    expect(computeFraction(412, null)).toBeNull();
    expect(computeFraction(412, undefined)).toBeNull();
    expect(computeFraction(412, 0)).toBeNull();
  });

  it('clamps to 0..1 rather than reporting past the end', () => {
    // A stage that overshoots its estimate must not render a bar wider than its
    // track.
    expect(computeFraction(120, 100)).toBe(1);
    expect(computeFraction(-5, 100)).toBe(0);
  });

  it('computes an honest ratio in between', () => {
    expect(computeFraction(25, 100)).toBe(0.25);
  });
});

describe('compactNumber', () => {
  it('shortens the counts a real import produces', () => {
    expect(compactNumber(412)).toBe('412');
    expect(compactNumber(12_400)).toBe('12.4k');
    expect(compactNumber(1_500_000)).toBe('1.5M');
  });
});

describe('formatDuration', () => {
  it('stays coarse, because a second-accurate estimate over 40GB is a fiction', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(252)).toBe('4m 12s');
    expect(formatDuration(7_800)).toBe('2h 10m');
  });

  it('has nothing to say about an unknown duration', () => {
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(-1)).toBeNull();
  });
});

describe('runStatusLabel', () => {
  it('calls a partial import what it is: a success with gaps', () => {
    // Labelling this "Failed" is what sends someone back to re-upload a 40GB
    // archive over one parser that choked on one file.
    expect(runStatusLabel('partial')).toBe('Imported, with some items skipped');
    expect(runStatusLabel('completed')).toBe('Imported');
    expect(runStatusLabel('failed')).toBe('Failed');
  });

  it('passes through a status it does not know rather than blanking it', () => {
    expect(runStatusLabel('something_new')).toBe('something_new');
  });
});

describe('stageLabel', () => {
  it("names the three stages in the user's terms", () => {
    expect(stageLabel('unpack')).toBe('Unpack');
    expect(stageLabel('parse')).toBe('Read');
    expect(stageLabel('push')).toBe('Save');
  });
});

/**
 * The vocabulary the pinned progress region runs on.
 *
 * All of it exists because a real 13-source import was unreadable: thirteen runs
 * sharing one label, twelve of them saying "queued", a 704k-item parse and a
 * 298-item one looking identical, and `items_per_sec` recorded on every row and
 * rendered nowhere.
 */
describe('humanizeUnit', () => {
  it('turns a staged folder or archive name into something to read', () => {
    // The observed batch's actual unit names.
    expect(humanizeUnit('google-takeout')).toBe('Google Takeout');
    expect(humanizeUnit('whatsapp')).toBe('Whatsapp');
    expect(humanizeUnit('contact_list')).toBe('Contact List');
  });

  it('drops an archive extension, which is noise next to the run row', () => {
    expect(humanizeUnit('takeout-20260819.zip')).toBe('Takeout 20260819');
    expect(humanizeUnit('backup.tar')).toBe('Backup');
  });

  it('has nothing to say about nothing, so the caller can fall back', () => {
    expect(humanizeUnit(null)).toBeNull();
    expect(humanizeUnit('   ')).toBeNull();
  });
});

describe('formatRate', () => {
  it('keeps a decimal below 10/s, where the difference is hours', () => {
    // A contact list parsed at 6.1/s on the observed batch; a Takeout at 555/s.
    expect(formatRate(6.098197753881312)).toBe('6.1/s');
    expect(formatRate(554.9437648218284)).toBe('555/s');
    expect(formatRate(1_240)).toBe('1.2k/s');
  });

  it('says nothing rather than "0/s" when nothing was measured', () => {
    expect(formatRate(null)).toBeNull();
    expect(formatRate(0)).toBeNull();
  });
});

describe('queueStateLabel', () => {
  it('separates the two things the database both calls "queued"', () => {
    // Enqueued, needs a slot of its kind — normal, and it can last an hour on a
    // batch import.
    expect(queueStateLabel('waiting', { position: 1 })).toBe('Next in the import queue');
    expect(queueStateLabel('waiting', { position: 3 })).toBe('Waiting — 3rd in the import queue');
    // Not enqueued at all: its own run has not reached this stage.
    expect(queueStateLabel('blocked')).toBe('Not started yet');
  });

  it('names the queue by KIND, because that is the one it is actually in', () => {
    // The appliance runs a queue per kind. A parse eighth among everything
    // waiting can be first among the parses, so an unqualified "3rd in the
    // import queue" is a number nothing will honour.
    expect(queueStateLabel('waiting', { position: 1, kind: 'parse' })).toBe('Next in the read queue');
    expect(queueStateLabel('waiting', { position: 2, kind: 'media' })).toBe(
      'Waiting — 2nd in the store files queue',
    );
  });

  it('says nothing for a stage that is doing or has done something', () => {
    // Those lines carry live counts instead; a queue label would displace them.
    expect(queueStateLabel('running')).toBeNull();
    expect(queueStateLabel('done')).toBeNull();
  });
});

describe('describeConcurrency', () => {
  it("says the slots out loud, from the server's own numbers", () => {
    // The sentence that turns a twelve-deep queue from a malfunction into
    // arithmetic. Hardcoding "one stage at a time" stopped being true the day
    // media went to two slots — which is exactly why this reads the map.
    expect(describeConcurrency({ unpack: 1, parse: 1, media: 2, push: 1 })).toBe(
      '1 unpack, 1 read, 2 store files and 1 save',
    );
  });

  it('degrades to something true rather than something empty', () => {
    expect(describeConcurrency({ parse: 1 })).toBe('1 read');
    expect(describeConcurrency({})).toBe('one import stage');
  });
});

describe('formatElapsed', () => {
  it('reads an elapsed millisecond count at the scale it happens to be', () => {
    expect(formatElapsed(1_872)).toBe('1.9s');
    expect(formatElapsed(2_734_458)).toBe('45m 34s');
    expect(formatElapsed(66 * 60_000)).toBe('1h 6m');
  });

  it('refuses to invent one', () => {
    expect(formatElapsed(null)).toBeNull();
    expect(formatElapsed(-1)).toBeNull();
  });
});

describe('stage labels', () => {
  it('names the media stage, which rendered as the raw word and no blurb', () => {
    // Weight 30 against parse's 35 — on a photo export it is the longest leg of
    // the import, and it was the least explained thing on the screen.
    expect(stageLabel('media')).toBe('Store files');
    expect(STAGE_BLURBS.media).toBe('Copy its photos, videos and voicemails into storage');
  });
});

describe('stagePhase', () => {
  it('says nothing for a stage that is done', () => {
    // The runner writes `phase` while a stage works and nothing clears it on
    // completion, so a finished Read still carries "parsing fitbit (56/57)" and
    // a finished Save still carries "pushing" — in-progress words beside a green
    // check.
    expect(stagePhase({ status: 'completed', phase: 'parsing fitbit (56/57)' })).toBeNull();
    expect(stagePhase({ status: 'completed', phase: 'pushing' })).toBeNull();
    expect(stagePhase({ status: 'completed', phase: 'expanded' })).toBeNull();
  });

  it('keeps what a running stage is doing', () => {
    expect(stagePhase({ status: 'running', phase: 'parsing gmail (1/2)' })).toBe('parsing gmail (1/2)');
  });

  it('keeps where a stage stopped, which is the first thing asked about one that did not finish', () => {
    expect(stagePhase({ status: 'failed', phase: 'parsing gmail (1/2)' })).toBe('parsing gmail (1/2)');
    expect(stagePhase({ status: 'cancelled', phase: 'uploading' })).toBe('uploading');
  });

  it('has nothing to say when the runner set nothing', () => {
    expect(stagePhase({ status: 'running', phase: null })).toBeNull();
    expect(stagePhase({ status: 'running', phase: '' })).toBeNull();
  });
});
