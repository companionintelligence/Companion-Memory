import { DeviceLayoutProvider, isNativePlatform } from '@ci/common';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { captureFromCamera, chooseFiles } from '@/lib/captureMedia';
import { enqueueMemoryUpload } from '@/lib/memoryUploadQueue';
import { canRecordAudio, startAudioRecording } from '@/lib/recordAudio';

import { CaptureModal } from './CaptureModal';

vi.mock('@/hooks', () => ({
  useAuth: () => [{ authToken: 'tok' }],
  useModel: () => [{ selectedVisionModel: 'vision' }],
}));

vi.mock('@ci/common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ci/common')>();

  return {
    ...actual,
    isNativePlatform: vi.fn(),
  };
});

vi.mock('@/lib/captureMedia', () => ({
  captureFromCamera: vi.fn(),
  chooseFiles: vi.fn(),
  chooseFromLibrary: vi.fn(),
}));

vi.mock('@/lib/memoryUploadQueue', () => ({
  enqueueMemoryUpload: vi.fn(async () => []),
}));

vi.mock('@/lib/recordAudio', () => ({
  canRecordAudio: vi.fn(),
  startAudioRecording: vi.fn(),
}));

vi.mock('@ci/capture', () => ({
  Camera: Object.assign(() => <div data-testid="live-camera" />, {
    Information: () => null,
    Feed: () => null,
    DesktopControls: () => null,
  }),
}));

const mockedIsNativePlatform = vi.mocked(isNativePlatform);
const mockedCaptureFromCamera = vi.mocked(captureFromCamera);
const mockedChooseFiles = vi.mocked(chooseFiles);
const mockedCanRecordAudio = vi.mocked(canRecordAudio);
const mockedStartAudioRecording = vi.mocked(startAudioRecording);
const mockedEnqueue = vi.mocked(enqueueMemoryUpload);

function setViewport(mobile: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('max-width') ? mobile : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

function renderCapture() {
  return render(
    <DeviceLayoutProvider args={[]}>
      <CaptureModal open onClose={() => undefined} />
    </DeviceLayoutProvider>,
  );
}

describe('CaptureModal', () => {
  beforeEach(() => {
    mockedIsNativePlatform.mockReturnValue(false);
    mockedCaptureFromCamera.mockResolvedValue(null);
    mockedChooseFiles.mockResolvedValue([]);
    mockedCanRecordAudio.mockReturnValue(false);
    mockedEnqueue.mockClear();
    setViewport(true);
  });

  it('offers photo, video, audio, files, and library — and does not open chat', async () => {
    renderCapture();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Photo' })).toBeInTheDocument());
    expect(screen.getByText('Save to Memory')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Video' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Audio' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Files' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose from library' })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Ask about this content...')).not.toBeInTheDocument();
    expect(screen.queryByTestId('live-camera')).not.toBeInTheDocument();
  });

  it('groups the four sources into a mode bar instead of peer tiles', async () => {
    renderCapture();

    const bar = await screen.findByTestId('capture-mode-bar');
    const labels = within(bar)
      .getAllByRole('button')
      .map((button) => button.textContent);

    expect(labels).toEqual(['Photo', 'Video', 'Audio', 'Files']);
    expect(within(bar).getByRole('button', { name: 'Photo' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(bar).getByRole('button', { name: 'Files' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('stretches the active mode into the leftover vertical space', async () => {
    renderCapture();

    const stage = await screen.findByTestId('capture-stage');

    expect(stage).toHaveClass('flex-1');
    expect(stage.parentElement).toHaveClass('h-full');
  });

  it('opens the native camera as soon as Capture opens on the phone', async () => {
    const clip = new File(['v'], 'IMG.mov', { type: 'video/quicktime' });
    mockedIsNativePlatform.mockReturnValue(true);
    mockedCaptureFromCamera.mockResolvedValue(clip);

    renderCapture();

    // No mode: the system camera keeps its own Photo/Video toggle.
    await waitFor(() => expect(mockedCaptureFromCamera).toHaveBeenCalledWith(undefined));
    await waitFor(() =>
      expect(mockedEnqueue).toHaveBeenCalledWith([clip], expect.objectContaining({ authToken: 'tok' })),
    );
  });

  it('waits for a tap on the web, where an unprompted picker would be blocked', async () => {
    renderCapture();

    await screen.findByTestId('capture-stage');

    expect(mockedCaptureFromCamera).not.toHaveBeenCalled();
  });

  it('saves a captured photo to Memory instead of creating a thread', async () => {
    const photo = new File(['p'], 'IMG.jpg', { type: 'image/jpeg' });
    mockedCaptureFromCamera.mockResolvedValue(photo);

    renderCapture();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Photo' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Photo' }));

    expect(mockedCaptureFromCamera).toHaveBeenCalledWith('photo');
    await waitFor(() =>
      expect(mockedEnqueue).toHaveBeenCalledWith([photo], expect.objectContaining({ authToken: 'tok' })),
    );
    expect(screen.queryByPlaceholderText('Ask about this content...')).not.toBeInTheDocument();
  });

  it('re-runs the selected mode from the stage', async () => {
    renderCapture();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Video' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Video' }));
    fireEvent.click(screen.getByTestId('capture-stage'));

    expect(mockedCaptureFromCamera).toHaveBeenNthCalledWith(1, 'video');
    expect(mockedCaptureFromCamera).toHaveBeenNthCalledWith(2, 'video');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Video' })).toHaveAttribute('aria-pressed', 'true'),
    );
  });

  it('keeps files and audio reachable from the mode bar', async () => {
    mockedCanRecordAudio.mockReturnValue(true);
    mockedStartAudioRecording.mockResolvedValue({
      stop: vi.fn(async () => new File(['a'], 'AUD.m4a', { type: 'audio/mp4' })),
      cancel: vi.fn(),
    });

    renderCapture();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Files' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    expect(mockedChooseFiles).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Audio' }));
    expect(await screen.findByText('Recording')).toBeInTheDocument();
  });

  it('portals the mobile shell to document.body so header tooltips cannot paint over it', async () => {
    render(
      <DeviceLayoutProvider args={[]}>
        <header className="z-20">
          <button type="button">Add</button>
          <CaptureModal open onClose={() => undefined} />
        </header>
      </DeviceLayoutProvider>,
    );

    const shell = await screen.findByTestId('capture-shell');

    expect(shell.parentElement).toBe(document.body);
    expect(shell).toHaveClass('z-[100]');
  });

  it('sits the background-upload hint above the home-indicator inset', async () => {
    renderCapture();

    const hint = await screen.findByTestId('capture-background-hint');

    expect(hint).toHaveTextContent('Uploads continue in the background if you leave this screen.');
    expect(hint.parentElement).toHaveClass('pb-[max(1.5rem,var(--safe-area-bottom))]');
  });
});
