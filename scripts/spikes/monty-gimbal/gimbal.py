"""Python client for the DJI Osmo Mobile 6 gimbal, plus the Monty Action -> pan/tilt mapping.

WHY THIS EXISTS
---------------
The gimbal is normally driven through an MCP server (`osmo-gimbal`), which an agent can call
but a plain Python loop cannot. That MCP server is only a thin HTTP client: the process that
actually owns the BLE link is `server/backend.mjs`, an ordinary HTTP server on :8788. So
Python talks to the backend directly and skips MCP entirely.

    Python (this file)  ->  HTTP :8788  ->  backend.mjs  ->  BLE/DUML  ->  Osmo Mobile 6

Source of truth for every route and payload below:
    $OSMO_BLE_DIR/server/backend.mjs
    $OSMO_BLE_DIR/protocol/commands.mjs
    $OSMO_BLE_DIR/protocol/telemetry.mjs

STARTING THE BACKEND (do this by hand, in a real interactive Terminal window)
----------------------------------------------------------------------------
    cd $OSMO_BLE_DIR && npm run backend

It MUST be a real terminal session. macOS only shows the Bluetooth (TCC) permission prompt to a
process with a window session; launched headlessly it hangs forever on the first BLE call
instead of prompting. This is documented in backend.mjs's own header and in the project README.

Then, once per backend process (the backend keeps ZERO state on disk -- device id, paired flag
and last quaternion all live in memory and are lost on restart):

    curl -s -XPOST localhost:8788/api/scan   -d '{"timeoutMs":5000}' -H 'content-type: application/json'
    curl -s -XPOST localhost:8788/api/connect -d '{"deviceId":"<id from scan>"}' -H 'content-type: application/json'
    curl -s -XPOST localhost:8788/api/pair    -d '{"pin":"<PIN shown on the gimbal screen>"}' -H 'content-type: application/json'

FAKE MODE
---------
Set GIMBAL_FAKE=1 and nothing touches the network or the hardware; synthetic quaternions are
generated from the commanded angles. Everything downstream of this file is testable today.
"""

from __future__ import annotations

import json
import math
import os
import time
import urllib.error
import urllib.request
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any

# --------------------------------------------------------------------------------------
# Hardware limits. Enforced here, and independently by the MCP tool schemas upstream.
# --------------------------------------------------------------------------------------
YAW_LIMIT_DEG = 160.0
PITCH_LIMIT_DEG = 60.0

DEFAULT_BASE_URL = os.environ.get("OSMO_BACKEND_URL", "http://localhost:8788")

# Backend's moved/not-moved threshold, copied from backend.mjs's command-probe handler
# (`moved: delta !== null && delta > 0.02`). Kept here so fake mode agrees with real mode.
MOVED_DELTA_THRESHOLD = 0.02


class GimbalError(RuntimeError):
    """Any failure talking to the backend, including 'the backend is not running'."""


# --------------------------------------------------------------------------------------
# Quaternion helpers.
#
# WIRE ORDER CAVEAT -- READ THIS BEFORE TRUSTING ANY ANGLE OUT OF THE DEVICE.
#
# telemetry.mjs decodes four little-endian float32s at payload offset 24 of the unprompted
# cmdSet=0x04 cmdId=0x05 frame and hands them back as a bare 4-list. The MCP tool description
# calls that list "[x,y,z,w]", and web/orientation.mjs destructures it as `[x, y, z, w]` --
# but that file's own comment says, verbatim, that it has NOT been confirmed which axis of the
# gimbal's quaternion frame maps to which real-world pitch/yaw/roll, and labels its Euler
# readout "approx" throughout. So [x,y,z,w] is a CONVENTION THIS CODEBASE ASSUMED, not a
# measured fact, and neither the handedness nor the zero reference of that frame is pinned
# down anywhere in the repo.
#
# Consequence: treat the device quaternion as a *relative change / did-it-move* signal, which
# is exactly what backend.mjs itself uses it for (euclidean delta vs a threshold). Do not use
# it as a calibrated attitude unless and until someone runs the one live test that names the
# axes. See `docs` in the return of `GimbalClient.convention_notes()`.
# --------------------------------------------------------------------------------------
Quat = tuple[
    float, float, float, float
]  # (x, y, z, w) -- the assumed device wire order


