"""rig.py -- the capture abstraction for the gimbal + depth-camera rig.

One job: given a commanded gimbal pose, return a Frame carrying
    rgb        (h, w, 3) uint8      -- resampled onto the DEPTH grid
    depth      (h, w)    float32    -- METRES, perspective Z (distance along -Z_cam)
    confidence (h, w)    uint8|None -- ARKit ARConfidenceLevel 0/1/2, None if unavailable
    fx fy cx cy                     -- intrinsics OF THE DEPTH GRID, pixels
    rotation   quaternion           -- camera->world, MONTY convention (+X right, +Y up, -Z fwd)
    position   (3,)      float64    -- camera position in world METRES

Three backends, chosen by RIG_BACKEND:
    synthetic  ray-cast a known object. No hardware. Always works. The default.
    record3d   iPhone Pro LiDAR over USB via the Record3D app. The recommended real path.
    mono       ffmpeg/avfoundation RGB + monocular metric depth. ESTIMATED, not measured.

THE GEOMETRY THAT DEFINES THIS RIG
----------------------------------
A gimbal rotates IN PLACE. The camera's position is fixed; only its orientation
changes. Two consequences drive every design decision in this spike:

  1. NO PARALLAX, therefore no structure-from-motion. Every 3D point must come
     from a per-frame depth measurement. Without depth there is no spike.
  2. ONLY ONE SIDE OF THE OBJECT IS EVER VISIBLE. The rig can never see the far
     side, so a learned model is a front surface cap, not a closed object. Two
     of three dimensions are measurable; the third is a lower bound. `scan.py`
     reports this explicitly rather than quietly presenting a truncated depth
     as if it were a measurement.

DEPTH CONVENTION
----------------
`depth` is perpendicular Z (distance along the optical axis), NOT euclidean
range. This is what ARKit sceneDepth reports and what Monty's DepthTo3DLocations
expects: it unprojects a pixel to `depth * (fx_tan*x_ndc, fy_tan*y_ndc, -1)`,
whose third component is exactly -depth. The two agree.

WORKING RANGE: 0.26 m -- 1.0 m. HARD LIMITS AT BOTH ENDS.
---------------------------------------------------------
  Near: ARKit's rear depth sensor bottoms out around 0.26 m.
  Far:  Monty's own `get_surface_from_depth` does `depth[depth > 1] = 1.0` and
        then returns an all-False surface mask if every pixel is >= 1.0. An
        object past 1.0 m yields ZERO on-surface pixels even when handed a
        perfect ground-truth semantic mask (verified by running it).
`assert_working_range()` enforces this so the failure is loud, not silent.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
from dataclasses import dataclass, field

import numpy as np
import quaternion as qt

# Monty refuses to find a surface beyond this range; see the module docstring.
MONTY_MAX_DEPTH_M = 1.0
# ARKit's rear (LiDAR) sensor floor.
ARKIT_MIN_DEPTH_M = 0.26
# Depth written for pixels with no valid return. Must be >= MONTY_MAX_DEPTH_M so
# Monty's clamp folds it to exactly 1.0 and reads it as the far surface.
BACKGROUND_DEPTH_M = 1.0

# iPhone 13 Pro Max rear wide camera, ARKit sceneDepth grid (256x192).
# fx_depth = fx_rgb * 256/1920 = 1450 * 0.13333 = 193.33  (hfov = 2*atan(128/193.33) = 66.9 deg)
DEFAULT_DEPTH_W, DEFAULT_DEPTH_H = 256, 192
DEFAULT_FX = 193.33
DEFAULT_FY = 193.33


class RigError(RuntimeError):
    """Raised when a backend's hardware or dependency is unavailable."""


def assert_working_range(depth_m: float, what: str = "object") -> None:
    """Fail loudly outside the range where this pipeline can work at all."""
    if depth_m >= MONTY_MAX_DEPTH_M:
        raise RigError(
            f"{what} is at {depth_m:.3f} m, but Monty's get_surface_from_depth clamps "
            f"depth to {MONTY_MAX_DEPTH_M} m and returns an all-False surface mask when "
            f"every pixel reaches it. Nothing will ever be learned. Move the rig closer "
            f"than {MONTY_MAX_DEPTH_M} m."
        )
    if depth_m < ARKIT_MIN_DEPTH_M:
        raise RigError(
            f"{what} is at {depth_m:.3f} m, below ARKit's ~{ARKIT_MIN_DEPTH_M} m rear-sensor "
            f"floor. Real depth there is dropped or noisy. Back off to 0.4-0.8 m."
        )


