# F — variational free energy

Source: Friston et al., *Active Inference: A Process Theory* (2017), equation (2.4).

Code: `variational.py`

```
F = E_Q[ ln Q(x) − ln P(x, o) ]
  = D[ Q(x) || P(x|o) ] − ln P(o)          bound on surprise
  = D[ Q(x) || P(x) ] − E_Q[ ln P(o|x) ]   complexity − accuracy
```

F is the height of the hill. Perception, policy selection, and learning all walk downhill on this one number.

When Q equals the true posterior P(x|o), the KL term is zero and F equals surprise, −ln P(o). Anywhere else F is strictly larger. That is the bound we test.

In this package F is implemented for one hidden factor and one observed cue. Complexity is KL(Q(s) || prior). Accuracy is E_Q[ln P(o|s)], the expected log of one row of A.
