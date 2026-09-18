"""patch.py -- carve Monty's square sensor patch out of a full camera frame.

Monty's ObservationProcessor is rigid about its input, in ways that are easy to
violate silently:

  * SQUARE ONLY. It does `obs_dim = int(np.sqrt(obs_3d.shape[0]))`. A non-square
    patch does not raise -- it silently reindexes into the wrong pixel.
  * THE ANCHOR IS ONE PIXEL. `center_id = half + obs_dim*half`, and `on_object`
    is read from that pixel alone. If the anchor is off-object the whole
    observation is dropped (`process_features_in_lm=False`), no matter how much
    of the rest of the patch is on the object.
  * ONE LOCATION PER OBSERVATION. The percept carries `location = obs_3d[center_id]`
    -- a single 3D point. The learned graph is the set of ANCHOR POINTS VISITED,
    not the union of the patch point clouds. The patch's other 4095 pixels exist
    only to estimate the surface normal and curvature AT the anchor.
    This is why the motor plan, not the patch size, determines what gets measured.
  * `rgba` must be (P, P, 4): `center_row_col = rgba_feat.shape[0] // 2`.

WHY THIS RESAMPLES INSTEAD OF CROPPING
--------------------------------------
Monty's camera model is a SYMMETRIC frustum about the optical axis: it unprojects
NDC (x, y) to `depth * (tan(hfov/2)*x, tan(hfov/2)*y, -1)`. A naive crop taken
away from the principal point is not a symmetric frustum -- its rays are skewed --
so feeding one to Monty puts every point in the wrong place, with no error raised.

So we resample onto the patch's own symmetric frustum and hand Monty the rotation
that relates it to the camera. That rotation goes in `SensorState.rotation`, which
is exactly what it is for: DepthTo3DLocations composes
`sensor_rotation_rel_world = agent_rotation * sensor_rotation`. The result is
exact for any anchor, not a small-angle approximation.

For this rig the anchor is normally the frame centre anyway -- the GIMBAL does the
aiming, which is the whole point of having one -- and then the rotation is identity
and the resample is a straight reprojection. Off-centre anchors are supported for
the mono backend, where there is no precise actuator to aim with.

DEPTH SAMPLING ACROSS EDGES
---------------------------
Bilinear interpolation across a silhouette blends 0.45 m of object with 1.0 m of
background and invents a surface at 0.7 m that nothing occupies. So we interpolate
only where all four source neighbours are valid, and fall back to nearest-neighbour
otherwise. Phantom edge geometry is worse than a slightly blocky edge.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import quaternion as qt
from rig import BACKGROUND_DEPTH_M, Frame


@dataclass
class Patch:
    """A square patch in Monty's own camera convention, ready to hand to the SM."""

    depth: np.ndarray  # (P, P) float64, METRES, perspective Z in the PATCH frame
    rgba: np.ndarray  # (P, P, 4) uint8
    semantic: np.ndarray  # (P, P) int, 0 = off-object
    hfov_deg: float  # the patch's own horizontal FOV -- pass this to DepthTo3DLocations
    sensor_rotation: (
        qt.quaternion
    )  # patch frame -> camera frame; goes in SensorState.rotation
    anchor_on_object: bool
    n_on_object: int
    source_px_span: (
        float  # how many SOURCE pixels the patch spans (see upsample_factor)
    )
    anchor_depth_m: float

    @property
    def dim(self) -> int:
        return int(self.depth.shape[0])

    @property
    def upsample_factor(self) -> float:
        """out_dim / source_px_span.

        > 1 means the patch is upsampled: the 64x64 grid carries less real
        information than its size suggests, and curvature estimated from it is
        smoother than the sensor actually resolves. On a 256-wide ARKit depth map a
        3 deg patch spans ~11 source pixels, so a 64x64 patch is ~5.6x upsampled.
        Widen `patch_hfov_deg` to buy real resolution, at the cost of the patch
        covering more of the object.
        """
        return self.dim / max(self.source_px_span, 1e-9)

    @property
    def coverage(self) -> float:
        return self.n_on_object / float(self.semantic.size)


def anchor_direction(frame: Frame, u: float, v: float) -> np.ndarray:
    """Unit ray direction for source pixel (u, v), in the camera frame."""
    d = np.array([(u - frame.cx) / frame.fx, -(v - frame.cy) / frame.fy, -1.0])
    return d / np.linalg.norm(d)