# --------------------------------------------------------------------------------------
# Frame
# --------------------------------------------------------------------------------------
@dataclass
class Frame:
    """One capture. rgb and depth share the DEPTH grid; intrinsics describe that grid."""

    rgb: np.ndarray  # (h, w, 3) uint8
    depth: np.ndarray  # (h, w) float32, METRES, perspective Z
    fx: float
    fy: float
    cx: float
    cy: float
    rotation: qt.quaternion  # camera -> world, Monty convention
    position: np.ndarray  # (3,) world metres
    confidence: np.ndarray | None = None  # (h, w) uint8, ARKit 0/1/2
    backend: str = "unknown"
    pose_source: str = "unknown"  # "arkit" | "gimbal_dead_reckoning" | "synthetic"
    meta: dict = field(default_factory=dict)

    @property
    def shape(self) -> tuple[int, int]:
        return self.depth.shape

    def valid_mask(self, min_conf: int = 2) -> np.ndarray:
        """Pixels with a usable depth return. ALWAYS gate real ARKit depth on confidence."""
        ok = (
            np.isfinite(self.depth)
            & (self.depth > 0)
            & (self.depth < MONTY_MAX_DEPTH_M)
        )
        if self.confidence is not None:
            ok &= self.confidence >= min_conf
        return ok


# --------------------------------------------------------------------------------------
# Camera maths shared by all backends
# --------------------------------------------------------------------------------------
def pixel_rays(
    h: int, w: int, fx: float, fy: float, cx: float, cy: float
) -> np.ndarray:
    """(h, w, 3) ray directions in the camera frame, Monty convention.

    Each direction has z == -1 exactly, which makes perspective depth and the ray
    parameter the same number: a point at depth d along the ray is d * direction.
    The -(v - cy) flips image rows (v grows downward) into +Y up.
    """
    u = np.arange(w, dtype=np.float64)[None, :]
    v = np.arange(h, dtype=np.float64)[:, None]
    x = (u - cx) / fx * np.ones((h, 1))
    y = -(v - cy) / fy * np.ones((1, w))
    z = -np.ones((h, w))
    return np.stack([x, y, z], axis=-1)


def yaw_pitch_to_quat(yaw_deg: float, pitch_deg: float) -> qt.quaternion:
    """Gimbal (yaw, pitch) -> camera->world rotation, Monty frame (+Y up, -Z forward).

    Intrinsic yaw-then-pitch: R = Ry(yaw) @ Rx(pitch). Matches gimbal.py's composition,
    so the dead-reckoned pose and the rendered pose cannot disagree.
    """
    ry = qt.from_rotation_vector(np.array([0.0, 1.0, 0.0]) * np.deg2rad(yaw_deg))
    rx = qt.from_rotation_vector(np.array([1.0, 0.0, 0.0]) * np.deg2rad(pitch_deg))
    return ry * rx


def resample_to_grid(img: np.ndarray, h: int, w: int) -> np.ndarray:
    """Nearest-neighbour resample of an (H, W, ...) image onto an (h, w) grid."""
    H, W = img.shape[:2]
    if (H, W) == (h, w):
        return img
    vi = np.clip((np.arange(h) + 0.5) * H / h, 0, H - 1).astype(int)
    ui = np.clip((np.arange(w) + 0.5) * W / w, 0, W - 1).astype(int)
    return img[vi[:, None], ui[None, :]]


