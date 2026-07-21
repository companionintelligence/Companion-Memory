import type { ParsedDocument } from '../types';

import { DocumentChunkerService } from './DocumentChunkerService';

describe('DocumentChunkerService', () => {
  const service = new DocumentChunkerService();

  function createDocument(text: string): ParsedDocument {
    return {
      parser: { name: 'markitdown', version: '1.0.0' },
      title: 'Test document',
      language: null,
      warnings: [],
      sections: [
        {
          sectionId: 'section-1',
          title: 'Section',
          text,
          metadata: {},
        },
      ],
    };
  }

  it('does not split words when hard-splitting long paragraphs', () => {
    const repeatedWord = 'electromagnetism';
    const text = Array.from({ length: 800 }, () => repeatedWord).join(' ');

    const chunks = service.chunkDocument('file-1', 'user-1', createDocument(text));

    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      const words = chunk.content.split(/\s+/).filter(Boolean);
      expect(words.every((word) => word === repeatedWord)).toBe(true);
      expect(chunk.content.startsWith(' ')).toBe(false);
      expect(chunk.content.endsWith(' ')).toBe(false);
    }
  });

  it('carries overlap forward on whole-word boundaries', () => {
    const text = Array.from({ length: 900 }, (_, index) => `token${index}`).join(' ');

    const chunks = service.chunkDocument('file-1', 'user-1', createDocument(text));

    expect(chunks.length).toBeGreaterThan(1);

    const firstChunkWords = chunks[0].content.split(/\s+/).filter(Boolean);
    const secondChunkWords = chunks[1].content.split(/\s+/).filter(Boolean);
    const overlapWords = firstChunkWords.filter((word) => secondChunkWords.includes(word));

    expect(overlapWords.length).toBeGreaterThan(0);
    expect(firstChunkWords.at(-1)?.match(/^token\d+$/)).not.toBeNull();
    expect(secondChunkWords[0]?.match(/^token\d+$/)).not.toBeNull();
  });

  it('packs long prose on sentence boundaries before falling back to token windows', () => {
    const sentence = 'This is a complete sentence with enough words to make the packing behavior obvious.';
    const text = Array.from({ length: 120 }, () => sentence).join(' ');

    const chunks = service.chunkDocument('file-1', 'user-1', createDocument(text));

    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      expect(chunk.content.at(-1)).toMatch(/[.!?]/);
    }
  });
});
