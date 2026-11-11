"""LoRA adapter save/load contracts. Skipped when torch is not installed."""

from __future__ import annotations

import pytest

torch = pytest.importorskip("torch")

from ci.hbpe.model import lora  # noqa: E402
from ci.hbpe.model.train_io import AdapterMismatch, adapter_meta  # noqa: E402
from ci.hbpe.model.transformer import HMTModel  # noqa: E402


def _model() -> HMTModel:
    return HMTModel(l0_vocab_size=20, l1_vocab_size=12)


def test_save_records_the_rank_actually_applied(tmp_path):
    m = _model()
    lora.apply_lora(m, rank=4, alpha=8.0)
    p = tmp_path / "a.pt"
    lora.save_adapter(m, p)
    ck = torch.load(p, weights_only=True)
    assert ck["lora_rank"] == 4
    assert ck["lora_alpha"] == pytest.approx(8.0)


def test_roundtrip_restores_weights_and_leaves_no_temp(tmp_path):
    m = _model()
    lora.apply_lora(m)
    with torch.no_grad():
        for p in m.parameters():
            if p.requires_grad:
                p.add_(0.5)
    path = tmp_path / "a.pt"
    meta = adapter_meta(architecture="x", l1_vocab_fingerprint="f", base_digest="d")
    lora.save_adapter(m, path, meta=meta)
    assert [p.name for p in tmp_path.iterdir()] == ["a.pt"]

    fresh = _model()
    lora.load_adapter(fresh, path, strict=True, expect=meta)
    a = dict(m.named_parameters())
    b = dict(fresh.named_parameters())
    for k in a:
        if a[k].requires_grad:
            assert torch.allclose(a[k], b[k])


def test_strict_load_rejects_a_different_base(tmp_path):
    m = _model()
    lora.apply_lora(m)
    path = tmp_path / "a.pt"
    lora.save_adapter(
        m, path, meta=adapter_meta(architecture="x", l1_vocab_fingerprint=None, base_digest="d1")
    )
    with pytest.raises(AdapterMismatch):
        lora.load_adapter(_model(), path, strict=True, expect={"base_digest": "d2"})


def test_strict_load_rejects_missing_keys(tmp_path):
    m = _model()
    lora.apply_lora(m)
    path = tmp_path / "a.pt"
    lora.save_adapter(m, path)
    ck = torch.load(path, weights_only=True)
    ck["adapter"].pop(next(iter(ck["adapter"])))
    torch.save(ck, path)
    with pytest.raises(AdapterMismatch):
        lora.load_adapter(_model(), path, strict=True)
    # Lenient mode keeps the old behaviour for serving paths.
    lora.load_adapter(_model(), path)