# --------------------------------------------------------------------------------------
# Backend 1: synthetic -- ray-cast a known object. No hardware.
# --------------------------------------------------------------------------------------
@dataclass
class SyntheticObject:
    """A known object with analytic ground truth, posed in the world frame."""

    kind: str = "sphere"  # "sphere" | "cube"
    size_m: float = 0.10  # sphere diameter, or cube edge
    centre: np.ndarray = field(default_factory=lambda: np.array([0.0, 0.0, -0.5]))
    rotation: qt.quaternion = field(default_factory=lambda: qt.quaternion(1, 0, 0, 0))

    def intersect(self, origins: np.ndarray, dirs: np.ndarray) -> np.ndarray:
        """Ray parameter t of the nearest hit, or NaN. dirs have z == -1 (not unit).

        Because every direction's z component is -1, t is exactly the perspective
        depth of the hit -- no normalisation, no conversion.
        """
        if self.kind == "sphere":
            return self._intersect_sphere(origins, dirs)
        if self.kind == "cube":
            return self._intersect_cube(origins, dirs)
        raise RigError(f"unknown synthetic object kind {self.kind!r}")

    def _intersect_sphere(self, o: np.ndarray, d: np.ndarray) -> np.ndarray:
        r = self.size_m / 2.0
        oc = o - self.centre
        a = np.einsum("...k,...k->...", d, d)
        b = 2.0 * np.einsum("...k,...k->...", d, oc)
        c = np.einsum("...k,...k->...", oc, oc) - r * r
        disc = b * b - 4 * a * c
        t = np.full(disc.shape, np.nan)
        hit = disc > 0
        if hit.any():
            tt = (-b[hit] - np.sqrt(disc[hit])) / (2 * a[hit])
            t[hit] = np.where(tt > 0, tt, np.nan)
        return t

    def _intersect_cube(self, o: np.ndarray, d: np.ndarray) -> np.ndarray:
        """Slab method in the cube's own frame."""
        R = qt.as_rotation_matrix(self.rotation)
        ol = (o - self.centre) @ R  # world -> local  (R^T x == x @ R)
        dl = d @ R
        half = self.size_m / 2.0
        with np.errstate(divide="ignore", invalid="ignore"):
            inv = 1.0 / dl
            t1 = (-half - ol) * inv
            t2 = (half - ol) * inv
        tmin = np.nanmax(np.minimum(t1, t2), axis=-1)
        tmax = np.nanmin(np.maximum(t1, t2), axis=-1)
        t = np.where((tmax >= np.maximum(tmin, 0.0)), tmin, np.nan)
        return np.where(t > 0, t, np.nan)

    def surface_colour(self, kind_seed: int = 0) -> tuple[int, int, int]:
        return (200, 120, 90) if self.kind == "sphere" else (110, 160, 200)


