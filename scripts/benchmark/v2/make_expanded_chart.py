#!/usr/bin/env python3
"""Expanded single-user benchmark (460 Q) leaderboard with 95% Wilson CIs.

One honest headline chart: answer accuracy + error bars. Overlapping bars are
statistical ties. CI-Server highlighted. Replaces the earlier "up-and-to-the-
left" charts, which described the superseded 6-system / 100-question run.
"""
import math
import os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

OUT = os.path.join(os.path.dirname(__file__), "charts")
os.makedirs(OUT, exist_ok=True)
N = 460
Z = 1.96

# (system, raw answer score /460) from report_expanded_main/ci/hind.
DATA = [
    ("mem0", 399.9), ("openviking", 368.9), ("naive", 360.4),
    ("tencentdb", 350.7), ("ci_server", 349.0), ("holographic", 321.6),
    ("hindsight", 102.8),
]
COLOR = {"ci_server": "#1b6ca8", "mem0": "#8e44ad", "naive": "#9aa0a6",
         "hindsight": "#c0392b", "openviking": "#d9822b", "holographic": "#2e8b57",
         "tencentdb": "#d81b60"}


def wilson(score):
    p = score / N
    denom = 1 + Z * Z / N
    centre = (p + Z * Z / (2 * N)) / denom
    half = Z * math.sqrt(p * (1 - p) / N + Z * Z / (4 * N * N)) / denom
    return 100 * p, 100 * (centre - half), 100 * (centre + half)


rows = sorted(DATA, key=lambda r: r[1], reverse=True)
names = [r[0] for r in rows]
pts = [wilson(r[1]) for r in rows]
acc = [p[0] for p in pts]
lo = [p[0] - p[1] for p in pts]
hi = [p[2] - p[0] for p in pts]

fig, ax = plt.subplots(figsize=(9, 5))
y = range(len(names))
bars = ax.barh(list(y), acc, xerr=[lo, hi], color=[COLOR[n] for n in names],
               edgecolor="black", linewidth=0.8,
               error_kw=dict(ecolor="#333", capsize=4, lw=1.3), height=0.66, alpha=0.92)
# thicker outline on the CI-Server bar as a highlight
for n, b in zip(names, bars):
    if n == "ci_server":
        b.set_linewidth(2.2)
ax.set_yticks(list(y))
ax.set_yticklabels([n + ("  ◀" if n == "ci_server" else "") for n in names], fontsize=11)
ax.invert_yaxis()
ax.set_xlim(0, 100)
ax.set_xlabel("Answer accuracy (%) on 460 questions, 95% Wilson CI", fontsize=11)
ax.set_title("Single-user memory benchmark — answer accuracy (error bars = 95% CI)",
             fontsize=13, fontweight="bold", pad=12)
for i, (a, p) in enumerate(zip(acc, pts)):
    ax.text(a + (hi[i]) + 1.0, i, f"{a:.1f}%  [{p[1]:.0f}–{p[2]:.0f}]", va="center",
            fontsize=9, color="#222")
# tie band guide
ax.axvspan(72.1, 83.6, color="#1b6ca8", alpha=0.05, zorder=0)
ax.text(77.8, len(names) - 0.4, "four-way tie band", ha="center", fontsize=8.5,
        color="#1b6ca8", style="italic")
ax.grid(True, axis="x", alpha=0.25)
fig.text(0.5, 0.01, "657-msg single-user corpus (257 facts + 400 distractors) · ingest gemma-4-31b · "
         "answerer+judge ornstein-3.6-27b · overlapping bars = statistical tie",
         ha="center", fontsize=7, color="#777")
fig.tight_layout(rect=(0, 0.03, 1, 1))
p = os.path.join(OUT, "expanded_leaderboard.png")
fig.savefig(p, dpi=170)
print("wrote", p)
