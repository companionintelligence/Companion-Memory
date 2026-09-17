import { describe, expect, it, vi } from 'vitest';

import { dispatchNotReadyAction, dispatchNotReadyMessage } from './dispatchNotReady';

describe('dispatchNotReadyMessage', () => {
  it('names the Hub fix for each blocker', () => {
    expect(dispatchNotReadyMessage('not_installed')).toMatch(/not installed/i);
    expect(dispatchNotReadyMessage('not_connected')).toMatch(/not connected/i);
    expect(dispatchNotReadyMessage('not_running')).toMatch(/not running/i);
    expect(dispatchNotReadyMessage('not_wakeable')).toMatch(/cannot wake/i);
    expect(dispatchNotReadyMessage(null)).toMatch(/not ready/i);
  });

  it('blames the appliance, not the app, when the doorbell is unconfigured', () => {
    // The other four blockers are all things the user fixes in Hub. This one is
    // a setting on this machine, and OpenClaw may be installed, connected and
    // running perfectly — pointing someone at the app would send them to look
    // at the part of the chain that is working.
    const message = dispatchNotReadyMessage('doorbell_unconfigured');

    expect(message).toMatch(/this appliance/i);
    expect(message).toMatch(/CI_HUB_INTERNAL_URL/);
    expect(message).toMatch(/CI_HUB_FORWARD_AUTH_SECRET/);
    expect(message).not.toMatch(/OpenClaw is not/i);
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
    expect(open).toHaveBeenCalledWith('https://hub.example/connect', '_blank', 'noopener,noreferrer');
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

  it('offers no Connect button for a doorbell problem — Hub is not where the fix is', () => {
    expect(
      dispatchNotReadyAction({
        dispatchBlocker: 'doorbell_unconfigured',
        connectUrl: 'https://hub.example/connect',
      }),
    ).toBeUndefined();
  });
});
