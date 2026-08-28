"""Run the first toy: where is Sam on Saturday."""

from __future__ import annotations

import numpy as np

from .lake import sam_saturday_lake
from .trial import ForageTrial


def run(n_samples: int = 3, seed: int = 0) -> dict:
    model, process_A, items, truth = sam_saturday_lake()
    process_before = process_A.copy()
    trial = ForageTrial(
        model=model,
        process_A=process_A,
        items=items,
        truth=truth,
        rng=np.random.default_rng(seed),
    )
    print(f"question: {trial.question}")
    print(f"truth:    {truth}")
    print("lake:")
    for item in items:
        print(f"  - {item.id}: {item.label}")

    for step in range(n_samples):
        ranked = trial.shortlist()
        print(f"\nstep {step + 1} shortlist (low G first):")
        for row in ranked:
            print(f"  G={row['G']:.3f}  epistemic={row['epistemic']:.3f}  {row['item'].id}")
        rec = trial.sample_next()
        print(f"  read {rec.item_id} → {rec.cue}")
        print(f"  Q(branch)={ {k: round(v, 3) for k, v in trial.pick()['branch_mass'].items()} }")
        print(f"  Q(texture|beach)={ {k: round(v, 3) for k, v in trial.permutations('beach').items()} }")

    picked = trial.pick()
    surpr = trial.surprise()
    post = trial.postdict()
    trial.resolve()
    trial.close_trial()
    assert np.allclose(process_A, process_before), "learning must not touch the world"
    print(f"\npick: branch={picked['branch']} texture={picked['texture']} ready={picked['ready']}")
    print(f"surprise: {surpr['surprise']:.3f}  (q_truth={surpr['q_truth']:.3f})")
    print("postdict (unread that would have dropped F):")
    for row in post:
        print(f"  ΔF={row['delta_F']:.3f}  {row['item_id']} would show {row['would_show']}")
    return {"pick": picked, "surprise": surpr, "postdict": post, "log": trial.log}


if __name__ == "__main__":
    run()
