#!/usr/bin/env python3
"""Writes the plan files the device bench runs (`plans/<name>.json`).

    plans.py list
    plans.py <name> [<name> ...]          write plans/<name>.json
    plans.py <name> --set key=value ...   override a stage's parameters (see STAGES)

A cell is one measurement; see `BenchCell` in Sources/BenchModel.swift for every field. Ids are built
from the fields that differ between cells, so a relaunched run skips what it already finished and a
re-generated plan keeps its ids.
"""

import itertools
import json
import os
import sys

Q3 = "qwen3-0.6b-int4"
Q25 = "qwen2.5-1.5b-instruct"
PROMPTS = ["p1", "p2", "p3"]

# The sampler the app ships for Qwen3 (catalog default) and the one Qwen's model card recommends for
# non-thinking mode (temperature 0.7, top-p 0.8, top-k 20).
SAMPLERS = {
    "cat": {},
    "card": {"temperature": 0.7, "topP": 0.8, "topK": 20},
    "cool": {"temperature": 0.3, "topP": 0.8, "topK": 20},
}


def cell(**fields):
    """Fills in the id. Everything except the id is the cell's own fields."""
    model = {Q3: "q3", Q25: "q25"}[fields.get("model", Q3)]
    parts = [
        fields.get("mode", "tool"),
        model,
        fields.get("accelerator") or "",
        "w{}".format(fields.get("maxTokens", "def")),
        "b{}".format(fields.get("toolBudget", "raw")),
        fields.get("shaper", "prod"),
        f"c{int(fields.get('carry', True))}",
        f"t{int(fields.get('thinking', False))}",
        fields.get("sampler", "cat"),
        fields.get("system", "shipped"),
        "r{}".format(fields.get("maxReplyTokens", "-")),
        f"n{fields.get('turns', 1)}",
        fields.get("responseAs", "string")[:3],
        f"k{int(fields.get('constrained', False))}",
        "ch{}".format(fields.get("prefillChunk", "-")),
        "th{}".format(fields.get("threads", "-")),
        "tl%s"
        % (
            "all"
            if not fields.get("toolNames")
            else "+".join(n.split("_")[0] for n in fields["toolNames"])
        ),
        fields.get("prompt", "p1"),
        f"s{fields.get('seed', 0)}",
    ]
    out = dict(fields)
    sampler = SAMPLERS[out.pop("sampler", "cat")]
    out.update(sampler)
    out["id"] = "-".join(p for p in parts if p)
    out["note"] = fields.get("sampler", "cat")
    return out


def grid(base, **axes):
    names = list(axes)
    for values in itertools.product(*(axes[name] for name in names)):
        yield cell(**{**base, **dict(zip(names, values, strict=True))})


def seeds(n):
    return list(range(n))


def stage_ofat(reps=4, **_):
    """One factor at a time around a best guess, to see which of them the quality depends on."""
    best = {
        "model": Q3,
        "maxTokens": 1024,
        "toolBudget": 512,
        "sampler": "card",
        "carry": True,
        "shaper": "prod",
        "responseAs": "object",
    }
    base = {
        "model": Q3,
        "maxTokens": 1024,
        "toolBudget": 512,
        "sampler": "cat",
        "carry": False,
        "shaper": "legacy",
        "responseAs": "string",
    }
    flips = {
        "best": {},
        "sampler=cat": {"sampler": "cat"},
        "carry=0": {"carry": False},
        "shaper=legacy": {"shaper": "legacy"},
        "response=string": {"responseAs": "string"},
        "window=4096": {"maxTokens": 4096},
    }
    for name, flip in [("baseline", None), *list(flips.items())]:
        config = dict(base if flip is None else {**best, **flip})
        for prompt in PROMPTS:
            for rep in range(reps):
                c = cell(**{**config, "prompt": prompt, "seed": rep})
                c["note"] = name
                yield c


