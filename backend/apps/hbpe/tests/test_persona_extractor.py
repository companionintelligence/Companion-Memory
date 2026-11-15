"""
Unit tests for PersonaDataExtractor and persona decision model training.
"""

from __future__ import annotations

import json
import os
import tempfile
from collections.abc import Iterable
from pathlib import Path

try:
    import pytest

    has_pytest = True
except ImportError:
    has_pytest = False
    pytest = None

from ci.hbpe.model.persona_extractor import (
    TONE_EXAMPLES_FLAG,
    PersonaDataExtractor,
    ToneExample,
    ToneMessage,
    _infer_commitment,
    _infer_l0,
    _infer_urgency,
    build_tone_examples,
    tone_examples_enabled,
    train_persona_decision_model,
)
from ci.hbpe.model.redaction import Redactor

# The real-data tests read a personal export, so they run only when
# HBPE_PERSONA_EXPORT_DIR points at one. Without it they skip, and the suite
# never reads personal data by default.
PERSONAL_EXPORT_DIR = os.environ.get("HBPE_PERSONA_EXPORT_DIR", "")


def skip_without_export(fn):
    if not PERSONAL_EXPORT_DIR or not Path(PERSONAL_EXPORT_DIR).exists():
        if has_pytest:
            return pytest.mark.skip(
                reason="Set HBPE_PERSONA_EXPORT_DIR to run tests against a persona export"
            )(fn)
        return lambda *args, **kwargs: None
    return fn


def test_keyword_heuristics():
    assert (
        _infer_commitment("Hey man I'm gonna be in DC this week, let's meet!") is True
    )
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
        # The pipeline passes no trained predictor, so there is no model to score.
        # The export reports no candidate metrics and the gate fails on that alone.
        assert meta["prediction_source"] == "none"
        assert meta["eval_metrics"]["top1_accuracy"] is None
        assert meta["eval_metrics"]["brier_score"] is None
        assert meta["eval_metrics"]["expected_calibration_error"] is None
        assert meta["gate"]["passed"] is False
        assert meta["gate"]["reasons"] == ["no trained model"]

        meta_file = Path(tmpdir) / "persona_decision_meta.json"
        assert meta_file.exists()
        loaded = json.loads(meta_file.read_text())
        assert loaded["record_counts"]["total"] == meta["record_counts"]["total"]


# Tone adapter examples: the builder, and the redaction it must always apply.

if has_pytest:

    @pytest.fixture(autouse=True)
    def _tone_examples_flag_on(monkeypatch: pytest.MonkeyPatch) -> None:
        """The builder is off by default, so the tests in this module switch it on."""
        monkeypatch.setenv(TONE_EXAMPLES_FLAG, "1")


class _RecordingRedactor(Redactor):
    """Redactor that remembers every text it was asked to redact."""

    def __init__(self, deny_names: Iterable[str] = ()) -> None:
        super().__init__(deny_names=deny_names)
        self.seen: list[str] = []

    def redact(self, text: str) -> tuple[str, dict[str, int]]:
        self.seen.append(text)
        return super().redact(text)


def test_tone_examples_pair_reply_with_inbound_context():
    messages = [
        ToneMessage(
            "Are you free for lunch on Thursday to talk about the launch?",
            sent_by_user=False,
            thread_id="t1",
        ),
        ToneMessage(
            "Yes I can do Thursday at noon, does that work for you both?",
            sent_by_user=True,
            thread_id="t1",
        ),
    ]
    examples, dropped = build_tone_examples(messages, Redactor())

    assert examples == [
        ToneExample(
            reply="Yes I can do Thursday at noon, does that work for you both?",
            context="Are you free for lunch on Thursday to talk about the launch?",
        )
    ]
    assert dropped == {"empty": 0, "too_short": 0, "disabled": 0}


