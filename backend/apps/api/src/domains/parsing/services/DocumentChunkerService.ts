import { Injectable } from '@nestjs/common';

import {
  CHUNK_OVERLAP_CHARS,
  CHUNK_TARGET_CHARS,
  CHUNKER_VERSION,
  type CreateChunkDto,
  type ParsedDocument,
} from '../types';

@Injectable()
export class DocumentChunkerService {
  /**
   * Convert a ParsedDocument into a flat list of chunk DTOs, applying
   * target-size windowing with overlap when a section exceeds CHUNK_TARGET_CHARS.
   */
  chunkDocument(fileId: string, userId: string, doc: ParsedDocument): CreateChunkDto[] {
    const chunks: CreateChunkDto[] = [];
    let globalIndex = 0;

    for (const section of doc.sections) {
      const text = section.text.trim();

      if (!text) {
        continue;
      }

      if (text.length <= CHUNK_TARGET_CHARS) {
        chunks.push({
          fileId,
          userId,
          chunkIndex: globalIndex++,
          content: text,
          sectionTitle: section.title ?? null,
          sourceLocator: Object.keys(section.metadata).length ? section.metadata : null,
          parserName: doc.parser.name,
          parserVersion: doc.parser.version,
          chunkerVersion: CHUNKER_VERSION,
        });
      } else {
        // Split at paragraph boundaries with overlap
        const windows = this.splitWithOverlap(text);

        for (const window of windows) {
          chunks.push({
            fileId,
            userId,
            chunkIndex: globalIndex++,
            content: window,
            sectionTitle: section.title ?? null,
            sourceLocator: Object.keys(section.metadata).length ? section.metadata : null,
            parserName: doc.parser.name,
            parserVersion: doc.parser.version,
            chunkerVersion: CHUNKER_VERSION,
          });
        }
      }
    }

    return chunks;
  }

  /**
   * Split a long text into overlapping windows, preferring paragraph boundaries.
   */
  private splitWithOverlap(text: string): string[] {
    const paragraphs = text.split(/\n\n+/).filter((p) => p.trim().length > 0);
    const windows: string[] = [];
    let current = '';

    for (const para of paragraphs) {
      const candidate = current ? `${current}\n\n${para}` : para;

      if (candidate.length <= CHUNK_TARGET_CHARS) {
        current = candidate;
      } else {
        if (current) {
          windows.push(current.trim());
          // Start next window with overlap from the tail of current
          const overlap = this.takeSentenceSafeOverlap(current);
          current = overlap ? `${overlap}\n\n${para}` : para;

          if (current.length > CHUNK_TARGET_CHARS) {
            const carryWindows = this.packSentences(current);

            if (carryWindows.length > 1) {
              windows.push(...carryWindows.slice(0, -1));
              current = carryWindows.at(-1) ?? '';
            } else {
              current = carryWindows[0] ?? '';
            }
          }
        } else {
          // Single paragraph exceeds target — pack by sentence boundaries first
          windows.push(...this.packSentences(para));
          current = '';
        }
      }
    }

    if (current.trim()) {
      windows.push(current.trim());
    }

    return windows.length > 0 ? windows : [text.trim()];
  }

  /**
   * Split a long block by sentence boundaries, falling back to token windows for
   * single sentences that exceed the target size.
   */
  private packSentences(text: string): string[] {
    const sentences = this.splitIntoSentences(text);

    if (sentences.length === 0) {
      return [text.trim()].filter(Boolean);
    }

    const results: string[] = [];
    let currentSentences: string[] = [];
    let currentLength = 0;

    for (const sentence of sentences) {
      if (sentence.length > CHUNK_TARGET_CHARS) {
        if (currentSentences.length > 0) {
          results.push(this.joinSegments(currentSentences));
          currentSentences = [];
          currentLength = 0;
        }

        results.push(...this.hardSplitTokens(sentence));
        continue;
      }

      if (currentLength + sentence.length <= CHUNK_TARGET_CHARS || currentSentences.length === 0) {
        currentSentences.push(sentence);
        currentLength += sentence.length;
        continue;
      }

      results.push(this.joinSegments(currentSentences));
      currentSentences = this.takeSentenceOverlap(currentSentences);
      currentLength = this.getSegmentsLength(currentSentences);
      currentSentences.push(sentence);
      currentLength += sentence.length;
    }

    if (currentSentences.length > 0) {
      results.push(this.joinSegments(currentSentences));
    }

    return results.filter((chunk) => chunk.length > 0);
  }

  /**
   * Hard-split a single sentence by token boundaries with overlap.
   */
  private hardSplitTokens(text: string): string[] {
    const tokens = this.tokenize(text);
    const results: string[] = [];
    let start = 0;

    while (start < tokens.length) {
      let end = start;
      let chunkLength = 0;

      while (
        end < tokens.length &&
        (chunkLength + tokens[end].length <= CHUNK_TARGET_CHARS || end === start)
      ) {
        chunkLength += tokens[end].length;
        end++;
      }

      const chunk = tokens.slice(start, end).join('').trim();

      if (chunk.length > 0) {
        results.push(chunk);
      }

      if (end >= tokens.length) {
        break;
      }

      const nextStart = this.findOverlapStart(tokens, start, end);
      start = nextStart > start ? nextStart : end;
    }

    return results;
  }

  private takeSentenceSafeOverlap(text: string): string {
    return this.joinSegments(this.takeSentenceOverlap(this.splitIntoSentences(text)));
  }

  private takeSentenceOverlap(sentences: string[]): string[] {
    let overlapLength = 0;
    let start = sentences.length;

    while (start > 0) {
      const sentenceLength = sentences[start - 1].length;

      if (overlapLength + sentenceLength > CHUNK_OVERLAP_CHARS) {
        break;
      }

      overlapLength += sentenceLength;
      start--;
    }

    return sentences.slice(start);
  }

  private findOverlapStart(tokens: string[], start: number, end: number): number {
    let overlapLength = 0;
    let overlapStart = end;

    while (overlapStart > start) {
      const tokenLength = tokens[overlapStart - 1].length;

      if (overlapLength + tokenLength > CHUNK_OVERLAP_CHARS) {
        break;
      }

      overlapLength += tokenLength;
      overlapStart--;
    }

    if (overlapStart <= start) {
      return Math.min(end, start + 1);
    }

    return overlapStart;
  }

  private tokenize(text: string): string[] {
    return text.match(/\S+\s*/g) ?? [];
  }

  private splitIntoSentences(text: string): string[] {
    const normalized = text.replace(/\s+/g, ' ').trim();

    if (!normalized) {
      return [];
    }

    const matches = normalized.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [normalized];

    return matches.map((sentence) => sentence.trim()).filter(Boolean);
  }

  private joinSegments(segments: string[]): string {
    return segments.join(' ').trim();
  }

  private getSegmentsLength(segments: string[]): number {
    if (segments.length === 0) {
      return 0;
    }

    return this.joinSegments(segments).length;
  }
}
