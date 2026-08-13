import { Camera } from '@ci/capture';
import { useMuteControls } from '@ci/capture/src/components/Camera/useMuteControls';
import { useStream } from '@ci/capture/src/components/Camera/useStream';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression tests for the capture mute toggles.
 *
 * The Mic / Video buttons in Camera.DesktopControls used to flip nothing but the
 * icon and its tooltip: the flags never reached the live MediaStream, so the
 * recorder kept muxing real audio into the .webm that CaptureModal uploads while
 * every visual signal told the user they were muted. These tests assert the
 * toggles actually reach `MediaStreamTrack.enabled`, in both directions and for
 * a stream acquired *after* the toggle.
 */

/** Minimal hand-rolled MediaStreamTrack — jsdom has no media capture at all. */
class FakeMediaStreamTrack {
  enabled = true;

  readyState: 'live' | 'ended' = 'live';

  constructor(public readonly kind: 'audio' | 'video') {}

  stop() {
    this.readyState = 'ended';
  }
}

class FakeMediaStream {
  readonly tracks: FakeMediaStreamTrack[] = [
    new FakeMediaStreamTrack('audio'),
    new FakeMediaStreamTrack('video'),
  ];

  getTracks() {
    return this.tracks;
  }

  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === 'audio');
  }

  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === 'video');
  }

  get audio() {
    return this.getAudioTracks()[0];
  }

  get video() {
    return this.getVideoTracks()[0];
  }
}

let acquired: FakeMediaStream[] = [];
let gate: Promise<void> | null = null;
let openGate: (() => void) | null = null;

/** Make the next getUserMedia() hang until `releaseGetUserMedia()` is called. */
function holdGetUserMedia() {
  gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
}

async function releaseGetUserMedia() {
  const release = openGate;

  gate = null;
  openGate = null;

  await act(async () => {
    release?.();
  });
}

/** Drives the real hooks from inside the real Camera provider tree. */
function MuteHarness() {
  const [{ isActive }, { startCamera, stopCamera }] = useStream();
  const [{ microphoneEnabled, cameraEnabled }, { toggleMicrophone, toggleCamera }] = useMuteControls();

  return (
    <div>
      <span data-testid="stream-state">{isActive ? 'active' : 'idle'}</span>
      <span data-testid="mic-state">{microphoneEnabled ? 'mic-on' : 'mic-off'}</span>
      <span data-testid="camera-state">{cameraEnabled ? 'camera-on' : 'camera-off'}</span>

      <button onClick={toggleMicrophone}>toggle mic</button>
      <button onClick={toggleCamera}>toggle camera</button>
      <button onClick={startCamera}>start camera</button>
      <button onClick={stopCamera}>stop camera</button>
    </div>
  );
}

function renderCamera() {
  return render(
    <Camera>
      <Camera.Feed />
      <MuteHarness />
    </Camera>,
  );
}

function click(name: string) {
  return act(async () => {
    fireEvent.click(screen.getByText(name));
  });
}

/** Latest stream handed out by the mocked getUserMedia. */
function currentStream(): FakeMediaStream {
  expect(acquired.length).toBeGreaterThan(0);

  return acquired[acquired.length - 1];
}

beforeEach(() => {
  acquired = [];
  gate = null;
  openGate = null;

  const getUserMedia = vi.fn(async () => {
    const pending = gate;

    if (pending) {
      await pending;
    }

    const stream = new FakeMediaStream();

    acquired.push(stream);

    return stream as unknown as MediaStream;
  });

  Object.defineProperty(window.navigator, 'mediaDevices', {
    configurable: true,
    writable: true,
    value: { getUserMedia, enumerateDevices: vi.fn(async () => []) },
  });

  // jsdom's HTMLMediaElement.play() throws "Not implemented", which would send
  // useStream down its error path and tear the stream back down.
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
});

afterEach(() => {
  delete (window.navigator as { mediaDevices?: unknown }).mediaDevices;
});

describe('Camera mute toggles reach the MediaStream', () => {
  it('disables and re-enables the live audio track when the mic is toggled mid-stream', async () => {
    renderCamera();

    await waitFor(() => expect(screen.getByTestId('stream-state')).toHaveTextContent('active'));

    const stream = currentStream();

    expect(stream.audio.enabled).toBe(true);

    await click('toggle mic');

    expect(screen.getByTestId('mic-state')).toHaveTextContent('mic-off');
    expect(stream.audio.enabled).toBe(false);
    // The camera toggle is independent — video must be untouched.
    expect(stream.video.enabled).toBe(true);

    await click('toggle mic');

    expect(screen.getByTestId('mic-state')).toHaveTextContent('mic-on');
    expect(stream.audio.enabled).toBe(true);
  });

  it('disables the live video track when the camera is toggled mid-stream', async () => {
    renderCamera();

    await waitFor(() => expect(screen.getByTestId('stream-state')).toHaveTextContent('active'));

    const stream = currentStream();

    await click('toggle camera');

    expect(screen.getByTestId('camera-state')).toHaveTextContent('camera-off');
    expect(stream.video.enabled).toBe(false);
    expect(stream.audio.enabled).toBe(true);
  });

  it('mutes by disabling tracks rather than stopping them, so recording survives and un-mute is instant', async () => {
    renderCamera();

    await waitFor(() => expect(screen.getByTestId('stream-state')).toHaveTextContent('active'));

    const stream = currentStream();

    await click('toggle mic');
    await click('toggle camera');

    expect(stream.audio.readyState).toBe('live');
    expect(stream.video.readyState).toBe('live');
    expect(screen.getByTestId('stream-state')).toHaveTextContent('active');
  });

  it('applies a mute chosen while the camera was closed to the stream acquired later', async () => {
    renderCamera();

    await waitFor(() => expect(screen.getByTestId('stream-state')).toHaveTextContent('active'));

    await click('stop camera');
    await waitFor(() => expect(screen.getByTestId('stream-state')).toHaveTextContent('idle'));

    // Muted while there is no stream at all to apply it to.
    await click('toggle mic');

    await click('start camera');
    await waitFor(() => expect(screen.getByTestId('stream-state')).toHaveTextContent('active'));

    expect(acquired).toHaveLength(2);
    expect(currentStream().audio.enabled).toBe(false);
  });

  it('applies a mute chosen while getUserMedia is still in flight', async () => {
    holdGetUserMedia();

    renderCamera();

    // The permission prompt / device warm-up is still pending here, so the state
    // captured when startCamera was called is already stale by the time the
    // stream arrives.
    await click('toggle mic');

    expect(acquired).toHaveLength(0);

    await releaseGetUserMedia();

    await waitFor(() => expect(screen.getByTestId('stream-state')).toHaveTextContent('active'));

    expect(currentStream().audio.enabled).toBe(false);
  });
});
