import { DeviceLayoutProvider, isNativePlatform } from '@ci/common';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { captureFromCamera, chooseAudioFiles, chooseFiles, chooseFromLibrary } from '@/lib/captureMedia';
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
  chooseAudioFiles: vi.fn(),
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
const mockedChooseAudioFiles = vi.mocked(chooseAudioFiles);
const mockedChooseFromLibrary = vi.mocked(chooseFromLibrary);
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
    mockedChooseAudioFiles.mockResolvedValue([]);
    mockedChooseFromLibrary.mockResolvedValue([]);
    mockedCanRecordAudio.mockReturnValue(false);
    mockedStartAudioRecording.mockReset();
    mockedChooseFiles.mockClear();
    mockedChooseAudioFiles.mockClear();
    mockedChooseFromLibrary.mockClear();
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

  it('lands on the picker on the phone and does not open the camera by itself', async () => {
    mockedIsNativePlatform.mockReturnValue(true);

    renderCapture();

    const stage = await screen.findByTestId('capture-stage');

    expect(stage).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Photo' })).toHaveAttribute('aria-pressed', 'true');
    expect(mockedCaptureFromCamera).not.toHaveBeenCalled();
    expect(mockedStartAudioRecording).not.toHaveBeenCalled();
  });

  it('waits for a tap on the web too', async () => {
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
    fireEvent.click(screen.getByTestId('capture-stage'));

    expect(mockedCaptureFromCamera).toHaveBeenCalledWith('photo');
    await waitFor(() =>
      expect(mockedEnqueue).toHaveBeenCalledWith(
        [photo],
        expect.objectContaining({
          authToken: 'tok',
          memoryCapture: true,
          // Fresh from the camera: now is when it was taken.
          capturedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        }),
      ),
    );
    expect(screen.queryByPlaceholderText('Ask about this content...')).not.toBeInTheDocument();
  });

  it('switching the mode bar only switches the tab; the stage runs the mode', async () => {
    mockedCanRecordAudio.mockReturnValue(true);

    renderCapture();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Video' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Video' }));
    fireEvent.click(screen.getByRole('button', { name: 'Audio' }));
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));

    expect(mockedCaptureFromCamera).not.toHaveBeenCalled();
    expect(mockedChooseFiles).not.toHaveBeenCalled();
    expect(mockedChooseAudioFiles).not.toHaveBeenCalled();
    expect(screen.queryByTestId('capture-audio-panel')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Files' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByTestId('capture-stage'));
    expect(mockedChooseFiles).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Video' }));
    fireEvent.click(screen.getByTestId('capture-stage'));
    fireEvent.click(screen.getByTestId('capture-stage'));
    expect(mockedCaptureFromCamera).toHaveBeenNthCalledWith(1, 'video');
    expect(mockedCaptureFromCamera).toHaveBeenNthCalledWith(2, 'video');
  });

  it('keeps files and audio reachable from the stage', async () => {
    mockedCanRecordAudio.mockReturnValue(true);
    mockedStartAudioRecording.mockResolvedValue({
      stop: vi.fn(async () => new File(['a'], 'AUD.m4a', { type: 'audio/mp4' })),
      cancel: vi.fn(),
    });

    renderCapture();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Files' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    fireEvent.click(screen.getByTestId('capture-stage'));
    expect(mockedChooseFiles).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Audio' }));
    fireEvent.click(screen.getByTestId('capture-stage'));
    expect(await screen.findByTestId('capture-audio-panel')).toBeInTheDocument();
  });

  it('opens the audio recorder idle and only records on the Record tap', async () => {
    const take = new File(['a'], 'AUD.m4a', { type: 'audio/mp4' });
    const stop = vi.fn(async () => take);
    mockedCanRecordAudio.mockReturnValue(true);
    mockedStartAudioRecording.mockResolvedValue({ stop, cancel: vi.fn() });

    renderCapture();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Audio' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Audio' }));
    fireEvent.click(screen.getByTestId('capture-stage'));

    const panel = await screen.findByTestId('capture-audio-panel');

    expect(panel).toHaveAttribute('data-status', 'idle');
    expect(screen.getByText('Ready to record')).toBeInTheDocument();
    expect(screen.queryByText('Recording')).not.toBeInTheDocument();
    expect(mockedStartAudioRecording).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Record' }));

    expect(await screen.findByText('Recording')).toBeInTheDocument();
    expect(mockedStartAudioRecording).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

    await waitFor(() =>
      expect(mockedEnqueue).toHaveBeenCalledWith([take], expect.objectContaining({ authToken: 'tok' })),
    );
  });

  it('leaves the audio recorder without recording when cancelled while idle', async () => {
    mockedCanRecordAudio.mockReturnValue(true);

    renderCapture();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Audio' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Audio' }));
    fireEvent.click(screen.getByTestId('capture-stage'));
    await screen.findByTestId('capture-audio-panel');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(await screen.findByTestId('capture-stage')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Audio' })).toHaveAttribute('aria-pressed', 'true');
    expect(mockedStartAudioRecording).not.toHaveBeenCalled();
  });

  it('points "Choose from library" at the selected kind', async () => {
    renderCapture();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Choose from library' })).toBeInTheDocument(),
    );

    // Photo (the default): the photo library. A pick is not fresh, so no
    // capture moment rides along — the bytes carry their own date or none.
    mockedChooseFromLibrary.mockResolvedValueOnce([new File(['p'], 'old.jpg', { type: 'image/jpeg' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Choose from library' }));
    await waitFor(() => expect(mockedChooseFromLibrary).toHaveBeenCalledTimes(1));
    expect(mockedChooseFromLibrary).toHaveBeenLastCalledWith('photo');
    await waitFor(() => expect(mockedEnqueue).toHaveBeenCalledTimes(1));
    expect(mockedEnqueue).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.not.objectContaining({ capturedAt: expect.anything() }),
    );

    // Video: the same library, narrowed to clips.
    fireEvent.click(screen.getByRole('button', { name: 'Video' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose from library' }));
    await waitFor(() => expect(mockedChooseFromLibrary).toHaveBeenCalledTimes(2));
    expect(mockedChooseFromLibrary).toHaveBeenLastCalledWith('video');

    // Audio: audio files, never the photo library.
    fireEvent.click(screen.getByRole('button', { name: 'Audio' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose from library' }));
    await waitFor(() => expect(mockedChooseAudioFiles).toHaveBeenCalledTimes(1));

    // Files: the same document picker the Files mode itself opens.
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose from library' }));
    await waitFor(() => expect(mockedChooseFiles).toHaveBeenCalledTimes(1));

    expect(mockedChooseFromLibrary).toHaveBeenCalledTimes(2);
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