def quat_multiply(a: Quat, b: Quat) -> Quat:
    """Hamilton product of two (x, y, z, w) quaternions."""
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    )


def quat_from_axis_angle(axis: Sequence[float], degrees: float) -> Quat:
    """(x, y, z, w) quaternion for a rotation of `degrees` about `axis`."""
    half = math.radians(degrees) / 2.0
    s = math.sin(half)
    n = math.sqrt(sum(c * c for c in axis)) or 1.0
    return (axis[0] / n * s, axis[1] / n * s, axis[2] / n * s, math.cos(half))


def quat_delta(a: Quat | None, b: Quat | None) -> float | None:
    """Euclidean distance between two quaternion samples.

    Deliberately identical to `quaternionDelta` in protocol/telemetry.mjs -- this is the metric
    the backend's own moved/not-moved verdict is computed from, so fake mode must match it.
    """
    if a is None or b is None:
        return None
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b, strict=True)))


def yaw_pitch_to_quat(yaw_deg: float, pitch_deg: float) -> Quat:
    """Compose (yaw, pitch) into an (x, y, z, w) quaternion in MONTY's frame convention.

    Monty/Habitat convention: +Y up, -Z forward, +X right.
      * yaw   = rotation about +Y, positive == anticlockwise == LEFT
                (mujoco `Embodiment.yaw` builds Rotation.from_euler("xyz", (0, delta, 0)),
                 and `actuate_turn_left` passes +rotation_degrees while `actuate_turn_right`
                 passes -rotation_degrees)
      * pitch = rotation about the sensor's +X, positive == UP
                (`actuate_look_up` passes +rotation_degrees to `pitch_sensor`, look_down -)

    Intrinsic yaw-then-pitch: R = Ry(yaw) * Rx(pitch). That is exactly the order Monty itself
    composes in -- `SensorModule.update_state` does `agent.rotation * sensor.rotation`, with
    yaw living on the agent and pitch on the sensor.
    """
    return quat_multiply(
        quat_from_axis_angle((0.0, 1.0, 0.0), yaw_deg),
        quat_from_axis_angle((1.0, 0.0, 0.0), pitch_deg),
    )


def to_monty_rotation(q_xyzw: Quat):
    """(x, y, z, w) -> `quaternion.quaternion` (w, x, y, z), what AgentState.rotation needs.

    This reorder is not cosmetic. `AgentState.rotation` is typed `Any` but is consumed by
    `SensorModule.update_state` as `qt.rotate_vectors(agent.rotation, ...)` and
    `agent.rotation * sensor.rotation` -- so it must be a real `quaternion.quaternion` object,
    and numpy-quaternion's constructor takes W FIRST. Monty's own `QuaternionWXYZ` alias in
    src/tbp/monty/math.py says the same (`IDENTITY_QUATERNION = (1.0, 0.0, 0.0, 0.0)`).
    Feeding an xyzw tuple straight in silently yields a rotation that is wrong in a way no
    exception will catch.
    """
    import quaternion as qt  # imported lazily: the pure-client path has no numpy dependency

    x, y, z, w = q_xyzw
    return qt.quaternion(w, x, y, z)


