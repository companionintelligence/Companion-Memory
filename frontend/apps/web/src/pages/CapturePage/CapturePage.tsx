import { useCallback } from 'react';

import { Camera, getImageDataURL, getVideoPreviewDataURL } from '@ci/capture';
import { Portal, usePageTitle } from '@ci/common';
import { Breadcrumb, useToast } from '@ci/shadcn';

import { useAuth } from '@/hooks';

export function CapturePage() {
  usePageTitle('Capture - Companion Intelligence');

  const [{ authToken }] = useAuth();
  const { toast } = useToast();

  const handleFrameCaptured = useCallback(async (file: File) => {
    const formData = new FormData();

    formData.append('file', file);

    const res = await fetch('/api/files/upload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
      body: formData,
    });

    if (!res.ok) {
      throw new Error('Upload failed');
    }

    const dataUrl = await getImageDataURL(file);

    toast.custom((id) => (
      <div
        className="flex flex-col gap-1 p-4 bg-white border border-gray-200 rounded-md shadow-md"
        onClick={() => toast.dismiss(id)}
      >
        <div className="font-semibold text-sm text-gray-800">Image saved</div>
        <img src={dataUrl} alt="Saved image" />
      </div>
    ));
  }, []);

  const handleRecordingFinished = useCallback(async (file: File) => {
    const formData = new FormData();

    formData.append('file', file);

    const res = await fetch('/api/files/upload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
      body: formData,
    });

    if (!res.ok) {
      throw new Error('Upload failed');
    }

    const dataUrl = await getVideoPreviewDataURL(file);

    toast.custom((id) => (
      <div
        className="flex flex-col gap-1 p-4 bg-white border border-gray-200 rounded-md shadow-md"
        onClick={() => toast.dismiss(id)}
      >
        <div className="font-semibold text-sm text-gray-800">Video saved</div>
        <img src={dataUrl} alt="Preview of saved video" />
      </div>
    ));
  }, []);

  return (
    <>
      <Portal.Slot id="breadcrumbs">
        <Breadcrumb>
          <Breadcrumb.List>
            <Breadcrumb.Item className="hidden md:block">
              <Breadcrumb.Link href="/">Home</Breadcrumb.Link>
            </Breadcrumb.Item>
            <Breadcrumb.Separator className="hidden md:block" />
            <Breadcrumb.Item>
              <Breadcrumb.Page>Capture</Breadcrumb.Page>
            </Breadcrumb.Item>
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      <div>
        <Camera onFrameCaptured={handleFrameCaptured} onRecordingFinished={handleRecordingFinished}>
          <div>
            <Camera.Feed />
          </div>
        </Camera>
      </div>
    </>
  );
}

// TODO:
//   This implements webcam capture which works well when we need webcam access.
//   For native camera capture, e.g. iPhone native capture:
//
//     <input type="file" accept="image/*" capture></input>
//
//   But this degenerates to a file upload on desktop. Consider some options to
//   gracefully degrade.

// TODO:
//   Implement some camera settings options. For now we'll just use defaults and
//   get the wheels spinning. An example follows.
//
//
// import { Select } from '@ci/shadcn';
// import { useCamera } from '@ci/capture';
//
// function CameraOptions() {
//   const [{ microphones, cameras, selectedMicrophone, selectedCamera }] = useCamera();
//
//   return (
//     <>
//       <Select value={selectedMicrophone?.id}>
//         <Select.Trigger>
//           <Select.Value placeholder="Select a microphone" />
//         </Select.Trigger>
//         <Select.Content>
//           {microphones.map((microphone) => (
//             <Select.Item key={microphone.id} value={microphone.id}>
//               {microphone.name}
//             </Select.Item>
//           ))}
//         </Select.Content>
//       </Select>
//
//       <Select value={selectedCamera?.id}>
//         <Select.Trigger>
//           <Select.Value placeholder="Select a camera" />
//         </Select.Trigger>
//         <Select.Content>
//           {cameras.map((camera) => (
//             <Select.Item key={camera.id} value={camera.id}>
//               {camera.name}
//             </Select.Item>
//           ))}
//         </Select.Content>
//       </Select>
//     </>
//   );
// }
