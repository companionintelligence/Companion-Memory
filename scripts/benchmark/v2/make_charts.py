#!/usr/bin/env python3
"""
Render "up-and-to-the-left" benchmark charts from the assembled v2 data.
Honest axis labels: structured/relational tasks + query latency (not ingest, not
overall accuracy). Outputs PNGs to charts/.
"""
import math
import os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyArrowPatch

OUT = os.path.join(os.path.dirname(__file__), "charts")
os.makedirs(OUT, exist_ok=True)

# ---- real measured data ---------------------------------------------------- #
SYS = ["ci_server", "mem0", "naive", "hindsight", "openviking", "holographic"]
COLOR = {"ci_server": "#1b6ca8", "mem0": "#9aa0a6", "naive": "#9aa0a6", "hindsight": "#c0392b",
         "openviking": "#d9822b", "holographic": "#2e8b57"}
LATENCY = {"ci_server": 0.08, "mem0": 0.12, "naive": 0.06, "hindsight": 1.16, "openviking": 0.03,
           "holographic": 0.005}   # s/query (median warm)
STRUCT_Q = {"ci_server": 73.7, "mem0": 64.0, "naive": 63.0, "hindsight": 26.3, "openviking": 32.7,
            "holographic": 25.0}   # (temporal20+enum10)/30 %
COMPLETE = {"ci_server": 73.0, "mem0": 70.8, "naive": 65.4, "hindsight": 27.6, "openviking": 38.9,
            "holographic": 31.1}   # struct storage /37 %

CAP = {  # radar axes, all as %
    "Temporal\n(current vs past)":      {"ci_server": 75, "mem0": 65, "naive": 70, "hindsight": 25, "openviking": 35, "holographic": 35},
    "Enumeration\n(complete sets)":     {"ci_server": 71, "mem0": 62, "naive": 49, "hindsight": 29, "openviking": 28, "holographic": 5},
    "Retrieval\ncompleteness":          {"ci_server": 73, "mem0": 71, "naive": 65, "hindsight": 28, "openviking": 39, "holographic": 31},
    "Decisiveness\n(present facts)":     {"ci_server": 100, "mem0": 57, "naive": 71, "hindsight": 57, "openviking": 43, "holographic": 86},
}
# Query speed: log-scaled from latency so all sub-150ms systems cluster high and
# only the slow outlier (hindsight) drops — fairer than a raw ratio that one
# very-fast system would dominate.
CAP["Query speed"] = {s: max(5, min(100, round(100 - 28 * math.log10(LATENCY[s] * 1000)))) for s in SYS}

FOOT = ("100Q corpus (90 facts + 400 distractors) · ingest gemma-4-31b · answerer+judge ornstein-3.6-27b · "
        "query latency = median warm /retrieve")


def _scatter(yvals, ylabel, title, fname, annotate_better=True):
    fig, ax = plt.subplots(figsize=(8, 6))
    for s in SYS:
        big = s == "ci_server"
        ax.scatter(LATENCY[s], yvals[s], s=520 if big else 300,
                   color=COLOR[s], edgecolor="black", linewidth=1.6 if big else 0.8,
                   zorder=5 if big else 3, alpha=0.95)
        dy = 2.4 if s != "hindsight" else -4.0
        ax.annotate(f"{s}\n{yvals[s]:.0f}%  ·  {LATENCY[s]*1000:.0f} ms",
                    (LATENCY[s], yvals[s]), xytext=(0, 14 if big else 11), textcoords="offset points",
                    ha="center", fontsize=11 if big else 9.5,
                    fontweight="bold" if big else "normal", color=COLOR[s] if big else "#333")
    ax.set_xscale("log")
    ax.set_xlabel("Query latency  (s/query, log — left is faster)", fontsize=11)
    ax.set_ylabel(ylabel, fontsize=11)
    ax.set_xlim(0.003, 2.6)   # small latency (fast) on the LEFT (incl. holographic ~5ms)
    ax.set_ylim(15, 90)
    ax.grid(True, which="both", alpha=0.25)
    ax.set_title(title, fontsize=13, fontweight="bold", pad=14)
    if annotate_better:
        ax.annotate("better", xy=(0.10, 0.93), xycoords="axes fraction", fontsize=12,
                    fontweight="bold", color="#1b6ca8", ha="left")
        ax.add_patch(FancyArrowPatch((0.18, 0.86), (0.05, 0.97), transform=ax.transAxes,
                     arrowstyle="-|>", mutation_scale=18, color="#1b6ca8", lw=2))
    fig.text(0.5, 0.005, FOOT, ha="center", fontsize=6.6, color="#777")
    fig.tight_layout(rect=(0, 0.03, 1, 1))
    p = os.path.join(OUT, fname)
    fig.savefig(p, dpi=160); plt.close(fig)
    print("wrote", p)


