/**
 * Email-specific transformer functions
 */

/**
 * Extract email body from Gmail message payload
 * Handles both simple and multipart messages
 */
export function extractEmailBody(input: unknown): string {
  // TODO: Implement email body extraction
  // - Handle simple text/html body
  // - Handle multipart/alternative
  // - Decode base64 content
  // - Extract from parts array
  
  if (!input) {
    return '';
  }

  // Placeholder implementation
  const payload = input as { body?: { data?: string }; parts?: unknown[] };
  
  if (payload.body?.data) {
    // Decode base64
    try {
      return Buffer.from(payload.body.data, 'base64').toString('utf-8');
    } catch {
      return '';
    }
  }

  // TODO: Handle multipart messages
  return '';
}

/**
 * Extract email recipients from headers
 * Parses To, CC, BCC headers
 */
export function extractEmailRecipients(input: unknown): string[] {
  // TODO: Implement recipient extraction
  // - Parse To header
  // - Parse CC header
  // - Parse BCC header
  // - Extract email addresses
  // - Remove duplicates
  
  const headers = input as Array<{ name: string; value: string }>;
  const recipients: string[] = [];

  for (const header of headers || []) {
    if (['To', 'Cc', 'Bcc'].includes(header.name)) {
      // Simple extraction - TODO: improve parsing
      const emails = header.value.match(/[\w.-]+@[\w.-]+\.\w+/g);
      if (emails) {
        recipients.push(...emails);
      }
    }
  }

  return [...new Set(recipients)]; // Remove duplicates
}

/**
 * Parse email headers into structured data
 */
export function parseEmailHeaders(input: unknown): Record<string, string> {
  const headers = input as Array<{ name: string; value: string }>;
  const result: Record<string, string> = {};

  for (const header of headers || []) {
    result[header.name] = header.value;
  }

  return result;
}

/**
 * Extract sender email address from From header
 */
export function extractEmailSender(input: unknown): string {
  const headers = input as Array<{ name: string; value: string }>;
  
  const fromHeader = headers?.find((h) => h.name === 'From');
  if (!fromHeader) {
    return '';
  }

  // Extract email address from "Name <email@example.com>" format
  const match = fromHeader.value.match(/[\w.-]+@[\w.-]+\.\w+/);
  return match ? match[0] : fromHeader.value;
}