# --------------------------------------------------------------------------------------
# The client
# --------------------------------------------------------------------------------------
class GimbalClient:
    """Talks to server/backend.mjs on :8788, or fakes it entirely.

    Real-mode routes used (all of them are in backend.mjs's `routes` table):
        GET  /api/status                -> {connected, paired, lastQuaternion}
        POST /api/command               <- {type, params}      -> {frameHex}
        POST /api/test/command-probe    <- {type, params, waitMs, stop}
                                        -> {sent, before, after, delta, moved}
        GET  /api/frames?limit=N        -> {frames: [...]}   (BLE PROTOCOL frames, NOT images)
        POST /api/scan | /api/connect | /api/pair | /api/disconnect   (session setup)

    `command-probe` is the interesting one: it samples orientation, sends the command, sleeps
    `waitMs`, samples again, and returns both samples plus the delta. One HTTP call therefore
    does move + settle + verify, which is precisely the per-step primitive a scan loop wants.
    It is also what the `gimbal_move_to` MCP tool calls, so Python and the agent drive the
    hardware through an identical path.
    """

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        fake: bool | None = None,
        fake_noise: float = 0.0015,
        fake_time_scale: float | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.fake = _env_flag("GIMBAL_FAKE") if fake is None else fake
        self._fake_noise = fake_noise
        self._fake_time_scale = (
            float(os.environ.get("GIMBAL_FAKE_TIME_SCALE", "0.0"))
            if fake_time_scale is None
            else fake_time_scale
        )
        # Fake-mode device state. The real device keeps the equivalent inside backend.mjs.
        self._fake_yaw = 0.0
        self._fake_pitch = 0.0
        self._fake_seq = 0

    # -- transport ---------------------------------------------------------------------
    def _request(
        self, method: str, path: str, body: dict | None = None, timeout: float = 15.0
    ) -> dict:
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json"} if data else {}
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode() or "{}")
        except (
            urllib.error.HTTPError
        ) as exc:  # backend returns {"error": "..."} with 4xx/5xx
            detail = exc.read().decode(errors="replace")
            try:
                detail = json.loads(detail).get("error", detail)
            except Exception:
                pass
            raise GimbalError(f"{method} {path} -> HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise GimbalError(
                f"Can't reach the Osmo backend at {self.base_url} ({exc.reason}). Start it with "
                f"`cd $OSMO_BLE_DIR && npm run backend` in a "
                f"REAL interactive Terminal (macOS will not grant Bluetooth to a headless "
                f"process), then scan/connect/pair. Or set GIMBAL_FAKE=1 to run offline."
            ) from exc

    # -- fake device -------------------------------------------------------------------
    def _fake_quat(self) -> Quat:
        """Synthetic telemetry: the true pose plus a little deterministic jitter.

        Jitter matters -- it keeps downstream code from accidentally depending on two reads at
        the same pose being bit-identical, which they never are on real hardware.
        """
        self._fake_seq += 1
        n = self._fake_noise
        jitter_yaw = n * 30.0 * math.sin(self._fake_seq * 0.7)
        jitter_pitch = n * 30.0 * math.cos(self._fake_seq * 1.3)
        return yaw_pitch_to_quat(
            self._fake_yaw + jitter_yaw, self._fake_pitch + jitter_pitch
        )

    def _fake_sleep(self, seconds: float) -> None:
        if self._fake_time_scale > 0:
            time.sleep(seconds * self._fake_time_scale)

    # -- public API --------------------------------------------------------------------
    def status(self) -> dict:
        """{connected, paired, lastQuaternion}. Cheap; safe to poll."""
        if self.fake:
            return {
                "connected": True,
                "paired": True,
                "lastQuaternion": list(self._fake_quat()),
                "fake": True,
            }
        return self._request("GET", "/api/status")

    def get_orientation(self) -> Quat | None:
        """Most recent telemetry quaternion as (x, y, z, w), or None if none has arrived yet.

        The device streams this unprompted at ~10-20 Hz once connected and subscribed; there is
        no query command, so `None` means "connected but no frame decoded yet" -- give it a
        beat and read again. See the WIRE ORDER CAVEAT above before interpreting the values.
        """
        q = self.status().get("lastQuaternion")
        return tuple(float(v) for v in q) if q else None  # type: ignore[return-value]

    def move_to(
        self,
        yaw_deg: float = 0.0,
        pitch_deg: float = 0.0,
        dwell_ms: int = 2000,
        move_duration_s: float = 1.0,
    ) -> dict:
        """Move to an ABSOLUTE (yaw, pitch), settle for `dwell_ms`, and verify it moved.

        Returns {yawDeg, pitchDeg, before, after, delta, moved, quaternion}, where `quaternion`
        is `after` as an (x, y, z, w) tuple -- the settled orientation, which is the one a
        capture should be tagged with.

        Angles are clamped to the hardware envelope here rather than left to fail upstream. A
        clamp is reported in the result as `clamped`, because a silently-clamped move makes the
        caller's dead-reckoned pose diverge from the real head (see GimbalHead below).
        """
        target_yaw, yaw_clamped = _clamp(yaw_deg, YAW_LIMIT_DEG)
        target_pitch, pitch_clamped = _clamp(pitch_deg, PITCH_LIMIT_DEG)

        if self.fake:
            before = self._fake_quat()
            self._fake_sleep(move_duration_s + dwell_ms / 1000.0)
            self._fake_yaw, self._fake_pitch = target_yaw, target_pitch
            after = self._fake_quat()
        else:
            probe = self._request(
                "POST",
                "/api/test/command-probe",
                {
                    # type/params land in backend.mjs's buildAndSend -> buildGimbalAbsoluteAngle.
                    # NB `durationSeconds` is truncated then x10 into a single byte on the wire,
                    # so fractional durations below 1.0s all collapse to 0.
                    "type": "absoluteAngle",
                    "params": {
                        "yawDeg": target_yaw,
                        "pitchDeg": target_pitch,
                        "durationSeconds": move_duration_s,
                    },
                    "waitMs": int(dwell_ms),
                },
                # The backend blocks for waitMs before replying, so the socket timeout must
                # clear the dwell with room to spare.
                timeout=15.0 + dwell_ms / 1000.0 + move_duration_s,
            )
            before = tuple(probe["before"]) if probe.get("before") else None  # type: ignore[assignment]
            after = tuple(probe["after"]) if probe.get("after") else None  # type: ignore[assignment]

        delta = quat_delta(before, after)
        return {
            "yawDeg": target_yaw,
            "pitchDeg": target_pitch,
            "requestedYawDeg": yaw_deg,
            "requestedPitchDeg": pitch_deg,
            "clamped": yaw_clamped or pitch_clamped,
            "before": before,
            "after": after,
            "quaternion": after,
            "delta": delta,
            "moved": delta is not None and delta > MOVED_DELTA_THRESHOLD,
        }

    def recenter(self, duration_s: float = 1.0) -> dict:
        """Return to (0, 0).

        Uses the same absolute-angle path as move_to rather than the dedicated 0x4C recenter
        opcode, so that dead reckoning and the hardware agree on what "centered" means. The
        0x4C opcode is reachable as `raw_command`/`type: "resetAndCenter"` if you want it.
        """
        return self.move_to(
            0.0, 0.0, dwell_ms=int(duration_s * 1000) + 1000, move_duration_s=duration_s
        )

    def nudge(
        self,
        yaw_deg_per_s: float = 0.0,
        pitch_deg_per_s: float = 0.0,
        duration_ms: int = 500,
    ) -> dict:
        """Velocity move for `duration_ms`, then an explicit zero-speed stop.

        The stop is mandatory, not politeness: speed-control commands run until countermanded,
        so a dropped stop leaves the head sweeping indefinitely.
        """
        if self.fake:
            self._fake_sleep(duration_ms / 1000.0)
            self._fake_yaw, _ = _clamp(
                self._fake_yaw + yaw_deg_per_s * duration_ms / 1000.0, YAW_LIMIT_DEG
            )
            self._fake_pitch, _ = _clamp(
                self._fake_pitch + pitch_deg_per_s * duration_ms / 1000.0,
                PITCH_LIMIT_DEG,
            )
            return {"sent": True, "fake": True, "quaternion": self._fake_quat()}
        speeds = {"yawDegPerSec": yaw_deg_per_s, "pitchDegPerSec": pitch_deg_per_s}
        self._request("POST", "/api/command", {"type": "speed", "params": speeds})
        time.sleep(duration_ms / 1000.0)
        self._request("POST", "/api/command", {"type": "speed", "params": {}})  # stop
        return {"sent": True, **speeds, "quaternion": self.get_orientation()}

    def recent_frames(self, limit: int = 50) -> list[dict]:
        """Decoded BLE/DUML protocol frames -- telemetry, battery, pairing acks.

        NOT a camera. There is no image capture anywhere in the gimbal stack; the camera is
        whatever phone is sitting in the cradle.
        """
        if self.fake:
            return []
        return self._request("GET", f"/api/frames?limit={int(limit)}").get("frames", [])

    def raw_command(self, type_: str, params: dict | None = None) -> dict:
        """Escape hatch onto POST /api/command. Valid `type_` values, from backend.mjs:
        recenter | absoluteAngle | setMode | speed | stickControlEnable | resetAndCenter |
        setWorkMode | raw.
        """
        if self.fake:
            return {"sent": True, "fake": True, "type": type_}
        return self._request(
            "POST", "/api/command", {"type": type_, "params": params or {}}
        )

    @staticmethod
    def convention_notes() -> dict:
        """Everything about frames/conventions that is assumed rather than measured."""
        return {
            "device_quaternion_order": "[x, y, z, w] -- ASSUMED by this codebase, never measured",
            "device_quaternion_frame": "unknown zero reference and handedness; web/orientation.mjs "
            "calls its own Euler decomposition 'approx' for exactly this reason",
            "safe_use": "relative change / did-it-move, which is what the backend itself uses it for",
            "unsafe_use": "calibrated absolute attitude, or registering depth frames",
            "monty_rotation_order": "(w, x, y, z) -- numpy-quaternion; use to_monty_rotation()",
            "pose_of_record": "the phone's own ARKit/Record3D 6-DoF pose, not this quaternion",
        }


