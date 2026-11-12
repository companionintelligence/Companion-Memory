"""
Unit tests for Decision Model inference and Unsloth dataset/trainer integration.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from ci.hbpe.inference.decision_model import (
    MEMORY_INGRESS_QUESTIONS,
    RETRIEVAL_RERANK_QUESTIONS,
    DecisionModelClient,
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
        {
            "text": "Doctor visit tomorrow at 10am",
            "intent": "store_task",
            "actionable": True,
        },
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


def test_qwen_labeler_l0_fastpath(monkeypatch):
    """Ensure confident decision model resolves L0 without invoking Qwen LLM."""
    from ci.hbpe.config import settings
    from ci.hbpe.tokenizer.qwen_labeler import QwenLabeler

    monkeypatch.setattr(settings, "enable_decision_models", True)
    monkeypatch.setattr(settings, "decision_confidence_threshold", 0.70)

    class MockQwenShouldNotCall:
        def generate(self, *args, **kwargs):
            raise AssertionError(
                "Qwen.generate should not be called when decision model is confident!"
            )

    import ci.hbpe.inference.qwen as qwen_mod

    monkeypatch.setattr(qwen_mod, "get_qwen", lambda: MockQwenShouldNotCall())

    labeler = QwenLabeler()
    # "Sprint review and roadmap sync" matches WORK keywords
    l0 = labeler._resolve_l0(
        "Sprint review and roadmap sync", "Engineering project sync"
    )
    assert l0 == "WORK"


def test_qwen_labeler_l0_fallback_when_disabled(monkeypatch):
    """Ensure Qwen LLM is called when decision models are disabled."""
    from ci.hbpe.config import settings
    from ci.hbpe.tokenizer.qwen_labeler import QwenLabeler

    monkeypatch.setattr(settings, "enable_decision_models", False)

    qwen_called = False

    class MockQwen:
        def generate(self, *args, **kwargs):
            nonlocal qwen_called
            qwen_called = True
            return json.dumps({"l0": "EXERCISE"})

    import ci.hbpe.inference.qwen as qwen_mod

    monkeypatch.setattr(qwen_mod, "get_qwen", lambda: MockQwen())

    labeler = QwenLabeler()
    l0 = labeler._resolve_l0("Morning 5k run", None)
    assert l0 == "EXERCISE"
    assert qwen_called is True


def test_qwen_labeler_batch_resolve_hybrid(monkeypatch):
    """Test batch L0 resolution where high-confidence items skip Qwen and ambiguous ones use Qwen."""
    from ci.hbpe.config import settings
    from ci.hbpe.tokenizer.qwen_labeler import QwenLabeler

    monkeypatch.setattr(settings, "enable_decision_models", True)
    monkeypatch.setattr(settings, "decision_confidence_threshold", 0.75)

    qwen_calls = []

    class MockQwenBatch:
        def batch_generate(self, prompts, **kwargs):
            qwen_calls.append(len(prompts))
            return [json.dumps({"l0": "LEISURE"}) for _ in prompts]

    import ci.hbpe.inference.qwen as qwen_mod

    monkeypatch.setattr(qwen_mod, "get_qwen", lambda: MockQwenBatch())

    labeler = QwenLabeler()
    titles = [
        "Weekly engineering standup meeting",  # WORK (high confidence in local engine)
        "Something obscure without keywords",  # Fallback to Qwen
        "Morning gym workout and fitness",  # EXERCISE (high confidence)
    ]
    descriptions = [None, None, None]

    results = labeler._batch_resolve_l0(titles, descriptions)
    assert results[0] == "WORK"
    assert results[1] == "LEISURE"  # From MockQwen
    assert results[2] == "EXERCISE"
    # Qwen should have only been called for 1 item (the obscure one)!
    assert qwen_calls == [1]

def test_decision_api_routes(monkeypatch):
    """Test the FastAPI /decision/ingress, /decision/rerank, and /decision/l0 endpoints."""
    from fastapi.testclient import TestClient

    from ci.hbpe.api import app
    from ci.hbpe.config import settings

    monkeypatch.setattr(settings, "sidecar_auth_secret", "s3cret")
    client = TestClient(app)
    headers = {"Authorization": "Bearer s3cret"}
    user_id = "3b0c9c7e-6a52-4a52-8c53-0d3b2c2b1e11"

    # 1. /decision/ingress
    ingress_resp = client.post(
        "/decision/ingress",
        params={"user_id": user_id},
        json={"text": "Remember to submit the tax return by tomorrow at 5pm."},
        headers=headers,
    )
    assert ingress_resp.status_code == 200
    ingress_data = ingress_resp.json()
    assert ingress_data["user_id"] == user_id
    assert ingress_data["is_commitment"] is True
    assert ingress_data["commitment_probability"] > 0.5
    assert ingress_data["intent"] in ["store_task", "store_fact"]

    # 2. /decision/rerank
    rerank_resp = client.post(
        "/decision/rerank",
        params={"user_id": user_id},
        json={
            "query": "When is my dentist appointment?",
            "passages": [
                {
                    "id": "p-irrelevant",
                    "text": "Bought groceries and coffee beans yesterday morning.",
                },
                {
                    "id": "p-relevant",
                    "text": "Dentist appointment scheduled for today at 3pm with Dr. Patel.",
                },
            ],
        },
        headers=headers,
    )
    assert rerank_resp.status_code == 200
    rerank_data = rerank_resp.json()
    assert rerank_data["user_id"] == user_id
    assert len(rerank_data["results"]) == 2
    assert rerank_data["results"][0]["id"] == "p-relevant"
    assert (
        rerank_data["results"][0]["score"]
        >= rerank_data["results"][1]["score"]
    )

    # 3. /decision/l0
    l0_resp = client.post(
        "/decision/l0",
        params={"user_id": user_id},
        json={
            "title": "Morning gym workout and 5k run",
            "description": "Strength training and cardio",
        },
        headers=headers,
    )
    assert l0_resp.status_code == 200
    l0_data = l0_resp.json()
    assert l0_data["user_id"] == user_id
    assert l0_data["l0_class"] == "EXERCISE"
    assert l0_data["confidence"] > 0.5

def test_decision_models_are_off_unless_enabled(monkeypatch):
    """The keyword fallback must not label events unless someone opts in."""
    from ci.hbpe.config import Settings

    monkeypatch.delenv("HBPE_ENABLE_DECISION_MODELS", raising=False)
    assert Settings().enable_decision_models is False

    monkeypatch.setenv("HBPE_ENABLE_DECISION_MODELS", "true")
    assert Settings().enable_decision_models is True
