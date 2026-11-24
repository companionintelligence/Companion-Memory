import { DESKTOP_APP_CLOSED_MESSAGE } from '@ci/domains/llm';

import { ToolExecutionError } from '../../types';
import { failedToolPayload } from '../McpServerService';

/**
 * An agent reaches Memory through MCP and never sees the web app. When Memory Desktop is closed and took
 * the model with it, a search fails with a transport error ("fetch failed") that tells it nothing, so the
 * failed call carries the plain answer as well.
 */
describe('failedToolPayload', () => {
  it('says Memory Desktop is closed beside the tool’s own error', () => {
    const payload = failedToolPayload(new TypeError('fetch failed'), true);

    expect(payload).toEqual({
      error: { message: 'fetch failed' },
      notice: DESKTOP_APP_CLOSED_MESSAGE,
    });
  });

  it('keeps a structured error whole, so a bad call can still be corrected while the app is closed', () => {
    const payload = failedToolPayload(new ToolExecutionError('VALIDATION_ERROR', 'query: Required'), true);

    expect(payload.error).toEqual({ code: 'VALIDATION_ERROR', message: 'query: Required' });
    expect(payload.notice).toBe(DESKTOP_APP_CLOSED_MESSAGE);
  });

  it('adds nothing while the app runs or off Desktop', () => {
    expect(failedToolPayload(new TypeError('fetch failed'), false)).toEqual({
      error: { message: 'fetch failed' },
    });
  });
});