def stage_winprobe(reps=4, **_):
    """Where does the tool turn start working: the window, the size of the result, the sampler."""
    best = {
        "model": Q3,
        "sampler": "card",
        "carry": True,
        "shaper": "prod",
        "responseAs": "object",
    }
    for window in [1024, 1280, 1536, 2048, 3072, 4096]:
        for prompt in ["p1", "p2"]:
            for rep in range(reps):
                c = cell(
                    **{
                        **best,
                        "maxTokens": window,
                        "toolBudget": 512,
                        "prompt": prompt,
                        "seed": rep,
                    }
                )
                c["note"] = f"window={window}"
                yield c
    for budget in [128, 256]:
        for prompt in ["p1", "p2"]:
            for rep in range(reps):
                c = cell(
                    **{
                        **best,
                        "maxTokens": 1024,
                        "toolBudget": budget,
                        "prompt": prompt,
                        "seed": rep,
                    }
                )
                c["note"] = f"w1024 budget={budget}"
                yield c
    for window in [1024, 2048]:
        for prompt in ["p1", "p2"]:
            for rep in range(reps):
                c = cell(
                    **{
                        **best,
                        "sampler": "cool",
                        "maxTokens": window,
                        "toolBudget": 512,
                        "prompt": prompt,
                        "seed": rep,
                    }
                )
                c["note"] = f"cool window={window}"
                yield c


FILLER_SENTENCES = [
    "The kitchen light switch is by the back door and the porch light is on a timer.",
    "The garden hose is coiled behind the shed next to the green watering can.",
    "Trash goes out on Tuesday nights and recycling on alternate Wednesdays.",
    "The spare key lives in the blue ceramic pot beside the front steps.",
    "Wifi is on the router in the hallway closet and the password is on the fridge.",
    "The thermostat schedule drops to sixty-two degrees overnight in winter.",
    "Laundry detergent is under the sink and the dryer lint trap needs emptying every load.",
    "The neighbors on the left have a dog that barks when the mail arrives.",
    "Paint colors in the living room are warm white on the walls and gray on the trim.",
    "The car needs an oil change at the next odometer milestone, check the sticker.",
]


def filler(tokens):
    """About `tokens` tokens of neutral text (the tokenizer averages ~4.5 bytes a token on it)."""
    text, i = "", 0
    while len(text) < tokens * 4.5:
        text += FILLER_SENTENCES[i % len(FILLER_SENTENCES)] + " "
        i += 1
    return text.strip()


def stage_failmap(reps=3, **_):
    """The tool turn goes wrong at some window; is it the window, the prompt length, or the room left?
    A result in the prompt behind a filler system message, so there is no tool-call randomness."""
    for window in [1024, 1280, 1536, 2048]:
        for budget in [256, 512, 1024, 2048]:
            for rep in range(reps):
                c = cell(
                    model=Q3,
                    mode="inject",
                    maxTokens=window,
                    toolBudget=budget,
                    shaper="lean2",
                    sampler="card",
                    system="custom",
                    seed=rep,
                    prompt="p1",
                    bindTools=False,
                )
                c["systemText"] = filler(430)
                c["note"] = f"w{window} b{budget}"
                yield c


def stage_flip(reps=4, **_):
    """Where exactly does the tool turn stop working? Budgets around each window's suspected flip point
    (a rendered tool message of about window/6 tokens), at a temperature that calls the tool most often."""
    best = {
        "model": Q3,
        "sampler": "cool",
        "carry": True,
        "shaper": "prod",
        "responseAs": "object",
    }
    ladder = {
        1024: [256, 320, 384, 448, 512],
        1280: [320, 384, 448, 512, 640],
        1536: [448, 512, 640, 768, 1024],
        2048: [640, 768, 1024, 1280, 1536],
    }
    for window, budgets in ladder.items():
        for budget in budgets:
            for prompt in ["p1", "p2"]:
                for rep in range(reps):
                    c = cell(
                        **{
                            **best,
                            "maxTokens": window,
                            "toolBudget": budget,
                            "prompt": prompt,
                            "seed": rep,
                        }
                    )
                    c["note"] = f"w{window} b{budget}"
                    yield c


def stage_dev1(**_):
    """First device run, short: what each window costs in memory and time, and what the fixed part of
    the window is. Load cells restart the process so each reading starts from a clean address space."""
    for window in [1024, 2048, 4096, 8192]:
        yield cell(
            mode="load", model=Q3, maxTokens=window, bindTools=False, restartAfter=True
        )
    for accelerator in ["gpu", "cpu"]:
        for window in [2048, 4096]:
            yield cell(
                mode="load",
                model=Q25,
                accelerator=accelerator,
                maxTokens=window,
                bindTools=False,
                restartAfter=True,
            )
    yield cell(mode="account", model=Q3, maxTokens=4096)
    yield cell(mode="account", model=Q25, maxTokens=4096, forceTools=True)
    yield cell(mode="render", model=Q3, maxTokens=4096, toolBudget=512, shaper="lean2")


