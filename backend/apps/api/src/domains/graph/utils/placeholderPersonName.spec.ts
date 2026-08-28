import { Logger } from '@nestjs/common';

import {
  isPlaceholderPersonName,
  placeholderPersonNameReason,
  resetPlaceholderPersonNameLog,
} from './placeholderPersonName';

describe('placeholderPersonNameReason', () => {
  describe('a value with no letter and no digit', () => {
    it('refuses the empty-ish shapes a nameless contact card produces', () => {
      // `vcard.ts` computes `fn || structuredName`, which is '' for a card with
      // neither. '' itself is "nothing", not "a placeholder" — the caller drops
      // empties before it asks — but everything a parser pads it with is caught.
      for (const value of ['?', '-', '—', '.', '...', '()', '#', '••']) {
        expect(placeholderPersonNameReason(value)).toBe('no_letters_or_digits');
      }
    });

    it('refuses an emoji-only display name', () => {
      expect(placeholderPersonNameReason('🚀')).toBe('no_letters_or_digits');
      expect(placeholderPersonNameReason('👍🏼 ✨')).toBe('no_letters_or_digits');
    });

    it('keeps a real name decorated with one', () => {
      // This is most of what a LinkedIn export actually contains, and refusing
      // it would delete a name the export honestly carried.
      expect(placeholderPersonNameReason('🚀 Russell Levine')).toBeNull();
      expect(placeholderPersonNameReason('★ Tony Karrer')).toBeNull();
    });

    it('is Unicode-aware, so a non-Latin name is a name', () => {
      expect(placeholderPersonNameReason('田中')).toBeNull();
      expect(placeholderPersonNameReason('Ναταλία')).toBeNull();
      expect(placeholderPersonNameReason('Дмитрий')).toBeNull();
    });

    it('lets a bare phone number through — a digit is a character too', () => {
      // Deliberate: 4,022 live Person rows are named with their own number and
      // that is what the export knew. This module is not the place to relitigate
      // it, and refusing here would blank them all.
      expect(placeholderPersonNameReason('4155550100')).toBeNull();
    });
  });

  describe('a generic placeholder label', () => {
    it.each([
      'Unknown',
      'unknown contact',
      'Unknown Caller',
      'No Name',
      'unnamed',
      'N/A',
      'None',
      'Anonymous',
      'New Contact',
      'Private Number',
    ])('refuses %s', (value) => {
      expect(placeholderPersonNameReason(value)).toBe('generic_placeholder');
    });

    it('sees through the wrappers an export dresses the label in', () => {
      for (const value of ['(Unknown)', '<unknown>', '"Unknown"', 'Unknown.', ' UNKNOWN  ']) {
        expect(placeholderPersonNameReason(value)).toBe('generic_placeholder');
      }
    });

    it('collapses internal whitespace before matching', () => {
      expect(placeholderPersonNameReason('no   name')).toBe('generic_placeholder');
    });

    it('leaves the ambiguous short words alone', () => {
      // "Na" and "Nil" are real surnames; "Me", "Self", "Support" and friends are
      // labels people really do file humans under. The list is closed for exactly
      // this reason — see the module header.
      for (const value of ['Na', 'Nil', 'Me', 'Self', 'You', 'Support', 'Mom', 'Team']) {
        expect(placeholderPersonNameReason(value)).toBeNull();
      }
    });

    it('does not fire on a name that merely CONTAINS a placeholder word', () => {
      expect(placeholderPersonNameReason('Nonesuch Wilkins')).toBeNull();
      expect(placeholderPersonNameReason('Unknown Pleasures Ltd')).toBeNull();
    });

    it('cannot fire on an email address', () => {
      // This predicate is applied to handle-shaped staged names too.
      expect(placeholderPersonNameReason('unknown@example.com')).toBeNull();
      expect(placeholderPersonNameReason('none@example.com')).toBeNull();
    });
  });

  it('treats nothing as nothing, not as a placeholder', () => {
    // Mirrors nonNameParticipantReason: the caller already drops empties, and
    // reporting a reason for them would put a refusal in the log per nameless row.
    expect(placeholderPersonNameReason(null)).toBeNull();
    expect(placeholderPersonNameReason(undefined)).toBeNull();
    expect(placeholderPersonNameReason('')).toBeNull();
    expect(placeholderPersonNameReason('   ')).toBeNull();
  });
});

describe('isPlaceholderPersonName', () => {
  beforeEach(() => {
    resetPlaceholderPersonNameLog();
  });

  it('is the boolean form of the reason', () => {
    expect(isPlaceholderPersonName('Unknown', 'spec')).toBe(true);
    expect(isPlaceholderPersonName('Judy Collins', 'spec')).toBe(false);
  });

  it('warns once per reason, not once per row', () => {
    // A corrupt import is tens of thousands of rows; the signal is "this is
    // happening and here is an example".
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    try {
      for (let i = 0; i < 50; i += 1) {
        isPlaceholderPersonName('Unknown', 'spec');
      }

      isPlaceholderPersonName('?', 'spec');

      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('never logs a refused value unbounded', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    try {
      isPlaceholderPersonName('?'.repeat(500), 'spec');

      const [message] = warn.mock.calls[0] as [string];
      expect(message.length).toBeLessThan(300);
      expect(message).toContain('…');
    } finally {
      warn.mockRestore();
    }
  });
});
