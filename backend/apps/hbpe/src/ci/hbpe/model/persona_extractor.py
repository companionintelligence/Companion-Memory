"""
Persona Data Extractor & Dataset Curation for Personal AI Decision Models.

Parses unstructured and semi-structured personal data exports (chat histories,
Google Takeout tasks, saved places, and communications) into calibrated
JSONL datasets for training non-autoregressive decision models with Unsloth.
"""

from __future__ import annotations

import csv
import glob
import io
import json
import logging
import os
import re
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from ci.hbpe.model.unsloth_decision_trainer import (
    DecisionDatasetItem,
    UnslothDecisionTrainConfig,
    UnslothDecisionTrainer,
    compute_brier_score,
    compute_calibration_error,
)
try:
    from ci.hbpe.tokenizer.vocab_registry import L0_CLASSES, normalise_l0
except ImportError:
    L0_CLASSES = (
        "WORK",
        "EXERCISE",
        "SOCIAL",
        "ERRAND",
        "LEISURE",
        "TRANSIT",
        "SLEEP",
        "UNKNOWN",
    )
    _L0_SET = set(L0_CLASSES)

    def normalise_l0(raw: str) -> str:
        cleaned = raw.strip().upper().rstrip(".,;:!")
        return cleaned if cleaned in _L0_SET else "UNKNOWN"

log = logging.getLogger(__name__)

UnslothDecisionItem = DecisionDatasetItem

PERSONA_DECISION_QUESTIONS: Dict[str, Dict[str, Any]] = {
    "intent": {
        "type": "choice",
        "instructions": "Determine primary intent or classification for this entry",
        "criteria": ["store_task", "store_event", "store_fact", "conversational"],
    },
    "is_commitment": {
        "type": "noul",
        "instructions": "Does this text represent a committed task, appointment, or deadline?",
    },
    "urgency": {
        "type": "score",
        "instructions": "Urgency rating from 0 (low/none) to 2 (high/urgent)",
        "criteria": ["low", "normal", "urgent"],
    },
    "privacy_level": {
        "type": "score",
        "instructions": "Privacy sensitivity rating",
        "criteria": ["public", "personal", "confidential"],
    },
    "l0_class": {
        "type": "choice",
        "instructions": "Primary behavioral activity category",
        "criteria": list(L0_CLASSES),
    },
}


# Heuristic keyword matchers for ground truth auto-annotation of personal data
_COMMITMENT_PATTERNS = [
    r"\bi will\b",
    r"\bi'll\b",
    r"\blet's meet\b",
    r"\bremind me\b",
    r"\bdon't forget\b",
    r"\bgonna be in\b",
    r"\bhit me up\b",
    r"\btomorrow at\b",
    r"\bnext week\b",
    r"\bdeadline\b",
    r"\bneed to\b",
    r"\bscheduled?\b",
    r"\bappointment\b",
]

_URGENCY_HIGH_PATTERNS = [
    r"\basap\b",
    r"\burgent\b",
    r"\btoday\b",
    r"\btonight\b",
    r"\bdeadline\b",
    r"\bemergency\b",
    r"\bnow\b",
]

_L0_KEYWORDS: Dict[str, List[str]] = {
    "WORK": ["sprint", "meeting", "roadmap", "engineering", "project", "sync", "code", "review", "smoke signal", "pr", "bug", "deploy"],
    "EXERCISE": ["gym", "run", "workout", "fitness", "cycling", "swim", "training", "exercise", "walk"],
    "SOCIAL": ["party", "dinner", "drinks", "hangout", "lunch with", "coffee", "meet up", "birthday", "celebrate"],
    "ERRAND": ["apartment", "shopping", "dentist", "doctor", "kiva", "bank", "buy", "store", "groceries", "chores"],
    "LEISURE": ["movie", "game", "gaming", "music", "concert", "read", "book", "relax", "show", "nyc", "night"],
    "TRANSIT": ["flight", "airport", "drive", "uber", "trip", "travel", "commute", "train"],
    "SLEEP": ["sleep", "nap", "bedtime", "rest"],
}