def stage_dev2(reps=4, **_):
    """The headline on the device: does the tool turn work at the window the app ships, and where does it
    start to, with the app's own settings against the best guess."""
    ship = {
        "model": Q3,
        "maxTokens": 1024,
        "toolBudget": 512,
        "sampler": "cat",
        "carry": False,
        "shaper": "legacy",
        "responseAs": "string",
    }
    best = {
        "model": Q3,
        "sampler": "card",
        "carry": True,
        "shaper": "prod",
        "responseAs": "object",
        "toolBudget": 512,
    }
    for prompt in PROMPTS:
        for rep in range(reps):
            c = cell(**{**ship, "prompt": prompt, "seed": rep})
            c["note"] = "shipped w1024"
            yield c
    for window in [1024, 1536, 2048, 4096]:
        for prompt in ["p1", "p2"]:
            for rep in range(reps):
                c = cell(**{**best, "maxTokens": window, "prompt": prompt, "seed": rep})
                c["note"] = f"best w{window}"
                yield c


def _w2048(**overrides):
    base = {
        "model": Q3,
        "maxTokens": 2048,
        "toolBudget": 768,
        "sampler": "card",
        "carry": True,
        "shaper": "prod",
        "responseAs": "object",
    }
    base.update(overrides)
    return base


def stage_samp(reps=8, **_):
    """The sampler, where the tool turn works."""
    yield from grid(
        _w2048(), sampler=["cat", "card", "cool"], prompt=PROMPTS, seed=seeds(reps)
    )


def stage_resp(reps=8, **_):
    """The tool's answer as text (what the app does) or as a parsed value."""
    yield from grid(
        _w2048(), responseAs=["string", "object"], prompt=PROMPTS, seed=seeds(reps)
    )


def stage_shape2(reps=6, **_):
    """The shaper variants, where the tool turn works."""
    yield from grid(
        _w2048(),
        shaper=["legacy", "prod", "lean2", "lean4", "digest"],
        prompt=PROMPTS,
        seed=seeds(reps),
    )


def stage_carry(reps=8, **_):
    """Thinking on the tool-result request: the app today (off by omission = on) against carried-through off."""
    yield from grid(_w2048(), carry=[False, True], prompt=PROMPTS, seed=seeds(reps))


def stage_fill(**_):
    """How far a window can be filled before the phone says no: peak footprint, headroom left, and speed
    with the window half full and nine-tenths full. A long system text stands in for a long conversation."""
    for window in [2048, 4096, 8192, 12288]:
        for fraction in [0.5, 0.9]:
            c = cell(
                mode="chat",
                model=Q3,
                maxTokens=window,
                bindTools=False,
                system="custom",
                sampler="card",
                prompt="p3",
                restartAfter=True,
            )
            c["systemText"] = filler(int(window * fraction))
            c["note"] = f"w{window} fill{int(fraction * 100)}%"
            c["id"] += f"-f{int(fraction * 100)}"
            yield c
    for accelerator in ["gpu", "cpu"]:
        for fraction in [0.5, 0.9]:
            c = cell(
                mode="chat",
                model=Q25,
                accelerator=accelerator,
                maxTokens=4096,
                bindTools=False,
                system="custom",
                sampler="cat",
                prompt="p3",
                restartAfter=True,
            )
            c["systemText"] = filler(int(4096 * fraction))
            c["note"] = f"q25 {accelerator} w4096 fill{int(fraction * 100)}%"
            c["id"] += f"-f{int(fraction * 100)}"
            yield c


def stage_chunk(reps=5, **_):
    """Is the slow, garbled post-tool turn a prefill-length effect? Feed the prefill in smaller chunks."""
    best = {
        "model": Q3,
        "sampler": "cool",
        "carry": True,
        "shaper": "prod",
        "responseAs": "object",
        "toolBudget": 512,
    }
    for window in [1024, 1280]:
        for chunk in [None, 64, 128]:
            for prompt in ["p1", "p2"]:
                for rep in range(reps):
                    c = cell(
                        **{
                            **best,
                            "maxTokens": window,
                            "prefillChunk": chunk,
                            "prompt": prompt,
                            "seed": rep,
                        }
                    )
                    c["note"] = f"w{window} chunk={chunk}"
                    yield c