class SyntheticRig:
    """Ray-casts a known object through the real camera model. Ground truth available.

    Models the rig honestly: the camera sits at a FIXED position and only rotates,
    exactly like a phone in a gimbal cradle. It therefore sees one side of the
    object and one side only.
    """

    name = "synthetic"

    def __init__(
        self,
        obj: SyntheticObject | None = None,
        camera_position: np.ndarray | None = None,
        w: int = DEFAULT_DEPTH_W,
        h: int = DEFAULT_DEPTH_H,
        fx: float = DEFAULT_FX,
        fy: float = DEFAULT_FY,
        noise_m: float = 0.0,
        seed: int = 0,
    ) -> None:
        self.obj = obj or SyntheticObject()
        self.camera_position = (
            np.zeros(3)
            if camera_position is None
            else np.asarray(camera_position, float)
        )
        self.w, self.h = w, h
        self.fx, self.fy = fx, fy
        self.cx, self.cy = w / 2.0, h / 2.0
        self.noise_m = noise_m
        self._rng = np.random.RandomState(seed)
        self._rays = pixel_rays(h, w, fx, fy, self.cx, self.cy)
        assert_working_range(self.range_m, "synthetic object")

    @property
    def range_m(self) -> float:
        """Distance from the camera to the object centre."""
        return float(np.linalg.norm(self.obj.centre - self.camera_position))

    @property
    def silhouette_half_angle_deg(self) -> float:
        """Half-angle subtended by the object -- the aiming envelope for the sweep.

        Beyond this the frame-centre ray misses the object entirely. For a sphere
        this is exact; for a cube it is the circumscribed-sphere approximation.
        """
        r = self.obj.size_m / 2.0
        if self.obj.kind == "cube":
            r *= np.sqrt(3.0) / 2.0  # a cube's inscribed-to-circumscribed compromise
        return float(np.degrees(np.arcsin(np.clip(r / self.range_m, -1, 1))))

    def connect(self) -> SyntheticRig:
        return self

    def close(self) -> None:
        pass

    def capture(self, yaw_deg: float, pitch_deg: float) -> Frame:
        rot = yaw_pitch_to_quat(yaw_deg, pitch_deg)
        R = qt.as_rotation_matrix(rot)
        dirs_world = self._rays @ R.T
        origins = np.broadcast_to(self.camera_position, dirs_world.shape)
        t = self.obj.intersect(origins, dirs_world)

        depth = np.where(np.isfinite(t), t, BACKGROUND_DEPTH_M).astype(np.float32)
        if self.noise_m > 0:
            hit = np.isfinite(t)
            depth[hit] += self._rng.normal(
                0.0, self.noise_m, size=int(hit.sum())
            ).astype(np.float32)
        depth = np.clip(depth, 0.0, BACKGROUND_DEPTH_M)

        rgb = np.zeros((self.h, self.w, 3), np.uint8)
        rgb[np.isfinite(t)] = self.obj.surface_colour()
        # Confidence 2 where we have a real return, 0 on the synthetic background --
        # the same shape of signal ARKit gives, so downstream code cannot come to
        # depend on confidence being absent.
        conf = np.where(np.isfinite(t), 2, 0).astype(np.uint8)

        return Frame(
            rgb=rgb,
            depth=depth,
            confidence=conf,
            fx=self.fx,
            fy=self.fy,
            cx=self.cx,
            cy=self.cy,
            rotation=rot,
            position=self.camera_position.copy(),
            backend=self.name,
            pose_source="synthetic",
            meta={
                "yaw_deg": yaw_deg,
                "pitch_deg": pitch_deg,
                "hit_px": int(np.isfinite(t).sum()),
            },
        )

    # -- ground truth ------------------------------------------------------------------
    def anchor_point(self, yaw_deg: float, pitch_deg: float) -> np.ndarray | None:
        """World-frame point the CENTRE ray hits, or None. This is what Monty records.

        Monty's percept carries exactly one location per step -- the patch's centre
        pixel. The learned graph is therefore the set of anchor points visited, so
        this is the ground truth the learned model should be compared against.
        """
        rot = yaw_pitch_to_quat(yaw_deg, pitch_deg)
        R = qt.as_rotation_matrix(rot)
        d_cam = np.array(
            [(self.cx - self.cx) / self.fx, -(self.cy - self.cy) / self.fy, -1.0]
        )
        d_world = R @ d_cam
        t = self.obj.intersect(self.camera_position[None, :], d_world[None, :])[0]
        if not np.isfinite(t):
            return None
        return self.camera_position + t * d_world

    def visible_surface_extent_mm(self, n: int = 400) -> np.ndarray:
        """Extent of the whole visible surface, by dense ray-cast. Independent of Monty."""
        half = self.silhouette_half_angle_deg * 1.6
        ys, ps = np.meshgrid(np.linspace(-half, half, n), np.linspace(-half, half, n))
        pts = []
        for yaw, pitch in zip(ys.ravel(), ps.ravel(), strict=True):
            p = self.anchor_point(float(yaw), float(pitch))
            if p is not None:
                pts.append(p)
        if not pts:
            return np.zeros(3)
        pts = np.array(pts)
        return (pts.max(0) - pts.min(0)) * 1000.0


