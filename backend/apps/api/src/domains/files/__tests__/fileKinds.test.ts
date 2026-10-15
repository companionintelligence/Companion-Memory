import { fileKindsPredicate, normalizeFileKinds } from '../fileKinds';

describe('normalizeFileKinds', () => {
  it('keeps only the kinds it knows, once each, and reports none as undefined', () => {
    expect(normalizeFileKinds(['image', 'bogus', 'image', 'video'])).toEqual(['image', 'video']);
    expect(normalizeFileKinds(['bogus'])).toBeUndefined();
    expect(normalizeFileKinds(undefined)).toBeUndefined();
  });
});

describe('fileKindsPredicate', () => {
  it('matches media kinds by content-type prefix', () => {
    const { sql, params } = fileKindsPredicate('file.content_type', ['image', 'audio']);

    expect(sql).toBe('(file.content_type LIKE :fileKind_image OR file.content_type LIKE :fileKind_audio)');
    expect(params).toEqual({ fileKind_image: 'image/%', fileKind_audio: 'audio/%' });
  });

  it('treats a document as whatever is not a picture, a clip or a recording, including an unknown type', () => {
    const { sql, params } = fileKindsPredicate('file.content_type', ['document']);

    expect(sql).toContain('file.content_type IS NULL OR');
    expect(sql).toContain('file.content_type NOT LIKE :fileKindNot_image');
    expect(params).toEqual({
      fileKindNot_image: 'image/%',
      fileKindNot_video: 'video/%',
      fileKindNot_audio: 'audio/%',
    });
  });

  it('matches everything when given no kinds', () => {
    expect(fileKindsPredicate('file.content_type', []).sql).toBe('1 = 1');
  });
});