def stage_threads(reps=3, **_):
    """Speed against thread count on a phone with six cores (the runtime's default is four)."""
    for threads in [None, 2, 3, 4, 6]:
        for rep in range(reps):
            c = cell(
                mode="load",
                model=Q3,
                maxTokens=2048,
                bindTools=False,
                threads=threads,
                seed=rep,
            )
            c["note"] = f"threads={threads}"
            yield c


def stage_calls(reps=8, **_):
    """The model often answers without calling the tool at all. What makes it call: a more imperative
    system instruction, constrained decoding for tool calls, a lower temperature."""
    base = _w2048(sampler="cool")
    yield from grid(
        base,
        system=["shipped", "imperative"],
        constrained=[False, True],
        prompt=PROMPTS,
        seed=seeds(reps),
    )


def stage_constrained(reps=8, **_):
    """LiteRT-LM's grammar path for tool calls, which the app leaves off until someone has run it on a device:
    does it change whether the model calls the tool, and does what it calls still parse and answer?"""
    yield from grid(
        _w2048(sampler="card"),
        constrained=[False, True],
        prompt=PROMPTS,
        seed=seeds(reps),
    )


def stage_roomtest(reps=4, **_):
    """Is the post-tool failure about the window, or about the room left once the result is in? Every tool turn that
    failed so far had a small window AND little room (the two were never separated). Here they are:
    - a big window made to have little room: a filler system text pushes the cache up to the call, so
      window - (cache at the call + result + wrapper) is 350 to 1000 tokens;
    - a small window made to have plenty: one tool, no system text, a tiny result."""
    for window in [2048, 3072]:
        for room in [350, 500, 650, 800, 1000]:
            for rep in range(reps):
                c = cell(
                    model=Q3,
                    maxTokens=window,
                    toolBudget=512,
                    sampler="card",
                    system="custom",
                    seed=rep,
                    prompt="p1",
                )
                # ~631 tokens are there without the filler (tools 368, question, the call, a 186-token result)
                c["systemText"] = filler(window - room - 631)
                c["note"] = f"w{window} room~{room}"
                c["id"] += f"-rm{room}"
                yield c

    for window in [1024, 1280]:
        for budget in [128, 256, 384, 512]:
            for rep in range(reps):
                c = cell(
                    model=Q3,
                    maxTokens=window,
                    toolBudget=budget,
                    sampler="card",
                    system="custom",
                    toolNames=["knowledge_search"],
                    seed=rep,
                    prompt="p1",
                )
                c["systemText"] = ""
                c["note"] = f"w{window} lean b{budget}"
                yield c


def stage_multichat(reps=4, **_):
    """Is the post-tool failure at small windows a tool effect, or a second-request effect? Plain chat, no tools, three
    questions in one conversation, behind a system text as long as the tool preface, at windows either side of
    the point where the tool turn stops working."""
    for window in [1024, 1280, 1536, 2048]:
        for rep in range(reps):
            c = cell(
                model=Q3,
                mode="tool",
                maxTokens=window,
                bindTools=False,
                turns=3,
                sampler="card",
                system="custom",
                seed=rep,
                prompt="p1",
            )
            c["systemText"] = filler(430)
            c["note"] = f"plain chat w{window}"
            yield c


def stage_inject3(reps=6, **_):
    """Qwen3 without the tool round trip: the shaped result placed in the question, no tools bound (so no
    368-token tool preface and no tool-result continuation). Against the same questions through the tool."""
    for window in [1024, 2048]:
        for budget in [512, 1024, 2048]:
            yield from grid(
                {
                    "mode": "inject",
                    "model": Q3,
                    "maxTokens": window,
                    "toolBudget": budget,
                    "sampler": "card",
                    "shaper": "prod",
                    "bindTools": False,
                },
                prompt=PROMPTS,
                seed=seeds(reps),
            )


def stage_query(reps=12, **_):
    """What the model passes as the query: the key words, or its whole instruction."""
    yield from grid(_w2048(sampler="cool"), prompt=["p1", "p2"], seed=seeds(reps))