# --------------------------------------------------------------------------------------
# Backend 2: record3d -- iPhone Pro LiDAR over USB. THE RECOMMENDED REAL PATH.
# --------------------------------------------------------------------------------------
class Record3DRig:
    """ARKit RGB + sceneDepth + 6-DoF pose, streamed from the Record3D iOS app.

    Prerequisites, none of which can be done from an agent session:
      1. Buy/install Record3D on an iPhone Pro (LiDAR). Basic tier includes USB streaming.
      2. Settings -> enable "USB Streaming mode". Press record.
      3. USB-C to the Mac.

    Run it from .venv, which has monty AND record3d AND transformers (the venvs
    were consolidated; .venv-depth is redundant and is NOT the one to use):
        .venv/bin/python scan.py
    record3d needs no torch, so it is immune to the torch-sparse blocker that
    forces monty's --no-deps install.

    !! UNVERIFIED ON HARDWARE !! Two things must be checked on the first real run:
      (a) DEPTH MAP ORIENTATION. ARKit streams in the native sensor (landscape)
          orientation. If the phone is cradled in portrait, rows/columns map to
          camera X/Y differently than assumed here. Symptom: the learned model is
          transposed or mirrored. Check: point at an obviously asymmetric object
          and confirm the reconstructed cloud is not flipped.
      (b) POSE HANDEDNESS. ARKit camera space is +X right, +Y up, -Z forward, which
          matches Monty. Cross-check against the gimbal's own quaternion by
          commanding a known +45 deg yaw and confirming the ARKit pose agrees.
    """

    name = "record3d"

    def __init__(self, device_index: int = 0, min_conf: int = 2) -> None:
        self.device_index = device_index
        self.min_conf = min_conf
        self._session = None
        self._evt = None

    def connect(self, timeout_s: float = 10.0) -> Record3DRig:
        try:
            from record3d import Record3DStream
        except ImportError as exc:
            raise RigError(
                "record3d is not importable. It belongs in .venv (monty + record3d + "
                "transformers all live there; .venv-depth is redundant). Run this with "
                ".venv/bin/python, or install it: "
                "uv pip install --python .venv/bin/python record3d"
            ) from exc
        from threading import Event

        devs = Record3DStream.get_connected_devices()
        if len(devs) <= self.device_index:
            raise RigError(
                f"No Record3D device at index {self.device_index} ({len(devs)} found). "
                "Plug the iPhone in by USB, open Record3D, enable Settings -> "
                "'USB Streaming mode', and press record."
            )
        self._evt = Event()
        self._session = Record3DStream()
        self._session.on_new_frame = self._evt.set
        self._session.connect(devs[self.device_index])
        if not self._evt.wait(timeout_s):
            raise RigError(
                f"Connected but no frame arrived within {timeout_s:.0f}s -- press record in the app."
            )
        if self._session.get_device_type() != 1:
            raise RigError(
                "Connected device is the TrueDepth (front) camera, not the rear LiDAR. "
                "The rear sensor is the one with usable range for object scanning."
            )
        return self

    def capture(self, yaw_deg: float, pitch_deg: float) -> Frame:
        if self._session is None:
            raise RigError("Record3DRig.connect() was never called.")
        self._evt.clear()
        if not self._evt.wait(5.0):
            raise RigError("frame timeout -- is the app still recording?")
        s = self._session
        depth = np.asarray(s.get_depth_frame()).astype(np.float32)  # METRES
        conf = np.asarray(s.get_confidence_frame()).astype(np.uint8)
        rgb_full = np.asarray(s.get_rgb_frame())
        h, w = depth.shape

        # The intrinsics describe the RGB grid; depth is smaller. Rescale per axis.
        # coeffs.tx/ty are the PRINCIPAL POINT (cx, cy), NOT a translation -- the
        # single easiest thing to get wrong in this API.
        c = s.get_intrinsic_mat()
        sx, sy = w / (2.0 * c.tx), h / (2.0 * c.ty)
        fx, fy, cx, cy = c.fx * sx, c.fy * sy, c.tx * sx, c.ty * sy

        p = s.get_camera_pose()
        rotation = qt.quaternion(p.qw, p.qx, p.qy, p.qz)  # numpy-quaternion is W FIRST
        position = np.array([p.tx, p.ty, p.tz], float)

        # No valid return -> push to the background sentinel so Monty's histogram
        # sees a clean far surface rather than a NaN.
        bad = ~(np.isfinite(depth) & (depth > 0) & (conf >= self.min_conf))
        depth = np.where(bad, BACKGROUND_DEPTH_M, depth).astype(np.float32)

        return Frame(
            rgb=resample_to_grid(rgb_full, h, w),
            depth=depth,
            confidence=conf,
            fx=fx,
            fy=fy,
            cx=cx,
            cy=cy,
            rotation=rotation,
            position=position,
            backend=self.name,
            pose_source="arkit",
            meta={
                "yaw_deg": yaw_deg,
                "pitch_deg": pitch_deg,
                "rgb_shape": list(rgb_full.shape),
                "high_conf_px": int((conf >= 2).sum()),
            },
        )

    def close(self) -> None:
        if self._session is not None:
            self._session.disconnect()


