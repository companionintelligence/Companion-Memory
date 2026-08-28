# G — expected free energy

Source: Process Theory (2.5)–(2.6); *Active inference and epistemic value* (2015).

Code: `expected.py`

Before you act, you score each policy by the free energy you would expect if you took it.

```
G(π, τ) = D[ Q(o_τ|π) || P(o_τ) ] + E_Q[ H[P(o_τ|s_τ)] ]
        = o_π · (ln o_π − U) + s_π · H
          risk                   ambiguity
```

`o_π = A s_π` is the predicted cue. `U = ln C` are preferences. `H_j = −Σ_i A_ij ln A_ij` is the entropy of each column of A (paper: `H = −diag(Â · A)`).

The other split is the one we care about for the eye:

```
G = − epistemic − extrinsic
epistemic  = I(S; O | π) = H[Q(o)] − E_s H[P(o|s)]
extrinsic  = E[U(o)] = o_π · ln C
```

Epistemic is mutual information: will this read change my mind. Extrinsic is whether I like the cue. With a flat C, G is almost all epistemic.

Identity we keep under test: `G = risk + ambiguity = −epistemic − extrinsic`.

## What we implement

One-step look-ahead. A policy is “read this unread lake item.” We do **not** yet unroll a sequence of future gazes.

For two factors, G is scored under the mean-field joint Q(branch)Q(place) against the full A slice at that gaze, not by averaging two flattened one-factor G’s. Averaging sliders was a mistake. The paper’s G is one number for one predicted outcome distribution.