def test_tone_examples_use_single_message_when_no_inbound_context():
    messages = [
        ToneMessage(
            "Sounds good to me, I will bring the slides on Friday morning",
            sent_by_user=True,
        ),
        ToneMessage(
            "Inbound message in the thread used for the reply test case",
            sent_by_user=False,
            thread_id="t2",
        ),
        ToneMessage(
            "Yes that works fine for me, see you on Friday at nine",
            sent_by_user=True,
            thread_id="t2",
        ),
        ToneMessage(
            "Following up with the agenda for the meeting we discussed earlier",
            sent_by_user=True,
            thread_id="t2",
        ),
    ]
    examples, dropped = build_tone_examples(messages, Redactor())

    assert [example.context for example in examples] == [
        None,
        "Inbound message in the thread used for the reply test case",
        None,
    ]
    # Inbound messages only supply context, so none of them is emitted as a reply.
    assert all("Inbound message" not in example.reply for example in examples)
    assert dropped == {"empty": 0, "too_short": 0, "disabled": 0}


def test_tone_examples_redact_every_field():
    redactor = _RecordingRedactor(deny_names=["Sarah"])
    inbound = (
        "Sarah here, my card is 4111 1111 1111 1111 so please book the table for Friday"
    )
    reply = (
        "Sure Sarah, I will email sarah@example.com with the table details by tonight"
    )
    messages = [
        ToneMessage(inbound, sent_by_user=False, thread_id="t"),
        ToneMessage(reply, sent_by_user=True, thread_id="t"),
    ]
    examples, dropped = build_tone_examples(messages, redactor)

    # Both the context and the reply reached the redactor, unredacted.
    assert inbound in redactor.seen
    assert reply in redactor.seen
    assert examples == [
        ToneExample(
            reply="Sure [NAME], I will email [EMAIL] with the table details by tonight",
            context="[NAME] here, my card is [CARD] so please book the table for Friday",
        )
    ]
    assert dropped == {"empty": 0, "too_short": 0, "disabled": 0}


def test_tone_examples_count_drop_reasons():
    messages = [
        ToneMessage("", sent_by_user=True),
        ToneMessage("   \n  ", sent_by_user=True),
        ToneMessage("", sent_by_user=False),  # inbound: context only, not counted
        ToneMessage("ok thanks mate", sent_by_user=True),
        ToneMessage("Sounds good, see you at the station", sent_by_user=True),
        ToneMessage("sarah@example.com", sent_by_user=True),  # redacts to one word
        ToneMessage("Sounds good, see you at the station on Friday", sent_by_user=True),
    ]
    examples, dropped = build_tone_examples(messages, Redactor())

    assert [example.reply for example in examples] == [
        "Sounds good, see you at the station on Friday"
    ]
    assert dropped == {"empty": 2, "too_short": 3, "disabled": 0}


def test_tone_examples_min_words_is_configurable():
    messages = [ToneMessage("Yes, that works for me", sent_by_user=True)]

    examples, dropped = build_tone_examples(messages, Redactor())
    assert examples == []
    assert dropped == {"empty": 0, "too_short": 1, "disabled": 0}

    examples, dropped = build_tone_examples(messages, Redactor(), min_words=5)
    assert examples == [ToneExample(reply="Yes, that works for me")]
    assert dropped == {"empty": 0, "too_short": 0, "disabled": 0}

    with pytest.raises(ValueError, match="min_words must be at least 1"):
        build_tone_examples(messages, Redactor(), min_words=0)


def test_tone_examples_never_leave_a_redacted_category_behind():
    redactor = Redactor(deny_names=["Sarah"])
    messages = [
        ToneMessage(
            "Sarah, call me on +44 20 7946 0958 or mail sarah@example.com about the flat",
            sent_by_user=False,
            thread_id="t",
        ),
        ToneMessage(
            "Thanks Sarah, my card 4111 1111 1111 1111 and IBAN GB82 WEST 1234 5698 "
            "7654 32 are at 10 Downing Street, see https://shop.example.com/a?session=xyz",
            sent_by_user=True,
            thread_id="t",
        ),
        ToneMessage(
            "Booking details are in the usual place, see "
            "https://pay.example.com/c?token=9f8e7d6c5b4a",
            sent_by_user=True,
        ),
    ]
    examples, dropped = build_tone_examples(messages, redactor)

    assert examples == [
        ToneExample(
            reply=(
                "Thanks [NAME], my card [CARD] and IBAN [IBAN] are at [ADDRESS], "
                "see https://shop.example.com/a"
            ),
            context="[NAME], call me on [PHONE] or mail [EMAIL] about the flat",
        ),
        ToneExample(
            reply="Booking details are in the usual place, see https://pay.example.com/c"
        ),
    ]
    assert dropped == {"empty": 0, "too_short": 0, "disabled": 0}
    shown = " ".join(
        part for example in examples for part in (example.reply, example.context or "")
    )
    # Each raw value below was in the messages. None may survive in any emitted field.
    for raw in (
        "sarah@example.com",
        "+44 20 7946 0958",
        "4111 1111 1111 1111",
        "GB82 WEST",
        "10 Downing Street",
        "Sarah",
        "token=9f8e7d6c5b4a",
        "session=xyz",
    ):
        assert raw not in shown
    assert "[EMAIL]" in shown and "[CARD]" in shown and "[NAME]" in shown


