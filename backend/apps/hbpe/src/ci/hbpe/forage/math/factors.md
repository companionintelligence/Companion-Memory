# Two sliders, factorial Q

Source: *Scene Construction, Visual Foraging* (2016); Process Theory mean-field remark.

Code: `model.py`, `infer.py` (`infer_factors`)

Slider 1 is the branch: beach / office / errands. Slider 2 is texture inside the branch: Santa Cruz / downtown / home. Factorial space is not the list of those permutations. It is the decision to store

```
Q(branch, place) ≈ Q(branch) Q(place)
```

instead of a full joint over every combo. That is the mean-field approximation. You do not store P(beach ∧ ice-cream ∧ board-shorts ∧ Sam ∧ 14:00).

## Inference must use E[ln A], not ln E[A]

Wrong (what we shipped first): flatten A by averaging the other factor, then take the log.

```
A_flat[o, b] = Σ_p A[o, b, p] Q(p)
s_b = σ( ln A_flat[o] + ln D_b )     # ln E[A]
```

Right (Jensen): average the logs.

```
s_b = σ( ln D_b + Σ_p Q(p) ln A[o, b, p] )
s_p = σ( ln D_p + Σ_b Q(b) ln A[o, b, p] )
```

Iterate those two until they settle. Priors stay fixed. Q(branch) and Q(place) chase each other.

## Pick

Collapse slider 1 only when its mass is committed. A flat slider has no mode. Argmax of a uniform is index zero, not a prediction.
