#!/usr/bin/env python
"""RGBD capture from an iPhone Pro running Record3D in USB Streaming mode.

Emits, per captured frame, exactly what Monty's sensor module needs:
  rgb        (H,W,3) uint8
  depth      (h,w)   float32, METRES, ARKit sceneDepth (LiDAR: 256x192)
  confidence (h,w)   uint8  ARKit ARConfidenceLevel: 0=low 1=medium 2=high
  K          3x3 intrinsics of the RGB frame (fx, fy, cx=coeffs.tx, cy=coeffs.ty)
  pose       (qx,qy,qz,qw, tx,ty,tz) camera pose in the ARKit world frame

Run:  .venv-depth/bin/python rgbd_capture.py --out frames/ --n 1
Prereq: iPhone connected by USB, Record3D app open, Settings -> "USB Streaming mode"
        enabled, and the record button pressed in the app to start the stream.
"""

import argparse
import json
import os
import sys
import time
from threading import Event

import numpy as np
from record3d import Record3DStream

DEVICE_TYPE = {0: "TrueDepth", 1: "LiDAR"}


class RGBDSource:
    def __init__(self, dev_idx: int = 0):
        self.evt = Event()
        self.session = None
        self.dev_idx = dev_idx

    def connect(self, timeout_s: float = 10.0):
        devs = Record3DStream.get_connected_devices()
        if len(devs) <= self.dev_idx:
            raise RuntimeError(
                f"no Record3D device at index {self.dev_idx} ({len(devs)} found). "
                "Plug in the iPhone, open Record3D, enable Settings -> USB Streaming mode, "
                "and press record."
            )
        self.session = Record3DStream()
        self.session.on_new_frame = self.evt.set
        self.session.on_stream_stopped = lambda: print(
            "stream stopped", file=sys.stderr
        )
        self.session.connect(devs[self.dev_idx])
        if not self.evt.wait(timeout_s):
            raise RuntimeError(
                f"connected but no frame within {timeout_s:.0f}s — press record in the app"
            )
        return self

    def grab(self, timeout_s: float = 5.0) -> dict:
        self.evt.clear()
        if not self.evt.wait(timeout_s):
            raise RuntimeError("frame timeout")
        s = self.session
        c = s.get_intrinsic_mat()
        return {
            "t": time.time(),
            "device_type": DEVICE_TYPE.get(s.get_device_type(), "unknown"),
            "rgb": np.asarray(s.get_rgb_frame()),
            "depth": np.asarray(s.get_depth_frame()),  # float32 METRES
            "confidence": np.asarray(s.get_confidence_frame()),
            "K": np.array([[c.fx, 0, c.tx], [0, c.fy, c.ty], [0, 0, 1]], np.float64),
            "pose": {
                k: getattr(s.get_camera_pose(), k)
                for k in ("qx", "qy", "qz", "qw", "tx", "ty", "tz")
            },
        }

    def close(self):
        if self.session:
            self.session.disconnect()


def backproject(
    depth: np.ndarray, K: np.ndarray, conf: np.ndarray | None = None, min_conf: int = 2
) -> np.ndarray:
    """depth (h,w) metres + RGB-frame K -> (N,3) camera-frame points in METRES.

    K is the RGB intrinsic; depth is lower-resolution, so fx/fy/cx/cy are
    rescaled by the depth/RGB size ratio before back-projection.
    """
    h, w = depth.shape
    sx, sy = w / (2 * K[0, 2]), h / (2 * K[1, 2])  # depth/RGB scale per axis
    fx, fy, cx, cy = K[0, 0] * sx, K[1, 1] * sy, K[0, 2] * sx, K[1, 2] * sy
    v, u = np.mgrid[0:h, 0:w]
    z = depth
    ok = np.isfinite(z) & (z > 0)
    if conf is not None and conf.shape == depth.shape:
        ok &= conf >= min_conf
    x = (u - cx) / fx * z
    y = (v - cy) / fy * z
    return np.stack([x[ok], y[ok], z[ok]], -1).astype(np.float32)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="frames")
    ap.add_argument("--n", type=int, default=1)
    ap.add_argument("--dev", type=int, default=0)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    src = RGBDSource(a.dev).connect()
    for i in range(a.n):
        f = src.grab()
        stem = os.path.join(a.out, f"frame_{i:04d}")
        np.savez_compressed(
            stem + ".npz",
            rgb=f["rgb"],
            depth=f["depth"],
            confidence=f["confidence"],
            K=f["K"],
        )
        pts = backproject(f["depth"], f["K"], f["confidence"])
        meta = {k: f[k] for k in ("t", "device_type", "pose")}
        meta |= {
            "rgb_shape": list(f["rgb"].shape),
            "depth_shape": list(f["depth"].shape),
            "K": f["K"].tolist(),
            "n_points_conf_high": len(pts),
            "depth_m_min": float(np.nanmin(f["depth"])),
            "depth_m_max": float(np.nanmax(f["depth"])),
        }
        open(stem + ".json", "w").write(json.dumps(meta, indent=2))
        print(
            f"{stem}: rgb{f['rgb'].shape} depth{f['depth'].shape} "
            f"[{meta['depth_m_min']:.3f}..{meta['depth_m_max']:.3f}] m  "
            f"{len(pts)} high-conf points  ({f['device_type']})"
        )
    src.close()


if __name__ == "__main__":
    main()
