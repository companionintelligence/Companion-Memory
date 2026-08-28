"""HMT scale-up: architecture stamp, INT8 serve gate, HTTP labeler."""

from __future__ import annotations

import io
import json
from unittest.mock import patch

import pytest

from ci.hbpe.model.checkpoints import (
    architecture_fingerprint,
    architecture_matches,
    int8_is_servable,
    write_architecture_stamp,
)
from ci.hbpe.model.transformer import D_FF, D_MODEL, N_HEADS, N_LAYERS


@pytest.fixture(autouse=True)
def _isolated_models_dir(tmp_path, monkeypatch):
    from ci.hbpe.config import settings

    monkeypatch.setattr(settings, "models_dir", str(tmp_path), raising=False)
    yield


def test_architecture_fingerprint_matches_compiled_shape():
    assert architecture_fingerprint() == f"{D_MODEL}x{N_LAYERS}h{N_HEADS}ff{D_FF}"
    assert D_MODEL == 256
    assert N_HEADS == 8
    assert N_LAYERS == 6
    assert D_FF == 1024


def test_architecture_stamp_roundtrip():
    uid = "019fb415-c08c-7578-9482-138f8f75b1af"
    assert architecture_matches(uid) is False
    write_architecture_stamp(uid)
    assert architecture_matches(uid) is True


def test_int8_not_servable_without_passing_report(tmp_path):
    uid = "019fb415-c08c-7578-9482-138f8f75b1af"
    from ci.hbpe.model.checkpoints import ONNX_EXPORT_REPORT, user_ckpt_dir

    d = user_ckpt_dir(uid, create=True)
    (d / ONNX_EXPORT_REPORT).write_text(
        json.dumps({"delta_passed": False, "l0_acc_int8": 0.68})
    )
    assert int8_is_servable(uid) is False

    (d / ONNX_EXPORT_REPORT).write_text(json.dumps({"delta_passed": True}))
    assert int8_is_servable(uid) is True


def test_get_qwen_uses_http_when_api_base_set(monkeypatch):
    from ci.hbpe.config import settings
    from ci.hbpe.inference import qwen as qwen_mod

    monkeypatch.setattr(settings, "label_api_base", "http://host.docker.internal:8000/v1")
    monkeypatch.setattr(settings, "label_chat_model", "Qwen3-8B")
    monkeypatch.setattr(settings, "label_api_key", "vllm-local")
    qwen_mod.reset_qwen_for_tests()
    try:
        inst = qwen_mod.get_qwen()
        assert isinstance(inst, qwen_mod.OpenAIChatLabeler)
        assert inst._model == "Qwen3-8B"
    finally:
        qwen_mod.reset_qwen_for_tests()


def test_openai_chat_labeler_strips_thinking(monkeypatch):
    from ci.hbpe.config import settings
    from ci.hbpe.inference.qwen import OpenAIChatLabeler

    monkeypatch.setattr(settings, "qwen_disable_thinking", False)
    payload = json.dumps(
        {
            "choices": [
                {"message": {"content": "<think>nope</think>{\"l0\":\"WORK\"}"}}
            ]
        }
    ).encode("utf-8")

    class _Resp(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    with patch("urllib.request.urlopen", return_value=_Resp(payload)):
        out = OpenAIChatLabeler("http://example/v1", "Qwen3-8B").generate("hi")
    assert out == '{"l0":"WORK"}'
    assert "think" not in out
