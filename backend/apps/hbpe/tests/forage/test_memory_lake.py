"""Memory-lake spec: user facts, not the Sam Saturday fixture."""

from ci.hbpe.forage.lake import lake_from_spec
from ci.hbpe.forage.trial import ForageTrial
import numpy as np


def _spec():
    return {
        "question": "What happens next",
        "horizon": "7d",
        "branches": ["beach_trip", "office"],
        "people": ["jerry", "solo"],
        "items": [
            {
                "id": "event:1",
                "label": "event: Saturday beach with Jerry",
                "observation": "beach_trip_mention",
                "supports_branches": ["beach_trip"],
                "supports_people": ["jerry"],
                "source": "event",
            },
            {
                "id": "person:jerry-home",
                "label": "person: Jerry — lives near the beach",
                "observation": "place_mention",
                "supports_branches": ["beach_trip"],
                "supports_people": ["jerry"],
                "source": "person",
            },
            {
                "id": "derived:office",
                "label": "derived: weekday office cluster",
                "observation": "office_mention",
                "supports_branches": ["office"],
                "supports_people": [],
                "source": "derived",
            },
        ],
        "branch_prior": {"beach_trip": 0.6, "office": 0.4},
        "interests": [{"branch": "beach_trip", "person": "jerry", "activities": ["surf"]}],
    }


def test_memory_read_is_the_item_not_a_hidden_world():
    model, process_A, items, truth = lake_from_spec(_spec())
    trial = ForageTrial(model=model, process_A=process_A, items=items, truth=truth, rng=np.random.default_rng(0))
    rec = trial.read_item("event:1")
    assert rec.cue == "beach_trip_mention"
    assert trial.model.kind == "memory"
    beach = trial.permutations("beach_trip")
    assert beach["jerry"] > beach["solo"]


def test_ingest_appends_unread_index_hits():
    model, process_A, items, truth = lake_from_spec(_spec())
    trial = ForageTrial(model=model, process_A=process_A, items=items, truth=truth, rng=np.random.default_rng(0))
    added = trial.ingest(
        [
            {
                "id": "place:home",
                "label": "place: Jerry's house",
                "observation": "place_mention",
                "supports_branches": ["beach_trip"],
                "supports_people": ["jerry"],
                "source": "place",
            }
        ]
    )
    assert added == 1
    assert any(item.id == "place:home" for item in trial.items)
    assert trial.ingest([{"id": "event:1", "label": "dup", "observation": "none"}]) == 0
