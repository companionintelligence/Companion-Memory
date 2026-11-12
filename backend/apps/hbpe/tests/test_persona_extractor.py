"""
Unit tests for PersonaDataExtractor and persona decision model training.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

try:
    import pytest
    has_pytest = True
except ImportError:
    has_pytest = False
    pytest = None

from ci.hbpe.model.persona_extractor import (
    PersonaDataExtractor,
    PersonaDatasetAuditResult,
    _infer_commitment,
    _infer_l0,
    _infer_urgency,
    train_persona_decision_model,
)

# The real-data tests read a personal export, so they run only when
# HBPE_PERSONA_EXPORT_DIR points at one. Without it they skip, and the suite
# never reads personal data by default.
PERSONAL_EXPORT_DIR = os.environ.get("HBPE_PERSONA_EXPORT_DIR", "")


def skip_without_export(fn):
    if not PERSONAL_EXPORT_DIR or not Path(PERSONAL_EXPORT_DIR).exists():
        if has_pytest:
            return pytest.mark.skip(reason="Set HBPE_PERSONA_EXPORT_DIR to run tests against a persona export")(fn)
        return lambda *args, **kwargs: None
    return fn


def test_keyword_heuristics():
    assert _infer_commitment("Hey man I'm gonna be in DC this week, let's meet!") is True
    assert _infer_commitment("What was that movie again?") is False

    assert _infer_l0("Sprint planning meeting") == "WORK"
    assert _infer_l0("Apartment shopping") == "ERRAND"
    assert _infer_l0("Morning workout at the gym") == "EXERCISE"

    assert _infer_urgency("Need this asap!") == 2
    assert _infer_urgency("I will do this tomorrow") == 1
    assert _infer_urgency("Casual observation") == 0


@skip_without_export
def test_persona_extractor_audit_real_data():
    extractor = PersonaDataExtractor(PERSONAL_EXPORT_DIR)
    audit = extractor.audit()

    assert audit.total_items > 0
    assert audit.chat_messages >= 1000
    assert audit.tasks >= 400
    assert audit.saved_places >= 100
    assert "chat_impostors" in audit.sources_scanned
    assert "google_takeout_zip" in audit.sources_scanned


@skip_without_export
def test_persona_extractor_splits_real_data():
    extractor = PersonaDataExtractor(PERSONAL_EXPORT_DIR)
    train_data, eval_data = extractor.create_train_eval_splits(eval_ratio=0.20)

    assert len(train_data) > 0
    assert len(eval_data) > 0
    assert len(train_data) > len(eval_data)

    first_train = train_data[0]
    assert "state" in first_train
    assert "answers" in first_train
    assert "intent" in first_train["answers"]
    assert "is_commitment" in first_train["answers"]


@skip_without_export
def test_persona_decision_model_training_end_to_end():
    with tempfile.TemporaryDirectory() as tmpdir:
        meta = train_persona_decision_model(
            export_dir=PERSONAL_EXPORT_DIR,
            output_dir=tmpdir,
            base_model_name="Convai/Laya-320M",
            epochs=1,
            lora_r=16,
        )

        assert meta["model_type"] == "decision-laya-unsloth"
        assert meta["lora_rank"] == 16
        assert meta["record_counts"]["total"] > 1000
        assert meta["eval_metrics"]["top1_accuracy"] > 0.85
        assert meta["eval_metrics"]["brier_score"] <= 0.15
        assert meta["eval_metrics"]["expected_calibration_error"] <= 0.06

        meta_file = Path(tmpdir) / "persona_decision_meta.json"
        assert meta_file.exists()
        loaded = json.loads(meta_file.read_text())
        assert loaded["record_counts"]["total"] == meta["record_counts"]["total"]


if __name__ == "__main__":
    print("Running test_keyword_heuristics...")
    test_keyword_heuristics()
    print("Running test_persona_extractor_audit_real_data...")
    test_persona_extractor_audit_real_data()
    print("Running test_persona_extractor_splits_real_data...")
    test_persona_extractor_splits_real_data()
    print("Running test_persona_decision_model_training_end_to_end...")
    test_persona_decision_model_training_end_to_end()
    print("All persona extractor tests passed!")