def stage_tools(reps=8, **_):
    """Three overlapping tools cost ~370 prompt tokens and give a 0.6B model something to choose between.
    What does it do with fewer?"""
    base = _w2048(sampler="cool")
    for names in [None, ["knowledge_search", "people_find"], ["knowledge_search"]]:
        for prompt in PROMPTS:
            for rep in range(reps):
                c = cell(**{**base, "toolNames": names, "prompt": prompt, "seed": rep})
                c["note"] = "tools=%s" % ("all" if not names else "+".join(names))
                yield c


def stage_matrix(reps=4, **_):
    """The task's matrix: the two fixed prompts at result budgets of 256, 512 and 1024 bytes. Qwen3 as the app
    ships it (window 1024, today's shaper and sampler); Qwen3 with the settings the experiments chose, at windows
    raised up to what the phone allows; Qwen2.5, which has no tool slots, with the result in its prompt."""
    budgets = [256, 512, 1024]
    ship = {
        "model": Q3,
        "maxTokens": 1024,
        "sampler": "cat",
        "carry": False,
        "shaper": "legacy",
        "responseAs": "string",
    }
    best = {
        "model": Q3,
        "sampler": "card",
        "carry": True,
        "shaper": "prod",
        "responseAs": "object",
    }

    for budget in budgets:
        for prompt in ["p1", "p2"]:
            for rep in range(reps):
                c = cell(
                    **{**ship, "toolBudget": budget, "prompt": prompt, "seed": rep}
                )
                c["note"] = f"ship w1024 b{budget}"
                yield c

    for window in [1024, 2048, 4096, 8192]:
        for budget in budgets:
            for prompt in ["p1", "p2"]:
                for rep in range(reps):
                    fields = {**best, "maxTokens": window, "toolBudget": budget}
                    c = cell(**{**fields, "prompt": prompt, "seed": rep})
                    c["note"] = f"best w{window} b{budget}"
                    yield c

    for accelerator in ["gpu", "cpu"]:
        for budget in budgets:
            for prompt in ["p1", "p2"]:
                for rep in range(reps):
                    c = cell(
                        mode="inject",
                        model=Q25,
                        maxTokens=4096,
                        sampler="cat",
                        accelerator=accelerator,
                        shaper="prod",
                        toolBudget=budget,
                        prompt=prompt,
                        seed=rep,
                    )
                    c["note"] = f"q25 {accelerator} b{budget}"
                    yield c


def stage_smoke(**_):
    yield cell(mode="load", model=Q3)
    yield cell(mode="account", model=Q3, maxTokens=4096)
    yield from grid(
        {"model": Q3, "toolBudget": 512, "prompt": "p1"},
        carry=[False, True],
        shaper=["legacy", "prod"],
    )


def stage_load(**_):
    """Does each window load, what does it cost in memory, how fast is the model."""
    for window in [1024, 2048, 4096, 8192, 16384]:
        yield cell(mode="load", model=Q3, maxTokens=window, bindTools=False)
    for accelerator in ["cpu", "gpu"]:
        for window in [2048, 4096, 8192]:
            yield cell(
                mode="load",
                model=Q25,
                accelerator=accelerator,
                maxTokens=window,
                bindTools=False,
            )


def stage_account(**_):
    """What the fixed part of the window is, in the model's own tokens: system text, each tool's declaration, and
    what the chat template makes of a user message and of a tool message."""
    yield cell(mode="account", model=Q3, maxTokens=4096)
    yield cell(mode="account", model=Q25, maxTokens=4096, forceTools=True)
    yield cell(mode="render", model=Q3, maxTokens=4096, toolBudget=512, shaper="lean2")


def stage_think(n_seeds=5, window=1024, budget=512, **_):
    """Is the continuation's thinking the cause? Thinking x sampler, as shipped otherwise."""
    yield from grid(
        {"model": Q3, "maxTokens": window, "toolBudget": budget},
        carry=[False, True],
        sampler=["cat", "card"],
        prompt=PROMPTS,
        seed=seeds(n_seeds),
    )


def stage_shape(n_seeds=5, window=1024, carry=True, sampler="card", **_):
    """The shaper variants against the budgets the task names."""
    yield from grid(
        {"model": Q3, "maxTokens": window, "carry": carry, "sampler": sampler},
        shaper=["legacy", "prod", "lean2", "digest"],
        toolBudget=[256, 512, 1024],
        prompt=PROMPTS,
        seed=seeds(n_seeds),
    )


