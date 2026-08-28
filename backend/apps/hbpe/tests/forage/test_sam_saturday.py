"""First toy from CI-Active-Inference#19: where is Sam on Saturday."""

import numpy as np
import pytest

from ci.hbpe.forage.lake import sam_saturday_lake
from ci.hbpe.forage.model import BRANCHES
from ci.hbpe.forage.trial import ForageError, ForageTrial


def _trial(seed: int = 0) -> ForageTrial:
    model, process_A, items, truth = sam_saturday_lake()
    return ForageTrial(
        model=model,
        process_A=process_A,
        items=items,
        truth=truth,
        rng=np.random.default_rng(seed),
    )


def test_calendar_has_lower_G_than_friday_leftover():
    trial = _trial()
    by_id = {trial.items[row["gaze"]].id: row["G"] for row in trial.shortlist()}
    assert by_id["calendar_saturday"] < by_id["sam_friday"]


def test_three_samples_can_commit_beach():
    trial = _trial(0)
    for _ in range(3):
        trial.sample_next()
    picked = trial.pick()
    surpr = trial.surprise()
    if picked["ready"]:
        assert picked["branch"] == "beach"
    assert surpr["q_branch"] > 1.0 / len(BRANCHES)
    assert surpr["surprise_branch"] < np.log(len(BRANCHES))


def test_pick_refuses_flat_sliders():
    trial = _trial(0)
    picked = trial.pick()
    assert picked["branch"] is None
    assert picked["texture"] is None
    assert picked["ready"] is False


def test_learning_does_not_touch_the_world():
    trial = _trial(1)
    before = trial.process_A.copy()
    trial.sample_next()
    assert np.allclose(trial.process_A, before)


def test_postdict_names_an_unread_item():
    trial = _trial(1)
    trial.sample_next()
    post = trial.postdict()
    assert post
    assert post[0]["delta_F"] >= post[-1]["delta_F"]
    unread_ids = {trial.items[g].id for g in trial.unread}
    assert post[0]["item_id"] in unread_ids


def test_close_trial_updates_D():
    trial = _trial(0)
    for _ in range(2):
        trial.sample_next()
    before = trial.model.D_joint[BRANCHES.index("beach")].sum()
    trial.close_trial()
    after = trial.model.D_joint[BRANCHES.index("beach")].sum()
    assert after >= before


def test_jerry_is_not_tom_under_beach():
    trial = _trial(0)
    for item_id in ("calendar_saturday", "jerry_text", "surf_report"):
        trial.read_item(item_id)
    beach = trial.permutations("beach")
    assert beach["jerry"] > beach["tom"]
    office = trial.permutations("office")
    assert beach["jerry"] != office["jerry"] or beach["tom"] != office["tom"]


def test_pin_does_not_hide_branches():
    trial = _trial(0)
    trial.set_pin("beach")
    mass = trial.pick()["branch_mass"]
    assert set(mass) == set(BRANCHES)
    assert trial.pin == "beach"


def test_probe_does_not_change_q():
    trial = _trial(0)
    trial.read_item("calendar_saturday")
    before = trial.joint.copy()
    probed = trial.probe("tom_chess")
    assert probed["updated_q"] is False
    assert probed["item_id"] == "tom_chess"
    assert np.allclose(trial.joint, before)


def test_expect_rejected_on_past_branch():
    trial = _trial(0)
    trial.read_item("calendar_saturday")
    trial.resolve({"branch": "beach", "texture": "jerry"})
    assert trial.is_past("office")
    with pytest.raises(ForageError, match="past"):
        trial.expect("office")
    beach = trial.expect("beach")
    assert beach["interests"]["jerry"] == ["surf", "tacos"]
    assert beach["interests"]["tom"] == ["chess", "coffee"]