def rotation_onto(direction: np.ndarray) -> qt.quaternion:
    """Minimal rotation carrying the camera's -Z axis onto `direction`."""
    axis_from = np.array([0.0, 0.0, -1.0])
    d = direction / np.linalg.norm(direction)
    dot = float(np.clip(np.dot(axis_from, d), -1.0, 1.0))
    if dot > 1.0 - 1e-12:
        return qt.quaternion(1, 0, 0, 0)
    if dot < -1.0 + 1e-12:
        return qt.from_rotation_vector(np.array([0.0, np.pi, 0.0]))
    axis = np.cross(axis_from, d)
    axis /= np.linalg.norm(axis)
    return qt.from_rotation_vector(axis * np.arccos(dot))


def _sample(frame: Frame, u: np.ndarray, v: np.ndarray, min_conf: int = 2):
    """Sample depth/rgb at float pixel coords. Returns (depth, valid, rgb).

    Bilinear where all four neighbours are valid, nearest otherwise -- never blend
    an object edge with the background behind it.
    """
    h, w = frame.depth.shape
    valid_src = frame.valid_mask(min_conf=min_conf)

    u0 = np.floor(u).astype(int)
    v0 = np.floor(v).astype(int)
    fu = u - u0
    fv = v - v0
    inside = (u0 >= 0) & (u0 < w - 1) & (v0 >= 0) & (v0 < h - 1)
    u0c = np.clip(u0, 0, w - 2)
    v0c = np.clip(v0, 0, h - 2)

    d00 = frame.depth[v0c, u0c]
    d01 = frame.depth[v0c, u0c + 1]
    d10 = frame.depth[v0c + 1, u0c]
    d11 = frame.depth[v0c + 1, u0c + 1]
    m00 = valid_src[v0c, u0c]
    m01 = valid_src[v0c, u0c + 1]
    m10 = valid_src[v0c + 1, u0c]
    m11 = valid_src[v0c + 1, u0c + 1]

    bil = (
        d00 * (1 - fu) * (1 - fv)
        + d01 * fu * (1 - fv)
        + d10 * (1 - fu) * fv
        + d11 * fu * fv
    )
    all4 = m00 & m01 & m10 & m11

    un = np.clip(np.rint(u).astype(int), 0, w - 1)
    vn = np.clip(np.rint(v).astype(int), 0, h - 1)
    near = frame.depth[vn, un]
    near_valid = valid_src[vn, un]

    depth = np.where(all4, bil, near)
    valid = np.where(all4, True, near_valid) & inside
    depth = np.where(valid, depth, BACKGROUND_DEPTH_M)
    return depth.astype(np.float64), valid, frame.rgb[vn, un]