# --------------------------------------------------------------------------------------
# Backend 3: mono -- RGB + monocular metric depth. ESTIMATED, NOT MEASURED.
# --------------------------------------------------------------------------------------
class MonoRig:
    """ffmpeg/avfoundation RGB + Depth-Anything-V2 metric depth.

    DO NOT PRESENT THIS AS A MEASUREMENT. Published error for the metric-indoor
    model is 0.32-0.66 m mean at the ranges we work in, against objects ~0.10 m
    across -- the error is several times the size of the thing being measured.
    Anything written from this backend must be labelled estimated, and must never
    land in a field the product presents as measured.

    It is here for two honest uses: shape cues when no LiDAR is available, and
    keeping the pipeline exercisable without the phone.

    Two blockers on this Mac:
      - macOS camera permission is notDetermined and cannot be self-granted from a
        headless shell; AVCaptureDevice.requestAccess returns granted=false. A human
        must run one ffmpeg capture from a real Terminal and approve the prompt.
      - The device rejects ffmpeg's default 29.97 fps; -framerate 30 is required.
    Pose has no independent source here, so it is the gimbal's dead-reckoned setpoint.
    """

    name = "mono"

    def __init__(
        self,
        av_index: int | None = None,
        hfov_deg: float | None = None,
        w: int = DEFAULT_DEPTH_W,
        h: int = DEFAULT_DEPTH_H,
        camera_position: np.ndarray | None = None,
    ) -> None:
        self.av_index = (
            int(os.environ.get("RIG_AV_INDEX", "2")) if av_index is None else av_index
        )
        self.hfov_deg = (
            float(os.environ.get("RIG_MONO_HFOV_DEG", "66.9"))
            if hfov_deg is None
            else hfov_deg
        )
        self.w, self.h = w, h
        self.cx, self.cy = w / 2.0, h / 2.0
        self.fx = (w / 2.0) / np.tan(np.deg2rad(self.hfov_deg) / 2.0)
        self.fy = self.fx
        self.camera_position = (
            np.zeros(3)
            if camera_position is None
            else np.asarray(camera_position, float)
        )
        self._proc = None
        self._model = None

    MONO_INSTALL_HINT = (
        "uv pip install --python .venv/bin/python torch torchvision "
        "'transformers>=4.48' pillow accelerate"
    )

    def connect(self) -> MonoRig:
        try:
            import torch
            from transformers import AutoImageProcessor, AutoModelForDepthEstimation
        except ImportError as exc:
            raise RigError(
                f"torch/transformers not importable. Install them: {self.MONO_INSTALL_HINT}"
            ) from exc
        import torch

        mid = os.environ.get(
            "RIG_MONO_MODEL", "depth-anything/Depth-Anything-V2-Metric-Indoor-Small-hf"
        )
        self._device = "mps" if torch.backends.mps.is_available() else "cpu"
        # transformers defers its hard dependencies to first use, so a missing backend
        # (torchvision, most often) surfaces HERE as a bare ImportError from a lazy
        # proxy class rather than at the import above. Catch it in the same shape as a
        # missing hardware dependency, or the mono backend fails with a traceback into
        # transformers' import_utils that says nothing about this rig.
        try:
            self._proc = AutoImageProcessor.from_pretrained(mid)
            self._model = (
                AutoModelForDepthEstimation.from_pretrained(mid).eval().to(self._device)
            )
        except ImportError as exc:
            raise RigError(
                f"transformers could not load {mid}: {exc}\n"
                f"Usually a missing backend. Try: {self.MONO_INSTALL_HINT}"
            ) from exc
        except OSError as exc:
            raise RigError(
                f"could not fetch {mid} (first run needs network access to the HF hub, "
                f"or set HF_HOME to a populated cache): {exc}"
            ) from exc
        self._grab_rgb()  # fail now, not mid-scan, if the camera is blocked
        return self

    def _grab_rgb(self) -> np.ndarray:
        from PIL import Image

        with tempfile.TemporaryDirectory() as td:
            out = os.path.join(td, "f.jpg")
            cmd = [
                "ffmpeg",
                "-nostdin",
                "-loglevel",
                "error",
                "-f",
                "avfoundation",
                "-framerate",
                "30",  # the device REJECTS ffmpeg's 29.97 default
                "-video_size",
                "1920x1440",
                "-i",
                str(self.av_index),
                "-frames:v",
                "1",
                "-y",
                out,
            ]
            try:
                subprocess.run(cmd, check=True, capture_output=True, timeout=20)
            except subprocess.TimeoutExpired as exc:
                raise RigError(
                    "ffmpeg hung at session start. This Mac's camera permission is "
                    "notDetermined and cannot be granted from a headless shell. Run "
                    f"`{' '.join(cmd)}` once from a REAL interactive Terminal and approve "
                    "the prompt, then retry."
                ) from exc
            except subprocess.CalledProcessError as exc:
                raise RigError(
                    f"ffmpeg failed: {exc.stderr.decode(errors='replace')[:500]}"
                ) from exc
            except FileNotFoundError as exc:
                raise RigError("ffmpeg is not on PATH.") from exc
            return np.asarray(Image.open(out).convert("RGB"))

    def capture(self, yaw_deg: float, pitch_deg: float) -> Frame:
        if self._model is None:
            raise RigError("MonoRig.connect() was never called.")
        import torch
        from PIL import Image

        rgb_full = self._grab_rgb()
        img = Image.fromarray(rgb_full)
        inp = self._proc(images=img, return_tensors="pt").to(self._device)
        with torch.no_grad():
            out = self._model(**inp)
        depth_full = (
            self._proc.post_process_depth_estimation(
                out, target_sizes=[(img.height, img.width)]
            )[0]["predicted_depth"]
            .cpu()
            .numpy()
            .astype(np.float32)
        )
        depth = resample_to_grid(depth_full, self.h, self.w).astype(np.float32)
        depth = np.where(np.isfinite(depth) & (depth > 0), depth, BACKGROUND_DEPTH_M)
        depth = np.clip(depth, 0.0, BACKGROUND_DEPTH_M)

        return Frame(
            rgb=resample_to_grid(rgb_full, self.h, self.w),
            depth=depth,
            confidence=None,
            fx=self.fx,
            fy=self.fy,
            cx=self.cx,
            cy=self.cy,
            rotation=yaw_pitch_to_quat(yaw_deg, pitch_deg),
            position=self.camera_position.copy(),
            backend=self.name,
            pose_source="gimbal_dead_reckoning",
            meta={
                "yaw_deg": yaw_deg,
                "pitch_deg": pitch_deg,
                "ESTIMATED": True,
                "warning": "monocular depth: 0.32-0.66 m mean error. Not a measurement.",
            },
        )

    def close(self) -> None:
        pass