class _BlankingRedactor(Redactor):
    """Redactor that empties every text, to test the count of empty replies."""

    def redact(self, text: str) -> tuple[str, dict[str, int]]:
        return "", {"name": 1}


def test_too_short_is_measured_on_the_redacted_reply():
    # The raw reply has 11 words. Redacted, it reads "Ping me on [CARD] at [ADDRESS]",
    # six words, so under the minimum of eight it must be dropped.
    reply = "Ping me on 4111 1111 1111 1111 at 10 Downing Street"
    assert len(reply.split()) >= 8
    examples, dropped = build_tone_examples(
        [ToneMessage(reply, sent_by_user=True)], Redactor()
    )

    assert examples == []
    assert dropped == {"empty": 0, "too_short": 1, "disabled": 0}


def test_a_reply_of_placeholders_alone_is_too_short():
    # Eight placeholders are eight words, so the length check alone would keep this. Only
    # the rule that a reply needs a word that is not a placeholder drops it.
    reply = (
        "sarah@example.com sarah@example.org sarah@example.net 07700 900123 07700 900124 "
        "4111 1111 1111 1111 4111 1111 1111 1111 GB82 WEST 1234 5698 7654 32"
    )
    examples, dropped = build_tone_examples(
        [ToneMessage(reply, sent_by_user=True)], Redactor()
    )

    assert examples == []
    assert dropped == {"empty": 0, "too_short": 1, "disabled": 0}


def test_a_mixed_reply_counts_its_placeholders_as_words():
    # Redacted, this reads "Sure, [NAME] will send [EMAIL] and [PHONE] tomorrow", eight
    # words counting the placeholders, so it is kept.
    reply = "Sure, Sarah will send sarah@example.com and 07700 900123 tomorrow"
    examples, dropped = build_tone_examples(
        [ToneMessage(reply, sent_by_user=True)], Redactor(deny_names=["Sarah"])
    )

    assert examples == [
        ToneExample(reply="Sure, [NAME] will send [EMAIL] and [PHONE] tomorrow")
    ]
    assert dropped == {"empty": 0, "too_short": 0, "disabled": 0}


def test_disabled_and_enabled_return_the_same_keys(monkeypatch):
    messages = [
        ToneMessage(
            "Please send the report to the team by Friday, thanks a lot",
            sent_by_user=True,
        )
    ]
    _, enabled = build_tone_examples(messages, Redactor())
    monkeypatch.setenv(TONE_EXAMPLES_FLAG, "0")
    _, disabled = build_tone_examples(messages, Redactor())

    assert set(enabled) == set(disabled) == {"empty", "too_short", "disabled"}
    assert disabled == {"empty": 0, "too_short": 0, "disabled": 1}


def test_empty_is_measured_on_the_redacted_reply():
    # The raw reply is long, so only the redacted text can make it empty.
    reply = "Sounds good to me, I will bring the slides on Friday morning"
    examples, dropped = build_tone_examples(
        [ToneMessage(reply, sent_by_user=True)], _BlankingRedactor()
    )

    assert examples == []
    assert dropped == {"empty": 1, "too_short": 0, "disabled": 0}


def test_messages_without_thread_id_never_pair():
    reply = "Sounds good to me, I will bring the slides on Friday morning"
    messages = [
        ToneMessage(
            "Inbound message with no thread id, so it cannot be context",
            sent_by_user=False,
        ),
        ToneMessage(reply, sent_by_user=True),
    ]
    examples, dropped = build_tone_examples(messages, Redactor())

    assert examples == [ToneExample(reply=reply)]
    assert dropped == {"empty": 0, "too_short": 0, "disabled": 0}