def _clamp(value: float, limit: float) -> tuple[float, bool]:
    clamped = max(-limit, min(limit, value))
    return clamped, clamped != value


def _env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


# --------------------------------------------------------------------------------------
# Monty Action -> gimbal mapping
# --------------------------------------------------------------------------------------
# Monty's motor system returns a list[Action] from a 14-action vocabulary. On a pan/tilt head
# bolted to a tripod, exactly four of those are physically actuatable:
#
#     TurnLeft(agent_id, rotation_degrees)                      -> yaw   += rotation_degrees
#     TurnRight(agent_id, rotation_degrees)                     -> yaw   -= rotation_degrees
#     LookUp(agent_id, rotation_degrees, constraint_degrees)    -> pitch += rotation_degrees
#     LookDown(agent_id, rotation_degrees, constraint_degrees)  -> pitch -= rotation_degrees
#
# (Attribute names verified in monty/src/tbp/monty/frameworks/actions/actions.py; sign
# conventions verified against the MuJoCo actuator, simulators/mujoco/agents.py, which is the
# habitat-free reference implementation.)
#
# The other ten need translation the gimbal cannot provide -- MoveForward, MoveTangentially --
# or set absolute pose in a frame the head has no notion of -- SetAgentPose, SetSensorPose,
# SetSensorRotation, SetAgentPitch, SetSensorPitch, SetYaw, OrientHorizontal, OrientVertical.
# SetYaw and SetAgentPitch are the near misses: both are absolute single-axis setpoints and
# could be wired straight through later. They are rejected for now rather than approximated,
# because a silently-wrong actuation is worse than a loudly-unsupported one.
#
# TWO THINGS THE MAPPING MUST GET RIGHT
#
# 1. Monty's actions are RELATIVE DELTAS; the gimbal's absoluteAngle command is ABSOLUTE. So
#    the head must keep the running (yaw, pitch) setpoint itself -- which is what GimbalHead is.
#
# 2. The envelope truncates. Yaw saturates at +/-160 and pitch at +/-60, but Monty believes
#    yaw is unbounded and will happily keep issuing TurnLeft past the stop. Every step
#    therefore reports the ACHIEVED delta alongside the requested one, and the caller must feed
#    the achieved delta into its pose estimate. Feeding the requested delta instead makes
#    Monty's model of where it is drift away from where the camera actually points, silently,
#    and every observation after the first clamp lands in the wrong place in the object model.
# --------------------------------------------------------------------------------------
_ACTUATABLE = {"turn_left", "turn_right", "look_up", "look_down"}


