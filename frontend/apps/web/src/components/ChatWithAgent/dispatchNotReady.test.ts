import { describe, expect, it, vi } from 'vitest';

import {
  dispatchNotReadyAction,
  dispatchNotReadyMessage,
} from './dispatchNotReady';

describe('dispatchNotReadyMessage', () => {
  it('names the Hub fix for each blocker', () => {
    expect(dispatchNotReadyMessage('not_installed')).toMatch(/not installed/i);
    expect(dispatchNotReadyMessage('not_connected')).toMatch(/not connected/i);
    expect(dispatchNotReadyMessage('not_running')).toMatch(/not running/i);
    expect(dispatchNotReadyMessage('not_wakeable')).toMatch(/cannot wake/i);
    expect(dispatchNotReadyMessage(null)).toMatch(/not ready/i);
  });
});

describe('dispatchNotReadyAction', () => {
  it('offers Connect in Hub when install or connect is the blocker', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const action = dispatchNotReadyAction({
      dispatchBlocker: 'not_connected',
      connectUrl: 'https://hub.example/connect',
    });

    expect(action?.label).toBe('Connect in Hub');
    action?.onClick();
    expect(open).toHaveBeenCalledWith(
      'https://hub.example/connect',
      '_blank',
      'noopener,noreferrer',
    );
    open.mockRestore();
  });

  it('skips an action when Hub cannot fix it from here', () => {
    expect(
      dispatchNotReadyAction({
        dispatchBlocker: 'not_running',
        connectUrl: 'https://hub.example/connect',
      }),
    ).toBeUndefined();
  });
});