def chart_radar():
    axes = list(CAP.keys())
    N = len(axes)
    ang = [n / N * 2 * math.pi for n in range(N)] + [0.0]
    fig, ax = plt.subplots(figsize=(12, 10.5), subplot_kw=dict(polar=True))
    order = ["hindsight", "openviking", "holographic", "naive", "mem0", "ci_server"]  # ci_server last = on top
    for s in order:
        vals = [CAP[a][s] for a in axes] + [CAP[axes[0]][s]]
        big = s == "ci_server"
        ax.plot(ang, vals, color=COLOR[s], lw=4.5 if big else 2.0,
                label=s, zorder=5 if big else 2, marker="o", markersize=7 if big else 0)
        ax.fill(ang, vals, color=COLOR[s], alpha=0.24 if big else 0.05, zorder=4 if big else 1)
    ax.set_xticks(ang[:-1])
    ax.set_xticklabels(axes, fontsize=13.5)
    ax.tick_params(axis="x", pad=14)
    ax.set_yticks([25, 50, 75, 100])
    ax.set_yticklabels(["25", "50", "75", "100%"], fontsize=10.5, color="#888")
    ax.set_ylim(0, 100)
    ax.set_title("Capability footprint — structured memory",
                 fontsize=19, fontweight="bold", pad=38, y=1.07)
    ax.legend(loc="lower right", bbox_to_anchor=(1.20, -0.04), fontsize=13, framealpha=0.9)
    fig.text(0.5, 0.015, FOOT, ha="center", fontsize=8, color="#777")
    p = os.path.join(OUT, "chart3_capability_radar.png")
    fig.savefig(p, dpi=180, bbox_inches="tight"); plt.close(fig)
    print("wrote", p)


def chart_concurrency():
    fig, ax = plt.subplots(figsize=(8, 5))
    order = ["holographic", "openviking", "naive", "ci_server", "mem0", "hindsight"]
    lat = [LATENCY[s] * 1000 for s in order]
    safe = {"naive": True, "ci_server": True, "mem0": True, "hindsight": False, "openviking": True,
            "holographic": True}
    bars = ax.bar(order, lat, color=["#2e8b57" if safe[s] else "#c0392b" for s in order],
                  edgecolor="black", linewidth=0.8)
    ax.set_yscale("log")
    ax.set_ylabel("Recall latency  (ms/query, log)", fontsize=11)
    ax.set_title("Query latency & concurrency safety", fontsize=13, fontweight="bold", pad=12)
    for s, b in zip(order, bars):
        tag = "concurrency-safe ✓" if safe[s] else "fails under\nconcurrency ✗ (500s)"
        ax.annotate(f"{b.get_height():.0f} ms\n{tag}", (b.get_x() + b.get_width()/2, b.get_height()),
                    xytext=(0, 6), textcoords="offset points", ha="center", fontsize=9,
                    fontweight="bold" if s == "ci_server" else "normal")
    ax.set_ylim(3, 4000)
    fig.text(0.5, 0.005, FOOT, ha="center", fontsize=6.6, color="#777")
    fig.tight_layout(rect=(0, 0.03, 1, 1))
    p = os.path.join(OUT, "chart4_latency_concurrency.png")
    fig.savefig(p, dpi=160); plt.close(fig)
    print("wrote", p)


if __name__ == "__main__":
    _scatter(STRUCT_Q, "Structured / relational accuracy  (temporal + enumeration, %)",
             "Structured-memory quality vs query latency", "chart1_quality_vs_latency.png")
    _scatter(COMPLETE, "Retrieval completeness  (gold fact surfaced, %)",
             "Retrieval completeness vs query latency", "chart2_completeness_vs_latency.png")
    chart_radar()
    chart_concurrency()
    print("\nAll charts in:", OUT)
