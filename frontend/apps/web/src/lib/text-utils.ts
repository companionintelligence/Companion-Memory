/**
 * Utility functions for text processing
 */

/**
 * Clean markdown and formatting characters from text for TTS
 * Removes asterisks, underscores, backticks, hash symbols, brackets, and links
 * to ensure clean speech synthesis
 */
export function cleanTextForTTS(text: string): string {
  return (
    text
      // Remove asterisks (bold/italic markdown)
      .replace(/\*+/g, '')
      // Remove underscores (italic markdown)
      .replace(/_+/g, '')
      // Remove backticks (code markdown)
      .replace(/`+/g, '')
      // Remove hash symbols (headers)
      .replace(/#+/g, '')
      // Remove brackets and parentheses with content (links, images)
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      // Remove standalone brackets
      .replace(/[[\]()]/g, '')
      // Remove multiple spaces and normalize whitespace
      .replace(/\s+/g, ' ')
      .trim()
  );
}
