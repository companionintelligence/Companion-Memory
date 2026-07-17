import { describe, expect, it } from 'vitest';

import { parseChatContent } from './parser';
import type { ToolSegment } from './types';

describe('parseChatContent', () => {
  it('returns a single trimmed text segment for plain content', () => {
    expect(parseChatContent('  hello world  ')).toEqual([{ type: 'text', content: 'hello world' }]);
  });

  it('returns nothing for whitespace-only content', () => {
    expect(parseChatContent('   ')).toEqual([]);
  });

  it('extracts a <think> block alongside surrounding text', () => {
    const segments = parseChatContent('before<think>reasoning</think>after');

    // Sorted tool(0) -> think(1) -> text(2): the think block precedes the text.
    expect(segments).toEqual([
      { type: 'think', content: 'reasoning' },
      { type: 'text', content: 'before' },
      { type: 'text', content: 'after' },
    ]);
  });

  it('orders tool, think, then text regardless of source order', () => {
    const segments = parseChatContent('text<think>t</think><tool>{"name":"x"}</tool>');

    expect(segments.map((s) => s.type)).toEqual(['tool', 'think', 'text']);
  });

  it('treats an unclosed <think> tag as plain text', () => {
    const segments = parseChatContent('<think>never closed');

    expect(segments).toEqual([{ type: 'text', content: '<think>never closed' }]);
  });

  it('treats an unclosed <tool> tag as plain text', () => {
    const segments = parseChatContent('<tool>oops');

    expect(segments).toEqual([{ type: 'text', content: '<tool>oops' }]);
  });

  describe('tool name extraction', () => {
    const toolNameFor = (content: string): string => {
      const segments = parseChatContent(`<tool>${content}</tool>`);
      const tool = segments.find((s): s is ToolSegment => s.type === 'tool');

      return tool?.toolName ?? '';
    };

    it('reads a JSON "name" field', () => {
      expect(toolNameFor('{"name": "search_web", "args": {}}')).toBe('search_web');
    });

    it('reads a function-call pattern', () => {
      expect(toolNameFor('doThing(arg1, arg2)')).toBe('doThing');
    });

    it('reads snake_case / Tool / Service identifiers', () => {
      expect(toolNameFor('the my_tool ran')).toBe('my_tool');
      expect(toolNameFor('WeatherService responded')).toBe('WeatherService');
    });

    it('falls back to the first 3+ character word', () => {
      expect(toolNameFor('abcd')).toBe('abcd');
    });

    it('returns "Unknown Tool" for empty or too-short content', () => {
      expect(toolNameFor('')).toBe('Unknown Tool');
      expect(toolNameFor('ab')).toBe('Unknown Tool');
    });
  });
});