def _infer_l0(text: str) -> str:
    lower = text.lower()
    for l0, kws in _L0_KEYWORDS.items():
        if any(kw in lower for kw in kws):
            return l0
    return "UNKNOWN"


def _infer_commitment(text: str) -> bool:
    lower = text.lower()
    return any(re.search(pat, lower) for pat in _COMMITMENT_PATTERNS)


def _infer_urgency(text: str) -> int:
    lower = text.lower()
    if any(re.search(pat, lower) for pat in _URGENCY_HIGH_PATTERNS):
        return 2
    if _infer_commitment(text):
        return 1
    return 0


def _infer_privacy(text: str) -> int:
    lower = text.lower()
    if any(kw in lower for kw in ["password", "secret", "ssn", "credit card", "private key"]):
        return 2
    if any(kw in lower for kw in ["call me", "phone", "email", "address", "doctor", "dentist"]):
        return 1
    return 0


@dataclass
class PersonaDatasetAuditResult:
    total_items: int = 0
    chat_messages: int = 0
    tasks: int = 0
    saved_places: int = 0
    commitments_detected: int = 0
    sources_scanned: List[str] = field(default_factory=list)


class PersonaDataExtractor:
    """
    Extracts structured and semi-structured personal records into
    calibrated Unsloth decision items.
    """

    def __init__(self, export_dir: str | Path):
        self.export_dir = Path(export_dir)

    def audit(self) -> PersonaDatasetAuditResult:
        """Scan and count available records without heavy parsing."""
        result = PersonaDatasetAuditResult()
        
        # 1. Chat impostor files
        chat_pattern = str(self.export_dir / "_test-staging" / "impostors" / "chat" / "Groups" / "*" / "messages.json")
        chat_files = glob.glob(chat_pattern)
        if chat_files:
            result.sources_scanned.append("chat_impostors")
            for cf in chat_files:
                try:
                    with open(cf, "r", encoding="utf-8") as f:
                        data = json.load(f)
                        result.chat_messages += len(data.get("messages", []))
                except Exception:
                    pass

        # 2. Takeout smoke zip
        takeout_zip = self.export_dir / "_test-staging" / "takeout-smoke.zip"
        if takeout_zip.exists():
            result.sources_scanned.append("google_takeout_zip")
            try:
                with zipfile.ZipFile(takeout_zip, "r") as z:
                    names = z.namelist()
                    if "Takeout/Tasks/Tasks.json" in names:
                        raw = json.loads(z.read("Takeout/Tasks/Tasks.json").decode("utf-8"))
                        for tl in raw.get("items", []):
                            result.tasks += len(tl.get("items", []))
                    for name in names:
                        if name.startswith("Takeout/Saved/") and name.endswith(".csv"):
                            lines = z.read(name).decode("utf-8", errors="ignore").splitlines()
                            result.saved_places += max(0, len(lines) - 1)
            except Exception:
                pass

        result.total_items = result.chat_messages + result.tasks + result.saved_places
        return result

    def extract_decision_items(self) -> List[UnslothDecisionItem]:
        """Extract and calibrate all items into UnslothDecisionItems."""
        items: List[UnslothDecisionItem] = []

        # 1. Chat messages
        chat_pattern = str(self.export_dir / "_test-staging" / "impostors" / "chat" / "Groups" / "*" / "messages.json")
        for cf in glob.glob(chat_pattern):
            try:
                with open(cf, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    for msg in data.get("messages", []):
                        text = (msg.get("text") or "").strip()
                        if len(text) < 4:
                            continue
                        creator = msg.get("creator", {}).get("name", "Contact")
                        state = f"{creator}: {text}"
                        is_comm = _infer_commitment(text)
                        urgency = _infer_urgency(text)
                        privacy = _infer_privacy(text)
                        l0 = _infer_l0(text)
                        intent = "store_task" if is_comm else ("store_fact" if len(text) > 40 else "conversational")
                        
                        items.append(
                            UnslothDecisionItem(
                                state=state,
                                questions=PERSONA_DECISION_QUESTIONS,
                                answers={
                                    "intent": intent,
                                    "is_commitment": is_comm,
                                    "urgency": urgency,
                                    "privacy_level": privacy,
                                    "l0_class": l0,
                                },
                            )
                        )
            except Exception as e:
                log.warning("Could not parse chat file %s: %s", cf, e)

        # 2. Google Tasks
        takeout_zip = self.export_dir / "_test-staging" / "takeout-smoke.zip"
        if takeout_zip.exists():
            try:
                with zipfile.ZipFile(takeout_zip, "r") as z:
                    if "Takeout/Tasks/Tasks.json" in z.namelist():
                        raw = json.loads(z.read("Takeout/Tasks/Tasks.json").decode("utf-8"))
                        for tl in raw.get("items", []):
                            list_title = tl.get("title", "Tasks")
                            for task in tl.get("items", []):
                                title = (task.get("title") or "").strip()
                                if not title:
                                    continue
                                notes = (task.get("notes") or "").strip()
                                state = f"Task [{list_title}]: {title}. {notes}".strip()
                                l0 = _infer_l0(title + " " + notes)
                                if l0 == "UNKNOWN":
                                    l0 = "ERRAND"
                                
                                items.append(
                                    UnslothDecisionItem(
                                        state=state,
                                        questions=PERSONA_DECISION_QUESTIONS,
                                        answers={
                                            "intent": "store_task",
                                            "is_commitment": True,
                                            "urgency": 1,
                                            "privacy_level": 1,
                                            "l0_class": l0,
                                        },
                                    )
                                )

                    # 3. Saved Places
                    for name in z.namelist():
                        if name.startswith("Takeout/Saved/") and name.endswith(".csv"):
                            list_name = Path(name).stem
                            content = z.read(name).decode("utf-8", errors="ignore")
                            reader = csv.reader(io.StringIO(content))
                            header = next(reader, None)
                            for row in reader:
                                if row and row[0].strip():
                                    place_name = row[0].strip()
                                    state = f"Saved place in {list_name}: {place_name}"
                                    items.append(
                                        UnslothDecisionItem(
                                            state=state,
                                            questions=PERSONA_DECISION_QUESTIONS,
                                            answers={
                                                "intent": "store_fact",
                                                "is_commitment": False,
                                                "urgency": 0,
                                                "privacy_level": 0,
                                                "l0_class": "LEISURE",
                                            },
                                        )
                                    )
            except Exception as e:
                log.warning("Could not parse takeout zip: %s", e)

        return items

    def create_train_eval_splits(
        self, eval_ratio: float = 0.20, seed: int = 42
    ) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        """Split extracted decision items into train and eval dictionaries."""
        import random

        items = self.extract_decision_items()
        if not items:
            return [], []

        rng = random.Random(seed)
        shuffled = list(items)
        rng.shuffle(shuffled)

        split_idx = int(len(shuffled) * (1.0 - eval_ratio))
        train_items = [item.to_dict() for item in shuffled[:split_idx]]
        eval_items = [item.to_dict() for item in shuffled[split_idx:]]

        return train_items, eval_items


def train_persona_decision_model(
    export_dir: str | Path,
    output_dir: str | Path,
    base_model_name: str = "Convai/Laya-320M",
    epochs: int = 1,
    lora_r: int = 16,
) -> Dict[str, Any]:
    """
    End-to-end pipeline: extracts persona dataset, executes Unsloth decision trainer,
    and returns evaluation metrics and metadata.
    """
    extractor = PersonaDataExtractor(export_dir)
    train_data, eval_data = extractor.create_train_eval_splits()

    if not train_data:
        raise ValueError(f"No valid persona decision records extracted from {export_dir}")

    config = UnslothDecisionTrainConfig(
        base_model_name=base_model_name,
        lora_r=lora_r,
        epochs=epochs,
    )
    trainer = UnslothDecisionTrainer(config)
    meta = trainer.train_and_export(train_data, eval_data, output_dir)

    meta["persona_source"] = str(export_dir)
    meta["record_counts"] = {
        "train": len(train_data),
        "eval": len(eval_data),
        "total": len(train_data) + len(eval_data),
    }

    # Write enhanced metadata
    meta_path = Path(output_dir) / "persona_decision_meta.json"
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    return meta
