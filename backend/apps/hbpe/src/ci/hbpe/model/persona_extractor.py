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
import unicodedata
import zipfile
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ci.hbpe.model.redaction import Redactor, content_words
from ci.hbpe.model.unsloth_decision_trainer import (
    DecisionDatasetItem,
    UnslothDecisionTrainConfig,
    UnslothDecisionTrainer,
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

PERSONA_DECISION_QUESTIONS: dict[str, dict[str, Any]] = {
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

_L0_KEYWORDS: dict[str, list[str]] = {
    "WORK": [
        "sprint",
        "meeting",
        "roadmap",
        "engineering",
        "project",
        "sync",
        "code",
        "review",
        "smoke signal",
        "pr",
        "bug",
        "deploy",
    ],
    "EXERCISE": [
        "gym",
        "run",
        "workout",
        "fitness",
        "cycling",
        "swim",
        "training",
        "exercise",
        "walk",
    ],
    "SOCIAL": [
        "party",
        "dinner",
        "drinks",
        "hangout",
        "lunch with",
        "coffee",
        "meet up",
        "birthday",
        "celebrate",
    ],
    "ERRAND": [
        "apartment",
        "shopping",
        "dentist",
        "doctor",
        "kiva",
        "bank",
        "buy",
        "store",
        "groceries",
        "chores",
    ],
    "LEISURE": [
        "movie",
        "game",
        "gaming",
        "music",
        "concert",
        "read",
        "book",
        "relax",
        "show",
        "nyc",
        "night",
    ],
    "TRANSIT": [
        "flight",
        "airport",
        "drive",
        "uber",
        "trip",
        "travel",
        "commute",
        "train",
    ],
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
    if any(
        kw in lower
        for kw in ["password", "secret", "ssn", "credit card", "private key"]
    ):
        return 2
    if any(
        kw in lower
        for kw in ["call me", "phone", "email", "address", "doctor", "dentist"]
    ):
        return 1
    return 0


# The label written for a chat sender, and the label for a message with no sender name.
# The redactor writes the name placeholder in the same form.
_NAME_PLACEHOLDER = "[NAME]"
_NO_NAME_LABEL = "Contact"
_WORD_RE = re.compile(r"\w+")
_NAME_PART_RE = re.compile(r"[\s,\-]+")
# A single word is ambiguous when the chat uses it in lower case at least twice, and for at
# least this share of its uses. See _name_policy.
_AMBIGUOUS_SHARE = 0.05
# A chat capital followed by one of these is a name, even at the start of a sentence.
_NAME_FOLLOWERS = (",", "'", "’", ":")


def _normalised(text: str) -> str:
    """The NFKC form of ``text`` with runs of whitespace collapsed, as a name is read."""
    return " ".join(unicodedata.normalize("NFKC", text).split())


def _unaccented(text: str) -> str:
    """``text`` with its accents removed, so that Jose matches José."""
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def _title_case(word: str) -> str:
    return word[:1].upper() + word[1:].lower()


def _sender_name(msg: Any) -> str:
    """The normalised sender name of a chat message, or "" when it has none."""
    creator = msg.get("creator")
    name = creator.get("name") if isinstance(creator, dict) else None
    return "" if name is None else _normalised(str(name))


def _sender_forms(name: str) -> list[str]:
    """Every spelling and word of a sender's name that the redactor should look for.

    The name is taken as written, without accents, and word by word. Words are split on
    spaces, hyphens and commas. A name whose display name is an e-mail address also gives
    the words of the address's local part.
    """
    spellings = [name, _normalised(_unaccented(name))]
    if "@" in name:
        spellings.append(_normalised(re.sub(r"\W+", " ", name.split("@", 1)[0])))
    forms: dict[str, None] = {}
    for spelling in spellings:
        forms[spelling] = None
        forms.update(dict.fromkeys(_NAME_PART_RE.split(spelling)))
    return [form for form in forms if len(form) >= 2]


def _is_single_word(form: str) -> bool:
    return _WORD_RE.fullmatch(form) is not None


def _name_policy(names: list[str], texts: Iterable[str]) -> tuple[list[str], list[str]]:
    """Split the sender names into the forms to deny and the words to mask.

    A form with a space, a hyphen or another mark is denied wherever it occurs. A single
    word is ambiguous when the chat also uses it as an ordinary word in lower case, at least
    twice and for at least a twentieth of its uses. Denying an ambiguous word would damage
    that text: a sender called Will would turn "I will" into "I [NAME]". An ambiguous word is
    masked only where it is capitalised, see _mask_capitalised_names. Any other single word
    is denied wherever it occurs.
    """
    counts: Counter[str] = Counter()
    for text in texts:
        counts.update(_WORD_RE.findall(text))
    deny: dict[str, None] = {}
    masked: dict[str, None] = {}
    for name in names:
        for form in _sender_forms(name):
            if not _is_single_word(form):
                deny[form] = None
                continue
            lower = counts[form.lower()]
            capital = counts[_title_case(form)]
            if lower >= 2 and lower >= _AMBIGUOUS_SHARE * (lower + capital):
                masked[_title_case(form)] = None
            else:
                deny[form] = None
    return list(deny), list(masked)


def _mask_pattern(words: list[str]) -> re.Pattern[str] | None:
    """One pattern for the capitalised uses of the masked words, longest first."""
    if not words:
        return None
    ordered = sorted(words, key=len, reverse=True)
    return re.compile(
        r"(?<!\w)(?:" + "|".join(re.escape(word) for word in ordered) + r")(?!\w)"
    )


def _mask_capitalised_names(
    text: str, pattern: re.Pattern[str] | None, *, chat: bool
) -> str:
    """Replace the capitalised uses of masked names with the name placeholder.

    In chat, a capital that starts a sentence says nothing about a name, so it is kept,
    unless one of _NAME_FOLLOWERS comes straight after it, as in "Will, are you coming?".
    Other text, such as task titles and place names, has no such exception.
    """
    if pattern is None:
        return text

    def replace(match: re.Match[str]) -> str:
        if chat:
            before = text[: match.start()]
            stripped = before.rstrip()
            starts_sentence = (
                not stripped or stripped[-1] in ".!?" or "\n" in before[len(stripped) :]
            )
            follower = text[match.end() : match.end() + 1]
            if starts_sentence and follower not in _NAME_FOLLOWERS:
                return match.group(0)
        return _NAME_PLACEHOLDER

    return pattern.sub(replace, text)


@dataclass
class PersonaDatasetAuditResult:
    total_items: int = 0
    chat_messages: int = 0
    tasks: int = 0
    saved_places: int = 0
    commitments_detected: int = 0
    sources_scanned: list[str] = field(default_factory=list)


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
        chat_pattern = str(
            self.export_dir
            / "_test-staging"
            / "impostors"
            / "chat"
            / "Groups"
            / "*"
            / "messages.json"
        )
        chat_files = glob.glob(chat_pattern)
        if chat_files:
            result.sources_scanned.append("chat_impostors")
            for cf in chat_files:
                try:
                    with open(cf, encoding="utf-8") as f:
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
                        raw = json.loads(
                            z.read("Takeout/Tasks/Tasks.json").decode("utf-8")
                        )
                        for tl in raw.get("items", []):
                            result.tasks += len(tl.get("items", []))
                    for name in names:
                        if name.startswith("Takeout/Saved/") and name.endswith(".csv"):
                            lines = (
                                z.read(name)
                                .decode("utf-8", errors="ignore")
                                .splitlines()
                            )
                            result.saved_places += max(0, len(lines) - 1)
            except Exception:
                pass

        result.total_items = result.chat_messages + result.tasks + result.saved_places
        return result

    def extract_decision_items(self) -> list[UnslothDecisionItem]:
        """Extract and calibrate all items into UnslothDecisionItems.

        Free text is redacted before it reaches an item's ``state``: chat message text,
        Google Tasks titles, notes and list titles, and saved place and list names. A chat
        sender is written as ``[NAME]``. Every sender's name is denied in all of that text,
        including the name of a sender whose messages are too short to become items.

        Two exceptions keep ordinary text intact, and both depend on the export. A single
        word that the chat also uses as a lower-case word is masked only where it is
        capitalised (see ``_name_policy``). In chat, a capital that starts a sentence is kept,
        unless a comma, an apostrophe or a colon follows it. Names that no sender supplies
        are not known here, so only the redactor's pattern rules apply to them, and the
        redactor's documented gaps still apply, such as a name directly after a dot.
        """
        items: list[UnslothDecisionItem] = []

        # 1. Chat messages. Every sender is read before the length filter, so that a sender
        #    whose messages are all short still has their name denied in the other text.
        chat_pattern = str(
            self.export_dir
            / "_test-staging"
            / "impostors"
            / "chat"
            / "Groups"
            / "*"
            / "messages.json"
        )
        chat_records: list[tuple[str, str]] = []
        sender_names: dict[str, None] = {}
        for cf in glob.glob(chat_pattern):
            try:
                with open(cf, encoding="utf-8") as f:
                    data = json.load(f)
                    for msg in data.get("messages", []):
                        speaker = _sender_name(msg)
                        if speaker:
                            sender_names[speaker] = None
                        text = (msg.get("text") or "").strip()
                        if len(text) >= 4:
                            chat_records.append((speaker, text))
            except Exception as e:
                log.warning("Could not parse chat file %s: %s", cf, e)

        deny, masked = _name_policy(
            sorted(sender_names), (text for _, text in chat_records)
        )
        if masked:
            log.info(
                "%d sender names are masked only where capitalised, because the chat "
                "uses the same word in lower case",
                len(masked),
            )
        redactor = Redactor(deny_names=deny)
        mask_pattern = _mask_pattern(masked)

        def redact(text: str, *, chat: bool = False) -> str:
            masked_text = _mask_capitalised_names(text, mask_pattern, chat=chat)
            return redactor.redact(masked_text)[0]

        for speaker, text in chat_records:
            text_out = redact(text, chat=True)
            is_comm = _infer_commitment(text)
            urgency = _infer_urgency(text)
            privacy = _infer_privacy(text)
            l0 = _infer_l0(text)
            intent = (
                "store_task"
                if is_comm
                else ("store_fact" if len(text) > 40 else "conversational")
            )
            label = _NAME_PLACEHOLDER if speaker else _NO_NAME_LABEL

            items.append(
                UnslothDecisionItem(
                    state=f"{label}: {text_out}",
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

        # 2. Google Tasks and saved places. The same redaction applies to every field.
        takeout_zip = self.export_dir / "_test-staging" / "takeout-smoke.zip"
        if takeout_zip.exists():
            try:
                with zipfile.ZipFile(takeout_zip, "r") as z:
                    if "Takeout/Tasks/Tasks.json" in z.namelist():
                        raw = json.loads(
                            z.read("Takeout/Tasks/Tasks.json").decode("utf-8")
                        )
                        for tl in raw.get("items", []):
                            list_title = redact(str(tl.get("title", "Tasks")))
                            for task in tl.get("items", []):
                                title = (task.get("title") or "").strip()
                                if not title:
                                    continue
                                notes = (task.get("notes") or "").strip()
                                title_out = redact(title)
                                notes_out = redact(notes)
                                state = (
                                    f"Task [{list_title}]: {title_out}. {notes_out}"
                                ).strip()
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
                            list_name = redact(Path(name).stem)
                            content = z.read(name).decode("utf-8", errors="ignore")
                            reader = csv.reader(io.StringIO(content))
                            next(reader, None)  # skip the CSV header row
                            for row in reader:
                                if row and row[0].strip():
                                    place_name = redact(row[0].strip())
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
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
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
) -> dict[str, Any]:
    """
    End-to-end pipeline: extracts persona dataset, executes Unsloth decision trainer,
    and returns evaluation metrics and metadata.
    """
    extractor = PersonaDataExtractor(export_dir)
    train_data, eval_data = extractor.create_train_eval_splits()

    if not train_data:
        raise ValueError(
            f"No valid persona decision records extracted from {export_dir}"
        )

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


# Tone adapter examples. These are built from the user's own sent messages, and every
# field goes through a Redactor (ci.hbpe.model.redaction) before it is emitted. The
# trainer is not here: it needs a GPU and a reviewed dataset. The builder is off unless
# HBPE_TONE_EXAMPLES_ENABLED is set, so nothing changes by default.

TONE_EXAMPLES_FLAG = "HBPE_TONE_EXAMPLES_ENABLED"
TONE_DROP_REASONS: tuple[str, ...] = ("empty", "too_short")
TONE_DISABLED_REASON = "disabled"


def tone_examples_enabled() -> bool:
    """True when HBPE_TONE_EXAMPLES_ENABLED is 1, true, yes or on. Off when unset."""
    value = os.getenv(TONE_EXAMPLES_FLAG, "")
    return value.strip().lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class ToneMessage:
    """One message from an export. ``sent_by_user`` marks the user's own messages."""

    text: str
    sent_by_user: bool
    thread_id: str | None = None


@dataclass(frozen=True)
class ToneExample:
    """One example in the user's voice. ``context`` is None for single-message ones."""

    reply: str
    context: str | None = None


def build_tone_examples(
    messages: Iterable[ToneMessage],
    redactor: Redactor,
    *,
    min_words: int = 8,
) -> tuple[list[ToneExample], dict[str, int]]:
    """
    Turn the user's sent messages into redacted tone examples.

    ``messages`` must be in the order they were sent. A user message whose immediate
    predecessor in the same thread is inbound becomes a context-reply pair. Messages
    with no thread id neither give nor receive context. Any other user message becomes
    a single-message example.

    Every emitted field, context and reply alike, goes through ``redactor`` first, and
    the length check applies to the redacted reply. Placeholders such as ``[NAME]`` count
    as words, but a reply with no word other than placeholders is too short, so a reply
    made only of placeholders is never emitted. Returns the examples and a count of
    dropped user messages by reason: ``empty`` (nothing left after redaction),
    ``too_short`` (fewer than ``min_words`` words, or only placeholders), and ``disabled``
    (only while the flag is off). All three keys are always present. Inbound messages
    only supply context, so they are never counted as dropped.

    While HBPE_TONE_EXAMPLES_ENABLED is off, returns no examples, counts every user
    message under ``disabled``, and never calls ``redactor``.
    """
    if min_words < 1:
        raise ValueError("min_words must be at least 1")
    dropped = dict.fromkeys((*TONE_DROP_REASONS, TONE_DISABLED_REASON), 0)
    if not tone_examples_enabled():
        dropped[TONE_DISABLED_REASON] = sum(1 for m in messages if m.sent_by_user)
        return [], dropped
    examples: list[ToneExample] = []
    last_in_thread: dict[str, ToneMessage] = {}
    for message in messages:
        prior: ToneMessage | None = None
        if message.thread_id is not None:
            prior = last_in_thread.get(message.thread_id)
            last_in_thread[message.thread_id] = message
        if not message.sent_by_user:
            continue
        reply, _ = redactor.redact(message.text)
        context: str | None = None
        if prior is not None and not prior.sent_by_user:
            context_text, _ = redactor.redact(prior.text)
            if context_text.strip():
                context = context_text
        if not reply.strip():
            dropped["empty"] += 1
        elif len(reply.split()) < min_words or not content_words(reply):
            dropped["too_short"] += 1
        else:
            examples.append(ToneExample(reply=reply, context=context))
    return examples, dropped