def test_tone_examples_are_off_unless_the_flag_is_set(monkeypatch):
    monkeypatch.delenv(TONE_EXAMPLES_FLAG, raising=False)
    redactor = _RecordingRedactor()
    messages = [
        ToneMessage(
            "Are you free for lunch on Thursday to talk about the launch?",
            sent_by_user=False,
            thread_id="t",
        ),
        ToneMessage(
            "Yes I can do Thursday at noon, does that work for you both?",
            sent_by_user=True,
            thread_id="t",
        ),
        ToneMessage(
            "Sounds good to me, I will bring the slides on Friday morning",
            sent_by_user=True,
        ),
    ]
    examples, dropped = build_tone_examples(messages, redactor)

    assert examples == []
    assert dropped == {"empty": 0, "too_short": 0, "disabled": 2}
    assert redactor.seen == []


def test_tone_flag_reads_only_true_values(monkeypatch):
    monkeypatch.delenv(TONE_EXAMPLES_FLAG, raising=False)
    assert tone_examples_enabled() is False
    for value, enabled in [
        ("1", True),
        ("true", True),
        ("Yes", True),
        (" on ", True),
        ("0", False),
        ("false", False),
        ("", False),
        ("y", False),
    ]:
        monkeypatch.setenv(TONE_EXAMPLES_FLAG, value)
        assert tone_examples_enabled() is enabled, value


if __name__ == "__main__":
    print("Running test_keyword_heuristics...")
    test_keyword_heuristics()
    print("Running test_persona_extractor_audit_real_data...")
    test_persona_extractor_audit_real_data()
    print("Running test_persona_extractor_splits_real_data...")
    test_persona_extractor_splits_real_data()
    print("Running test_persona_decision_model_training_end_to_end...")
    test_persona_decision_model_training_end_to_end()
    os.environ[TONE_EXAMPLES_FLAG] = "1"  # the tone builder is off by default
    print("Running test_tone_examples_pair_reply_with_inbound_context...")
    test_tone_examples_pair_reply_with_inbound_context()
    print("Running test_tone_examples_use_single_message_when_no_inbound_context...")
    test_tone_examples_use_single_message_when_no_inbound_context()
    print("Running test_tone_examples_redact_every_field...")
    test_tone_examples_redact_every_field()
    print("Running test_tone_examples_count_drop_reasons...")
    test_tone_examples_count_drop_reasons()
    print("Running test_tone_examples_never_leave_a_redacted_category_behind...")
    test_tone_examples_never_leave_a_redacted_category_behind()
    test_too_short_is_measured_on_the_redacted_reply()
    test_empty_is_measured_on_the_redacted_reply()
    test_messages_without_thread_id_never_pair()
    print("All persona extractor tests passed!")


class _BlankInboundRedactor(Redactor):
    """Redactor that blanks inbound text only, so the context redacts to nothing."""

    def redact(self, text: str) -> tuple[str, dict[str, int]]:
        if text.startswith("Are you free"):
            return "", {"name": 1}
        return super().redact(text)


def test_a_blank_inbound_message_leaves_no_context():
    messages = [
        ToneMessage(
            "Are you free on Friday afternoon?", sent_by_user=False, thread_id="t"
        ),
        ToneMessage(
            "Yes I am free on Friday afternoon, see you then for sure",
            sent_by_user=True,
            thread_id="t",
        ),
    ]
    examples, dropped = build_tone_examples(messages, _BlankInboundRedactor())

    assert examples == [
        ToneExample(
            reply="Yes I am free on Friday afternoon, see you then for sure",
            context=None,
        )
    ]
    assert dropped == {"empty": 0, "too_short": 0, "disabled": 0}


def test_an_empty_thread_id_is_a_thread_of_its_own():
    messages = [
        ToneMessage(
            "Are you free on Friday afternoon?", sent_by_user=False, thread_id=""
        ),
        ToneMessage(
            "Yes I am free on Friday afternoon, see you then for sure",
            sent_by_user=True,
            thread_id="",
        ),
    ]
    examples, _ = build_tone_examples(messages, Redactor())

    assert examples == [
        ToneExample(
            reply="Yes I am free on Friday afternoon, see you then for sure",
            context="Are you free on Friday afternoon?",
        )
    ]
