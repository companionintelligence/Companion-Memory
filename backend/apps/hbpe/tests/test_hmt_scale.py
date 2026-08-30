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

    monkeypatch.setattr(
        settings, "label_api_base", "http://host.docker.internal:8000/v1"
    )
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
        {"choices": [{"message": {"content": '<think>nope</think>{"l0":"WORK"}'}}]}
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


def test_openai_chat_labeler_does_not_append_no_think(monkeypatch):
    from ci.hbpe.config import settings
    from ci.hbpe.inference.qwen import OpenAIChatLabeler

    monkeypatch.setattr(settings, "qwen_disable_thinking", True)
    captured: dict = {}
    payload = json.dumps(
        {"choices": [{"message": {"content": '{"l0":"WORK"}'}}]}
    ).encode()

    class _Resp(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def fake_urlopen(req, timeout=None):
        captured["body"] = json.loads(req.data.decode())
        captured["timeout"] = timeout
        return _Resp(payload)

    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        OpenAIChatLabeler("http://example/v1", "Qwen3-8B").generate("Standup")

    user = captured["body"]["messages"][-1]["content"]
    assert "/no_think" not in user
    assert user == "Standup"
    assert captured["body"]["chat_template_kwargs"]["enable_thinking"] is False
    assert captured["timeout"] == settings.label_http_timeout_seconds


def test_label_http_timeout_defaults_to_five_minutes(monkeypatch):
    monkeypatch.delenv("HBPE_LABEL_HTTP_TIMEOUT", raising=False)
    from ci.hbpe.config import Settings

    assert Settings().label_http_timeout_seconds == 300


def test_label_http_timeout_env_cap(monkeypatch):
    monkeypatch.setenv("HBPE_LABEL_HTTP_TIMEOUT", "45")
    from ci.hbpe.config import Settings

    assert Settings().label_http_timeout_seconds == 45


def test_label_http_timeout_none_waits_forever(monkeypatch):
    monkeypatch.setenv("HBPE_LABEL_HTTP_TIMEOUT", "none")
    from ci.hbpe.config import Settings

    assert Settings().label_http_timeout_seconds is None


def test_api_url_defaults_to_api_3030(monkeypatch):
    monkeypatch.delenv("API_URL", raising=False)
    from ci.hbpe.config import Settings

    assert Settings().api_url == "http://api:3030"


def test_unlabeled_content_sql_reads_entity_name():
    import inspect

    from ci.hbpe.data_client import get_unlabeled_content

    source = inspect.getsource(get_unlabeled_content)
    assert "e.name AS title" in source
    assert "JOIN ci.entities e ON e.entity_id = c.id" in source
    assert "c.title" not in source
