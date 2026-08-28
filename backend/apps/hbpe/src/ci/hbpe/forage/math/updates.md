# Updates — descend F

Source: Process Theory (2.7)–(2.8).

Code: `infer.py`, `learn.py`

## Inference

```
s_τ = σ( Aᵀ o_τ + ln B_{τ−1} s_{τ−1} + ln B_τᵀ s_{τ+1} )
π   = σ( −F − γ G )
```

`σ` is softmax. The first term is the likelihood of the cue just seen. The second is the past. The third is the future. Together that is a Bayesian smoother: beliefs about Saturday at 10am are informed by what you will read at 4pm.

One observation, no future state yet, reduces to Bayes as a softmax:

```
s = σ( ln A[o, :] + ln D )
```

We still pass `F = 0` into `π = σ(−F − γG)`, so item choice is softmax of −γG only. Per-policy F comes when we keep states under each policy.

The future message `ln Bᵀ s_{τ+1}` is wired in `infer_states` but the trial does not send it yet. Reading does not change Saturday, so B for branch and place is identity. The missing piece is representing Saturday at every time index, not a one-shot posterior.

## Learning

```
a ← a + o ⊗ s
d ← d + s_1
```

`a` and `d` are Dirichlet counts. Expected A is column-normalized `a`. We use that, not the digamma form `ψ(a)−ψ(a₀)`, until we need the full variational likelihood.

The world’s generative process R is not `a`. Learning may only touch the agent’s model P.