@dataclass
class GimbalStep:
    """One Monty action resolved against the head's envelope."""

    action_name: str
    requested_yaw_delta: float = 0.0
    requested_pitch_delta: float = 0.0
    achieved_yaw_delta: float = 0.0
    achieved_pitch_delta: float = 0.0
    yaw_deg: float = 0.0
    pitch_deg: float = 0.0
    clamped: bool = False
    supported: bool = True
    reason: str = ""

    @property
    def truncated(self) -> bool:
        """True when the head could not deliver the full requested rotation."""
        return (
            abs(self.achieved_yaw_delta - self.requested_yaw_delta) > 1e-9
            or abs(self.achieved_pitch_delta - self.requested_pitch_delta) > 1e-9
        )


@dataclass
class GimbalHead:
    """Accumulates relative Monty actions into an absolute, clamped (yaw, pitch) setpoint."""

    yaw_deg: float = 0.0
    pitch_deg: float = 0.0
    yaw_limit: float = YAW_LIMIT_DEG
    pitch_limit: float = PITCH_LIMIT_DEG
    history: list[GimbalStep] = field(default_factory=list)

    def apply(self, action: Any) -> GimbalStep:
        """Fold one Action into the setpoint and return what actually happened."""
        name = getattr(action, "name", None) or type(action).__name__
        if name not in _ACTUATABLE:
            step = GimbalStep(
                action_name=name,
                yaw_deg=self.yaw_deg,
                pitch_deg=self.pitch_deg,
                supported=False,
                reason=(
                    "requires translation, which a pan/tilt head cannot do"
                    if name in {"move_forward", "move_tangentially"}
                    else "absolute-pose action; no calibrated frame to set it in"
                ),
            )
            self.history.append(step)
            return step

        degrees = float(getattr(action, "rotation_degrees", 0.0))
        yaw_req = pitch_req = 0.0
        if name == "turn_left":
            yaw_req = degrees  # +yaw == anticlockwise == left
        elif name == "turn_right":
            yaw_req = -degrees
        elif name == "look_up":
            pitch_req = degrees  # +pitch == up
        else:  # look_down
            pitch_req = -degrees

        # Monty's own pitch limit rides on the action as constraint_degrees, and Monty applies
        # it to CUMULATIVE pitch, not per-step (see Embodiment.pitch_sensor in the MuJoCo
        # simulator). Honour it, but never above what the hardware can do.
        pitch_limit = self.pitch_limit
        constraint = getattr(action, "constraint_degrees", None)
        if constraint is not None:
            pitch_limit = min(pitch_limit, abs(float(constraint)))

        new_yaw, yaw_clamped = _clamp(self.yaw_deg + yaw_req, self.yaw_limit)
        new_pitch, pitch_clamped = _clamp(self.pitch_deg + pitch_req, pitch_limit)

        step = GimbalStep(
            action_name=name,
            requested_yaw_delta=yaw_req,
            requested_pitch_delta=pitch_req,
            achieved_yaw_delta=new_yaw - self.yaw_deg,
            achieved_pitch_delta=new_pitch - self.pitch_deg,
            yaw_deg=new_yaw,
            pitch_deg=new_pitch,
            clamped=yaw_clamped or pitch_clamped,
        )
        self.yaw_deg, self.pitch_deg = new_yaw, new_pitch
        self.history.append(step)
        return step

    def apply_all(self, actions: Iterable[Any]) -> list[GimbalStep]:
        """Fold a whole list[Action] -- what Monty's motor system actually hands back."""
        return [self.apply(a) for a in actions]

    def target(self) -> tuple[float, float]:
        return self.yaw_deg, self.pitch_deg

    def dead_reckoned_quat(self) -> Quat:
        """The setpoint as an (x, y, z, w) quaternion in Monty's frame.

        This is what the head was TOLD to do. It is not evidence of what it did -- for that,
        read `move_to(...)["quaternion"]`, and preferably the phone's ARKit pose instead.
        """
        return yaw_pitch_to_quat(self.yaw_deg, self.pitch_deg)

    def reset(self) -> None:
        self.yaw_deg = self.pitch_deg = 0.0
        self.history.clear()


