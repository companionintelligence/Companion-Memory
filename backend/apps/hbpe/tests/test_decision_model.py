"""
Unit tests for Decision Model inference and Unsloth dataset/trainer integration.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from ci.hbpe.inference.decision_model import (
    MEMORY_INGRESS_QUESTIONS,
    RETRIEVAL_RERANK_QUESTIONS,
    DecisionModelClient,
    DecisionQuestion,
    DecisionResult,
    LocalDecisionEngine,
)
from ci.hbpe.model.unsloth_decision_trainer import (
    UnslothDecisionTrainConfig,
    UnslothDecisionTrainer,
    build_decision_dataset_from_events,
    compute_brier_score,
    compute_calibration_error,
    format_memory_event_to_decision_item,
)


def test_local_decision_engine_ingress_evaluation():
    engine = LocalDecisionEngine()

    state = "Remember to buy milk and eggs at Trader Joe's after my dentist appointment today at 3pm."
    results = engine.evaluate(state, MEMORY_INGRESS_QUESTIONS)

    assert "intent" in results
    assert "is_commitment" in results
    assert "sensitivity" in results

    intent_res = results["intent"]
    assert intent_res.question_type == "choice"
    assert intent_res.value in ["store_task", "store_fact"]
    assert intent_res.probability > 0.0
    assert intent_res.calibrated is True

    commit_res = results["is_commitment"]
    assert commit_res.question_type == "noul"
    assert commit_res.value is True
    assert commit_res.probability > 0.5


def test_local_decision_engine_retrieval_rerank():
    engine = LocalDecisionEngine()

    state = "User query: What was the dentist appointment time? Memory snippet: Dentist appointment scheduled for 3pm today."
    results = engine.evaluate(state, RETRIEVAL_RERANK_QUESTIONS)

    assert "is_relevant" in results
    assert "temporal_freshness" in results

    rel_res = results["is_relevant"]
    assert rel_res.question_type == "noul"
    assert isinstance(rel_res.value, bool)
    assert rel_res.calibrated is True


def test_decision_model_client_fallback():
    # Client with no remote URL uses local engine
    client = DecisionModelClient(base_url=None, enable_local_fallback=True)

    state = "Tomorrow I have a project deadline at 5pm."
    results = client.evaluate(state, MEMORY_INGRESS_QUESTIONS)

    assert len(results) == 3
    assert results["is_commitment"].value is True


def test_unsloth_dataset_formatting():
    item = format_memory_event_to_decision_item(
        text="Need to renew passport before December flight",
        intent_label="store_task",
        is_commitment=True,
        sensitivity_score=1,
    )

    d = item.to_dict()
    assert d["state"] == "Need to renew passport before December flight"
    assert d["answers"]["intent"] == "store_task"
    assert d["answers"]["is_commitment"] is True
    assert d["answers"]["sensitivity"] == 1


def test_build_decision_dataset_from_events():
    events = [
        {"text": "Doctor visit tomorrow at 10am", "intent": "store_task", "actionable": True},
        {"text": "My favorite color is navy blue", "intent": "store_fact"},
        {"text": "", "intent": "conversational"},  # Empty ignored
        {"content": "Just saying hello", "intent": "conversational"},
    ]

    dataset = build_decision_dataset_from_events(events)
    assert len(dataset) == 3
    assert dataset[0]["answers"]["intent"] == "store_task"
    assert dataset[0]["answers"]["is_commitment"] is True
    assert dataset[1]["answers"]["intent"] == "store_fact"


def test_calibration_and_brier_score_metrics():
    # Perfect predictions
    preds = [
        {"class_a": 0.95, "class_b": 0.05},
        {"class_a": 0.10, "class_b": 0.90},
    ]
    ground_truth = ["class_a", "class_b"]

    brier = compute_brier_score(preds, ground_truth)
    assert brier < 0.05

    # Calibration error
    probs = [0.9, 0.8, 0.2, 0.1]
    labels = [True, True, False, False]
    ece = compute_calibration_error(probs, labels, num_bins=5)
    assert ece >= 0.0
    assert ece <= 0.2


def test_unsloth_trainer_export():
    with tempfile.TemporaryDirectory() as tmpdir:
        trainer = UnslothDecisionTrainer(
            UnslothDecisionTrainConfig(
                base_model_name="Qwen/Qwen3.5-0.8B",
                lora_r=16,
                epochs=1,
            )
        )

        train_data = [{"state": "event 1", "answers": {"intent": "store_task"}}]
        eval_data = [{"state": "eval 1", "answers": {"intent": "store_task"}}]

        meta = trainer.train_and_export(train_data, eval_data, tmpdir)
        assert meta["model_type"] == "decision-laya-unsloth"
        assert meta["lora_rank"] == 16
        assert meta["eval_metrics"]["top1_accuracy"] > 0.9

        meta_path = Path(tmpdir) / "decision_model_meta.json"
        assert meta_path.exists()
        loaded = json.loads(meta_path.read_text())
        assert loaded["model_type"] == "decision-laya-unsloth"
