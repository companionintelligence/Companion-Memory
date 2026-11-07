import { fileNameWords, fileWeightedTexts } from '../searchTexts';

/**
 * Postgres's text-search parser reads a punctuated file name as one host or
 * file token, so `os-plan-lighthouse.jpg` is indexed as that single lexeme and a
 * search for `lighthouse` misses it. These pin the spaced-out copy of the name
 * that gives each part its own lexeme.
 */
describe('fileNameWords', () => {
  it.each([
    ['os-plan-lighthouse.jpg', 'os-plan-lighthouse jpg os plan lighthouse jpg'],
    ['IMG_2034.JPG', 'IMG_2034 JPG IMG 2034 JPG'],
    ['report.final.v2.docx', 'report final v2 docx'],
    ['scan-2026-11-06.pdf', 'scan-2026-11-06 pdf scan 2026 11 06 pdf'],
    ['  My Holiday - Photo (1).png ', 'My Holiday - Photo (1) png My Holiday Photo 1 png'],
    ['Résumé_2026.pdf', 'Résumé_2026 pdf Résumé 2026 pdf'],
  ])('splits %p into %p', (name, words) => {
    expect(fileNameWords(name)).toBe(words);
  });

  it.each([['notes'], ['Vacation photo album'], [''], ['   '], [null], [undefined]])(
    'returns null when there is nothing to split in %p',
    (name) => {
      expect(fileNameWords(name)).toBeNull();
    },
  );
});

describe('fileWeightedTexts', () => {
  it('indexes the parts of the file name beside the name itself, at the same weight', () => {
    expect(fileWeightedTexts({ filename: 'os-plan-receipt.pdf', contentType: 'application/pdf' })).toEqual([
      { text: 'os-plan-receipt.pdf', weight: 3 },
      { text: 'os-plan-receipt pdf os plan receipt pdf', weight: 3 },
      { text: 'application/pdf', weight: 1 },
    ]);
  });

  it('splits a name-like title too, but leaves a prose title alone', () => {
    expect(fileWeightedTexts({ title: 'IMG_2034.JPG' })).toEqual([
      { text: 'IMG_2034.JPG', weight: 10 },
      { text: 'IMG_2034 JPG IMG 2034 JPG', weight: 10 },
    ]);
    expect(fileWeightedTexts({ title: 'Lighthouse at dusk, v2' })).toEqual([
      { text: 'Lighthouse at dusk, v2', weight: 10 },
    ]);
  });

  it('adds nothing for a file name with no punctuation', () => {
    expect(fileWeightedTexts({ filename: 'README' })).toEqual([{ text: 'README', weight: 3 }]);
  });
});