# --------------------------------------------------------------------------------------
def make_rig(backend: str | None = None, **kwargs):
    """Build the backend named by RIG_BACKEND (default 'synthetic')."""
    backend = (backend or os.environ.get("RIG_BACKEND", "synthetic")).lower()
    if backend == "synthetic":
        return SyntheticRig(**kwargs)
    if backend == "record3d":
        return Record3DRig(
            **{k: v for k, v in kwargs.items() if k in ("device_index", "min_conf")}
        )
    if backend == "mono":
        return MonoRig(
            **{
                k: v
                for k, v in kwargs.items()
                if k in ("av_index", "hfov_deg", "w", "h", "camera_position")
            }
        )
    raise RigError(
        f"unknown RIG_BACKEND {backend!r}; expected synthetic | record3d | mono"
    )


if __name__ == "__main__":
    rig = make_rig().connect()
    f = rig.capture(0.0, 0.0)
    on = f.valid_mask()
    print(
        f"backend={f.backend} pose_source={f.pose_source} depth{f.depth.shape} "
        f"fx={f.fx:.2f} cx={f.cx:.1f}"
    )
    print(f"  range to object centre : {getattr(rig, 'range_m', float('nan')):.3f} m")
    print(
        f"  silhouette half-angle  : {getattr(rig, 'silhouette_half_angle_deg', float('nan')):.2f} deg"
    )
    print(
        f"  valid depth px         : {int(on.sum())}/{on.size}  "
        f"[{f.depth[on].min():.4f} .. {f.depth[on].max():.4f}] m"
    )
    if hasattr(rig, "visible_surface_extent_mm"):
        print(
            f"  visible surface extent : {np.round(rig.visible_surface_extent_mm(), 2)} mm"
        )