def stage_window(n_seeds=3, carry=True, sampler="card", **_):
    """The window raised, with budgets that grow with it."""
    yield from grid(
        {"model": Q3, "carry": carry, "sampler": sampler},
        maxTokens=[2048, 4096],
        shaper=["legacy", "prod"],
        toolBudget=[1024, 2048, 4096],
        prompt=PROMPTS,
        seed=seeds(n_seeds),
    )


def stage_qwen25(n_seeds=3, **_):
    """Qwen2.5 has no tool slots: the shaped result is put in the prompt."""
    yield from grid(
        {"mode": "inject", "model": Q25, "maxTokens": 4096, "sampler": "cat"},
        accelerator=["gpu", "cpu"],
        shaper=["legacy", "prod"],
        toolBudget=[512, 1024, 2048],
        prompt=PROMPTS,
        seed=seeds(n_seeds),
    )


def stage_turns(n_seeds=2, **_):
    """How many questions fit in one conversation before the window is spent."""
    yield from grid(
        {"model": Q3, "carry": True, "sampler": "card", "shaper": "prod", "turns": 4},
        maxTokens=[1024, 2048, 4096],
        toolBudget=[512, 1024],
        seed=seeds(n_seeds),
    )


def stage_system(n_seeds=3, window=1024, budget=512, carry=True, sampler="card", **_):
    yield from grid(
        {
            "model": Q3,
            "maxTokens": window,
            "toolBudget": budget,
            "carry": carry,
            "sampler": sampler,
        },
        system=["shipped", "terse", "grounded"],
        prompt=PROMPTS,
        seed=seeds(n_seeds),
    )


def stage_replycap(n_seeds=3, window=1024, budget=512, carry=True, sampler="card", **_):
    yield from grid(
        {
            "model": Q3,
            "maxTokens": window,
            "toolBudget": budget,
            "carry": carry,
            "sampler": sampler,
        },
        maxReplyTokens=[64, 128, 256, None],
        prompt=PROMPTS,
        seed=seeds(n_seeds),
    )


STAGES = {
    "matrix": stage_matrix,
    "smoke": stage_smoke,
    "tools": stage_tools,
    "query": stage_query,
    "constrained": stage_constrained,
    "roomtest": stage_roomtest,
    "multichat": stage_multichat,
    "inject3": stage_inject3,
    "calls": stage_calls,
    "chunk": stage_chunk,
    "threads": stage_threads,
    "fill": stage_fill,
    "samp": stage_samp,
    "resp": stage_resp,
    "shape2": stage_shape2,
    "carry": stage_carry,
    "dev1": stage_dev1,
    "dev2": stage_dev2,
    "flip": stage_flip,
    "failmap": stage_failmap,
    "winprobe": stage_winprobe,
    "ofat": stage_ofat,
    "load": stage_load,
    "account": stage_account,
    "think": stage_think,
    "shape": stage_shape,
    "window": stage_window,
    "qwen25": stage_qwen25,
    "turns": stage_turns,
    "system": stage_system,
    "replycap": stage_replycap,
}


def parse_value(text):
    if text in ("true", "false"):
        return text == "true"
    try:
        return int(text)
    except ValueError:
        return text


def main(argv):
    if len(argv) < 2 or argv[1] in ("-h", "--help"):
        print(__doc__)
        return 0
    if argv[1] == "list":
        for name, fn in STAGES.items():
            summary = (fn.__doc__ or "").strip().split("\n")[0]
            print(f"{name:<10} {len(list(fn())):>4} cells  {summary}")
        return 0

    overrides = {}
    names = []
    rest = iter(argv[1:])
    for arg in rest:
        if arg == "--set":
            key, _, value = next(rest).partition("=")
            overrides[key] = parse_value(value)
        else:
            names.append(arg)

    here = os.path.dirname(os.path.abspath(__file__))
    os.makedirs(os.path.join(here, "plans"), exist_ok=True)

    for name in names:
        cells = list(STAGES[name](**overrides))
        ids = [c["id"] for c in cells]
        assert len(ids) == len(set(ids)), f"duplicate cell ids in {name}"
        suffix = "".join(f"-{k}{v}" for k, v in sorted(overrides.items()))
        plan_id = name + suffix
        path = os.path.join(here, "plans", plan_id + ".json")
        with open(path, "w") as handle:
            json.dump({"id": plan_id, "cells": cells}, handle, indent=1)
        print(f"{plan_id}: {len(cells)} cells -> {os.path.relpath(path)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