def extract_patch(
    frame: Frame,
    out_dim: int = 64,
    patch_hfov_deg: float = 3.0,
    anchor_uv: tuple[float, float] | None = None,
    min_conf: int = 2,
) -> Patch:
    """Resample a square patch of `out_dim`^2 onto its own symmetric frustum.

    Args:
        frame: a capture from rig.py. depth in METRES, perspective Z.
        out_dim: patch side. Monty's stock is 64. NOTE an EVEN side puts the
            anchor at index out_dim//2, a half-pixel off the geometric centre of
            `linspace(-1, 1, out_dim)`; an odd side lands exactly on it. At 3 deg
            over 64 px that bias is 0.023 deg (0.2 mm at 0.5 m), so 64 is kept for
            fidelity with Monty's stock config.
        patch_hfov_deg: the patch's angular width. This is what makes the metric
            scale come out right -- it must describe the SAMPLED grid, not the
            source camera.
        anchor_uv: source pixel to centre on. Defaults to the principal point,
            which is what a gimbal-aimed rig should always use.
    """
    if anchor_uv is None:
        anchor_uv = (frame.cx, frame.cy)
    u_a, v_a = float(anchor_uv[0]), float(anchor_uv[1])

    d_anchor = anchor_direction(frame, u_a, v_a)
    R_off = rotation_onto(d_anchor)
    Rm = qt.as_rotation_matrix(R_off)

    # The patch's own symmetric frustum, in Monty's exact parameterisation:
    # x, y = meshgrid(linspace(-1, 1, w), linspace(1, -1, h)) -- +1 at the TOP row.
    t = np.tan(np.deg2rad(patch_hfov_deg) / 2.0)
    xn, yn = np.meshgrid(np.linspace(-1, 1, out_dim), np.linspace(1, -1, out_dim))
    d_patch = np.stack([t * xn, t * yn, -np.ones_like(xn)], axis=-1)  # (P, P, 3)

    # Rotate each patch ray into the source camera frame and project it.
    d_src = d_patch @ Rm.T
    cz = d_src[..., 2]
    forward = cz < -1e-9
    czs = np.where(forward, cz, -1.0)
    u = frame.cx + frame.fx * (d_src[..., 0] / -czs)
    v = frame.cy - frame.fy * (d_src[..., 1] / -czs)

    depth_src, valid, rgb = _sample(frame, u, v, min_conf=min_conf)

    # Source perspective depth -> patch-frame perspective depth.
    # A point at source depth z along direction d_src sits at z/(-d_src.z) * d_src;
    # expressed in the patch frame that is s * d_patch with s = z/(-d_src.z), and
    # d_patch.z == -1, so the patch-frame depth IS s. Identity when R_off == 1.
    depth = depth_src / -czs
    valid &= forward
    depth = np.where(valid, depth, BACKGROUND_DEPTH_M)
    depth = np.clip(depth, 0.0, BACKGROUND_DEPTH_M)

    semantic = valid.astype(int)
    rgba = np.concatenate(
        [rgb.astype(np.uint8), np.full((*rgb.shape[:2], 1), 255, np.uint8)], axis=-1
    )

    # How many source pixels this patch actually spans, for the upsample warning.
    span_px = float(abs(u[out_dim // 2, -1] - u[out_dim // 2, 0]))

    c = out_dim // 2
    return Patch(
        depth=np.ascontiguousarray(depth),
        rgba=np.ascontiguousarray(rgba),
        semantic=np.ascontiguousarray(semantic),
        hfov_deg=float(patch_hfov_deg),
        sensor_rotation=R_off,
        anchor_on_object=bool(valid[c, c]),
        n_on_object=int(semantic.sum()),
        source_px_span=span_px,
        anchor_depth_m=float(depth[c, c]),
    )


def patch_hfov_for_object(
    size_m: float, range_m: float, fraction: float = 0.25
) -> float:
    """A patch FOV covering `fraction` of the object's angular width.

    Too wide and the patch spans the whole object, so the curvature estimate
    describes the silhouette instead of the local surface. Too narrow and it
    resolves only sensor noise. A quarter is a reasonable starting point.
    """
    full = 2.0 * np.degrees(np.arctan((size_m / 2.0) / range_m))
    return float(full * fraction)


if __name__ == "__main__":
    from rig import SyntheticRig

    rig = SyntheticRig().connect()
    hfov = patch_hfov_for_object(rig.obj.size_m, rig.range_m)
    print(
        f"patch hfov for a {rig.obj.size_m * 1000:.0f} mm object at {rig.range_m:.2f} m "
        f"= {hfov:.2f} deg"
    )

    for yaw in (0.0, 3.0, 5.5, 8.0):
        f = rig.capture(yaw, 0.0)
        p = extract_patch(f, out_dim=64, patch_hfov_deg=hfov)
        print(
            f"  yaw={yaw:4.1f} deg  anchor_on_object={p.anchor_on_object!s:5}  "
            f"coverage={p.coverage:5.1%}  anchor_depth={p.anchor_depth_m:.4f} m  "
            f"src_span={p.source_px_span:5.2f} px  upsample={p.upsample_factor:4.1f}x"
        )

    # Off-axis anchor: the resample must land on the same world point the gimbal
    # would have reached by rotating to it. This is the correctness check for R_off.
    f0 = rig.capture(0.0, 0.0)
    off_u = f0.cx + f0.fx * np.tan(np.deg2rad(3.0))
    p_off = extract_patch(f0, out_dim=64, patch_hfov_deg=hfov, anchor_uv=(off_u, f0.cy))
    p_gim = extract_patch(rig.capture(-3.0, 0.0), out_dim=64, patch_hfov_deg=hfov)
    print(f"\noff-axis anchor at +3 deg : anchor_depth={p_off.anchor_depth_m:.5f} m")
    print(f"gimbal rotated to -3 deg  : anchor_depth={p_gim.anchor_depth_m:.5f} m")
    print(
        f"agreement: {abs(p_off.anchor_depth_m - p_gim.anchor_depth_m) * 1000:.4f} mm"
    )
