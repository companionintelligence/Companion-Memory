"""
STEP 1 — Qwen labeler smoke test (no DB required).

Loads Qwen/Qwen3.5-0.8B (downloads on first run, ~1.5 GB) and verifies
that it produces valid L0 labels for a set of known calendar events.

Run from backend/apps/hbpe/:
    PYTHONPATH=src python scripts/test_step1_l0.py
"""
import sys

print("── Step 1: Qwen Labeler ─────────────────────────────────")

# ── 1. Test prompt / JSON helpers first (no model needed) ─────────────────────
from ci.tokenizer.vocab_registry import L0_CLASSES, normalise_l0
from ci.tokenizer import qwen_labeler as ql

print("\n[1/3] Testing prompt builders and JSON parser ...")

assert normalise_l0("work") == "WORK"
assert normalise_l0("UNKNOWN") == "UNKNOWN"
assert normalise_l0("nonsense") == "UNKNOWN"
assert ql._clean_label("  Engineering Meetings  ") == "Engineering Meetings"
assert ql._clean_label('"Sprint Planning"') == "Sprint Planning"

# Parse JSON from a full model response (instruct model outputs the whole object)
raw1 = '{"l0": "WORK", "l1": "Engineering Meetings"}'
assert ql._parse_json(raw1) == {"l0": "WORK", "l1": "Engineering Meetings"}, \
    f"Parse failed: {ql._parse_json(raw1)}"

# Handle preamble before the JSON (model sometimes adds a sentence first)
raw2 = 'Sure, here is the result:\n{"l0": "EXERCISE", "l1": "Morning Run", "l2": "Cardio Training"}'
parsed2 = ql._parse_json(raw2)
assert parsed2["l0"] == "EXERCISE", f"Expected EXERCISE, got {parsed2}"
assert parsed2["l2"] == "Cardio Training"

print("      Prompt helpers: PASS")

# ── 2. Load Qwen model ─────────────────────────────────────────────────────────
print("\n[2/3] Loading Qwen model (downloads on first run) ...")
from ci.inference.qwen import get_qwen
model = get_qwen()
print(f"      Loaded: {model.model_name}")
print(f"      Device: {next(model.model.parameters()).device}")

# ── 3. Label a sample of events and check L0 plausibility ─────────────────────
print("\n[3/3] Running label generation on known events ...")

all_l1_empty = {l0: [] for l0 in L0_CLASSES}

cases = [
    ("Weekly team standup",  "WORK"),
    ("Morning run - 5k",     "EXERCISE"),
    ("Dentist appointment",  "ERRAND"),
    ("Dinner with friends",  "SOCIAL"),
    ("Flight to NYC",        "TRANSIT"),
    ("Deep work block",      "WORK"),
]

passed = 0
for i, (title, expected_l0) in enumerate(cases):
    print(f"  [{i+1}/{len(cases)}] {title!r} ...", end="", flush=True)
    user_msg = ql._build_event_user_message(title, None, all_l1_empty)
    raw = model.generate(user_msg, system_message=ql._SYSTEM, max_new_tokens=60)
    parsed = ql._parse_json(raw)
    got_l0 = normalise_l0(parsed.get("l0", ""))
    got_l1 = ql._clean_label(parsed.get("l1", ""))
    ok = got_l0 == expected_l0
    passed += ok
    mark = "✓" if ok else "✗"
    print(f"  {mark}  L0={got_l0}  L1={got_l1!r}")

print(f"\n{passed}/{len(cases)} L0 labels correct")

if passed < len(cases) * 0.7:   # allow 30% tolerance (LLM is non-deterministic)
    print("FAIL — too many incorrect L0 labels (expected ≥70% accuracy)")
    sys.exit(1)

print("PASS — Qwen model loaded and labeling correctly")