def step_gimbal(
    client: GimbalClient,
    head: GimbalHead,
    actions: Iterable[Any],
    dwell_ms: int = 2000,
    move_duration_s: float = 1.0,
) -> dict:
    """Fold a list[Action] into one absolute move, execute it, and report the outcome.

    One move per action LIST, not per action: Monty often emits several rotations at once, and
    the head only has to visit the endpoint. Fewer moves also means fewer settle windows, which
    dominate wall-clock time in a scan.
    """
    steps = head.apply_all(actions)
    yaw, pitch = head.target()
    result = client.move_to(
        yaw, pitch, dwell_ms=dwell_ms, move_duration_s=move_duration_s
    )
    return {
        "steps": steps,
        "unsupported": [s.action_name for s in steps if not s.supported],
        "truncated": [s.action_name for s in steps if s.supported and s.truncated],
        "target": (yaw, pitch),
        "dead_reckoned": head.dead_reckoned_quat(),
        **result,
    }


# --------------------------------------------------------------------------------------
if __name__ == "__main__":
    os.environ.setdefault("GIMBAL_FAKE", "1")
    g = GimbalClient()
    head = GimbalHead()
    print(f"fake={g.fake}  status={g.status()}")

    try:
        from tbp.monty.frameworks.actions.actions import (
            LookDown,
            LookUp,
            MoveForward,
            TurnLeft,
            TurnRight,
        )

        script = [
            [TurnLeft("agent_id_0", 30.0)],
            [LookUp("agent_id_0", 20.0)],
            [TurnRight("agent_id_0", 75.0), LookDown("agent_id_0", 35.0)],
            [MoveForward("agent_id_0", 0.05)],  # unsupported: needs translation
            [TurnLeft("agent_id_0", 200.0)],  # drives yaw into the +160 stop
        ]
    except ImportError:  # still runnable with no Monty installed
        script = []
        print("(tbp.monty not importable -- skipping the Action demo)")

    for actions in script:
        out = step_gimbal(g, head, actions, dwell_ms=300)
        names = ",".join(getattr(a, "name", type(a).__name__) for a in actions)
        print(
            f"{names:<34} -> yaw={out['target'][0]:7.1f} pitch={out['target'][1]:6.1f} "
            f"moved={out['moved']} truncated={out['truncated']} unsupported={out['unsupported']}"
        )

    q = g.get_orientation()
    print("orientation (x,y,z,w):", tuple(round(v, 4) for v in q) if q else None)
    print("as Monty rotation (w,x,y,z):", to_monty_rotation(q) if q else None)
    print(
        "recenter:",
        {k: v for k, v in g.recenter().items() if k in {"yawDeg", "pitchDeg", "moved"}},
    )
