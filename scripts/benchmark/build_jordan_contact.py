#!/usr/bin/env python3
"""
Build the Jordan-as-Max's-friend CONTACT persona.

Source: personas/jordan_rivera_base.json — a standalone first-person Jordan
Rivera persona (150 questions). This builder FOLDS Jordan into the single-user
benchmark world, where the ONE user is Max Turnquist and Jordan is a person Max
knows (his friend).

Three transformations applied (see task spec):

  1. Reframe first-person -> third-person facts Max states about his friend.
     "I play guitar"            -> "My friend Jordan plays guitar."
     "My wife Noor is an ER..." -> "Jordan's wife <name> is an ER doctor."
     Jordan's whole sub-network (wife, parents, siblings, friends, colleagues,
     pets, job history, hobbies) is preserved, stated by Max in third person.

  2. De-conflict ALL collisions with Max Turnquist's world (and stay clear of the
     sibling Priya Sharma namespace). Every Jordan-network entity that clashed
     with a Max avoid-list value is renamed to a fresh, distinct value. Jordan's
     Cuban-American texture (Miami/Tampa, Abuela, Nochebuena, tres leches) is
     kept; colliding names within it (Rosa->Rose, Sam, Theo, Pixel, Denver,
     Garmin, Fujifilm, Meridian, Vancouver, Arrival, San Francisco) are renamed,
     preferring Latin/his-culture first names.

  3. Re-categorize every question by hop-distance from MAX (Max=user, Jordan=1):
       - Jordan's OWN direct attributes  : flat-recall -> relational
       - Jordan's 1-hop relations        : relational  -> multi-hop
       - Jordan's 2-hop relations        : multi-hop    -> multi-hop (kept)
       - temporal-update / enumeration / aggregation / absence /
         presence-control               : category KEPT (values updated)

Output: personas/jordan_contact_base.json
  persona_id = "jordan_contact", name = "Jordan Rivera (Max's friend)"
  sessions       : Max's first-person statements ABOUT Jordan & his network.
  eval_questions : the 150, reframed + recategorized, ids keep the `jq` prefix.

This is a BASE (canonical facts only, no distractors). Run
generate_large_persona.py on it to bury the facts under hard-negative noise.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path

SRC = Path("personas/jordan_rivera_base.json")
OUT = Path("personas/jordan_contact_base.json")

# --------------------------------------------------------------------------- #
# RENAME MAP (old -> new). Every key collides with Max Turnquist's world (or the
# Priya Sharma namespace) and is replaced by a fresh, distinct value. Non-
# colliding Jordan entities (Miami, Tampa, Mochi, Noor's hospital, Larkspur Pay,
# Adaeze Nwosu, Driftwood, etc.) are kept as-is.
#
# Max avoid-list (do NOT reuse for Jordan): Aerolith, Anita, Arrival, Bashir,
# Bear, Biryani, Blazers, Caltech, Cannondale, Cardoza, Catan, Chicago, Civic,
# Cobalt, Deepak, Denver, Diego, Diwali, Felix, Field, Francisco, Fridman,
# Fujifilm, Garmin, General, Halford, Hargrove, Imani, Ines, Japanese, Kyoto,
# LASIK, Labs, Lena, Lex, Lisbon, Logistics, Lumen, Mac, Magpie, Meridian, Mesa,
# Mira, Montreal, Nana, Northwind, Okafor, Outback, Overstory, Phone, Pixel,
# Portland, Powers, Priyanka, Professor, Radiohead, Raj, Richard, Rim, Robotics,
# Rose, Rust, Sam, San, Stripe, Subaru, Sunita, Synapse, Theo, ThinkPad, Trail,
# University, Vancouver, Yusuf.
# --------------------------------------------------------------------------- #

RENAMES = {
    # employer (collides Max "Meridian")
    "Meridian AI": "Cumbre AI",
    # brother (collides Max "Sam"); keep Rivera surname, Latin first name
    "Sam Rivera": "Rafael Rivera",
    "Sam": "Rafael",
    # previous city (collides Max "San"/"Francisco")
    "San Francisco": "Houston",
    "Mission District": "Montrose",  # SF neighborhood -> Houston neighborhood
    # grandmother (collides Max "Rose")
    "Abuela Rosa": "Abuela Marta",
    "Rosa": "Marta",
    # sister-in-law (Rafael's wife) — non-colliding but refresh for distinctness
    "Hana Kim": "Yuki Tanaka",
    "Hana": "Yuki",
    # where sister-in-law grew up (collides Max "Vancouver")
    "Vancouver, Canada": "Calgary, Canada",
    "Vancouver": "Calgary",
    # oldest childhood friend (collides Max "Theo" + Priya "Vance")
    "Theo Vance": "Hector Morales",
    "Theo": "Hector",
    # cat (collides Max "Pixel" phone); Latin-flavored pet name
    "Pixel the cat": "Pelusa the cat",
    "Pixel": "Pelusa",
    # phone (collides Max "Pixel")
    "Google Pixel 8": "Samsung Galaxy S24",
    "Pixel 8": "Galaxy S24",
    # camera (collides Max "Fujifilm")
    "Fujifilm X-T4": "Olympus OM-1",
    "Fujifilm": "Olympus",
    "X-T4": "OM-1",
    # watch (collides Max "Garmin")
    "Garmin Fenix": "Coros Apex",
    "Garmin": "Coros",
    # comfort movie (collides Max "Arrival")
    "Arrival": "Coherence",
    # best friend + her city (collides Max "Denver")
    "Maya Chen": "Valentina Cruz",
    "Maya": "Valentina",
    "Denver": "Phoenix",
}

# Order longest-first so multi-word values are replaced before their substrings
# (e.g. "Sam Rivera" before "Sam", "Pixel 8" before "Pixel").
_RENAME_ITEMS = sorted(RENAMES.items(), key=lambda kv: len(kv[0]), reverse=True)


def rn(text: str) -> str:
    """Apply the rename map to a string (word-boundary safe)."""
    for old, new in _RENAME_ITEMS:
        text = re.sub(rf"(?<![\w]){re.escape(old)}(?![\w])", new, text)
    return text


# The avoid-list values Max owns. After renaming, NONE of these may appear as a
# Jordan-network entity value. ("Jordan" itself is the friend's name and "Go"
# is a language Max never claims, so both are fine; we check entity values, not
# every English word — so we restrict to the distinctive proper-noun tokens.)
MAX_AVOID = [
    "Aerolith", "Anita", "Arrival", "Bashir", "Biryani", "Blazers", "Caltech",
    "Cannondale", "Cardoza", "Catan", "Chicago", "Civic", "Cobalt", "Deepak",
    "Denver", "Diego", "Diwali", "Felix", "Fridman", "Fujifilm", "Garmin",
    "Halford", "Hargrove", "Imani", "Ines", "Kyoto", "Lena", "Lisbon", "Lumen",
    "Magpie", "Meridian", "Mesa", "Mira", "Montreal", "Northwind", "Okafor",
    "Outback", "Overstory", "Pixel", "Portland", "Powers", "Priyanka",
    "Radiohead", "Subaru", "Sunita", "Synapse", "ThinkPad", "Vancouver",
    "Yusuf",
    # multi-word / phrase collisions
    "San Francisco", "Meridian AI", "Meridian General", "Nana Rose",
    "Abuela Rosa", "Pixel 8",
]
# "Vance" collides with the Priya namespace (Helena Vance) — guard it too.
PRIYA_AVOID = ["Vance"]


# --------------------------------------------------------------------------- #
# (1) SESSIONS — Max's first-person statements ABOUT his friend Jordan & network.
#     One canonical line per source fact, reframed to third person and renamed.
#     Max's natural connection: Jordan is a friend Max made through cycling /
#     the climbing world. (Stated implicitly via "my friend Jordan".)
# --------------------------------------------------------------------------- #

NEW_SESSIONS = [
    ("sess_1", [
        "My friend Jordan Rivera is a senior software engineer, and he lives in Austin, Texas.",
        "Jordan grew up in Miami but he's been in Austin for about three years now.",
        "Jordan goes to the Austin Bouldering Project pretty regularly to climb.",
        "Jordan rescued a greyhound named Mochi about a year ago.",
    ]),
    ("sess_2", [
        "Jordan works at Cumbre AI, where they're in the middle of a big Go migration.",
        "Jordan's team was a Python shop but switched to Go for the backend about six months ago.",
        "Jordan has been at Cumbre AI for two years, and he just got promoted to Senior Engineer a couple months ago.",
    ]),
    ("sess_3", [
        "Jordan's brother Rafael is a PM at Google and lives in Seattle.",
        "Jordan's parents, Elena and Carlos, live in Miami and love visiting him in Austin.",
        "Jordan's best friend is Valentina, who is in Phoenix working at Palantir; they met at PyCon 2021 in Salt Lake City.",
    ]),
    ("sess_4", [
        "Jordan has been re-reading Project Hail Mary and practices guitar in the evenings.",
        "Jordan has played acoustic guitar for about ten years, and his favorite author is Ted Chiang — he loves Story of Your Life.",
        "Jordan speaks intermediate Spanish and is saving up for a Japan trip he's planning for October.",
    ]),
    ("sess_5", [
        "Jordan's favorite food is tacos al pastor, and he raves about a spot near his office.",
        "Jordan finally bought a Specialized Diverge for gravel riding around Austin.",
    ]),
    ("sess_6", [
        "Before Cumbre AI, Jordan spent four years at a fintech startup called Larkspur Pay.",
        "At Larkspur Pay Jordan was a mid-level backend engineer, not yet senior.",
        "Jordan's manager at Cumbre AI is named Adaeze Nwosu, and she's the VP of Engineering.",
        "Adaeze Nwosu did her undergrad at Georgia Tech.",
        "Cumbre AI's headquarters is in Austin, but it was originally founded in Toronto.",
        "Jordan's team at Cumbre AI is the Recommendations team, and their main product is codenamed Driftwood.",
        "Jordan writes Go on the backend and uses React on the frontend day to day.",
    ]),
    ("sess_7", [
        "In Houston, before he moved to Austin, Jordan lived in the Montrose district.",
        "Back in Houston Jordan rented a tiny studio apartment, but in Austin he bought a small bungalow.",
        "Jordan's neighborhood in Austin is called Travis Heights, just south of the river.",
        "When Jordan lived in Houston he worked at Larkspur Pay, whose office was downtown.",
    ]),
    ("sess_8", [
        "Jordan's wife's name is Noor Haddad, and they got married four years ago.",
        "Noor is an emergency room physician at Dell Seton Medical Center in Austin.",
        "Noor grew up in Amman, Jordan, and moved to the US for medical school.",
        "Jordan and Noor met at a tango class about seven years ago.",
        "Noor is the only doctor in Jordan's family.",
    ]),
    ("sess_9", [
        "Besides his brother Rafael, Jordan has a younger sister named Lucia Rivera.",
        "Lucia is a marine biologist and works at the Monterey Bay Aquarium.",
        "Lucia lives in Monterey, California.",
        "Lucia has a daughter — Jordan's niece — named Camila, who is six.",
        "Camila is completely obsessed with sea turtles, thanks to her mom.",
        "Rafael, Jordan's brother, has a son named Mateo — Jordan's nephew — who is nine.",
        "Mateo plays in a youth soccer league and is the goalkeeper.",
    ]),
    ("sess_10", [
        "Jordan's grandmother on his dad's side, whom the family calls Abuela Marta, lives in Tampa, Florida.",
        "Abuela Marta was a seamstress who ran her own tailoring shop for decades.",
        "Rafael's wife — Jordan's sister-in-law — is named Yuki Tanaka, and she's a UX researcher at Microsoft.",
        "Yuki Tanaka grew up in Calgary, Canada.",
    ]),
    ("sess_11", [
        "Jordan's closest friend at work is a colleague named Devon Ellison.",
        "Devon Ellison is a machine learning engineer, also at Cumbre AI.",
        "Devon moved to Austin from New Orleans, where he grew up.",
        "Jordan's oldest friend from childhood is Hector Morales — they've known each other since middle school.",
        "Hector Morales is a high school chemistry teacher in Orlando, Florida.",
        "Jordan has a cycling buddy named Greta Lindqvist who races competitively.",
        "Greta Lindqvist is a veterinarian and runs her own small-animal clinic.",
    ]),
    ("sess_12", [
        "Mochi the greyhound is Jordan's only dog, but he also has a tabby cat named Pelusa.",
        "Pelusa the cat is fourteen years old — Jordan has had her since college.",
        "Those two, Mochi and Pelusa, are Jordan's only pets.",
        "Jordan drives a 2019 Toyota 4Runner that he takes camping.",
        "Jordan's everyday phone is a Samsung Galaxy S24.",
        "For photography Jordan shoots with an Olympus OM-1 mirrorless camera.",
        "Jordan wears a Coros Apex watch when he's cycling and hiking.",
    ]),
    ("sess_13", [
        "Outside of guitar, Jordan's hobbies are gravel cycling, bouldering, sea kayaking, and birdwatching.",
        "Jordan's favorite band is Khruangbin, and he's seen them live three times.",
        "Jordan's comfort movie is Coherence — fitting, since he loves Ted Chiang.",
        "Jordan's favorite video game is Hollow Knight.",
        "Jordan is a huge fan of the TV show Severance.",
        "Jordan's go-to board game is Wingspan, which pairs well with his birdwatching.",
    ]),
    ("sess_14", [
        "Jordan is allergic to shellfish, which makes coastal trips a little nerve-wracking for him.",
        "Jordan is also lactose intolerant, so he drinks his coffee with almond milk.",
        "Jordan is mildly colorblind — red-green — which his designer friends never let him forget.",
        "Jordan's favorite dessert is tres leches cake, an old family recipe from Abuela Marta.",
        "Jordan's favorite holiday is Nochebuena, Christmas Eve, when his whole family cooks together.",
        "Jordan is terrified of deep open water, which is ironic given the kayaking.",
    ]),
    ("sess_15", [
        "Jordan used to drive a Honda Element for years, but he replaced it with his Toyota 4Runner last year.",
        "Jordan's old phone was an iPhone 11, but he switched to a Samsung Galaxy S24 this spring.",
        "Jordan used to live with three roommates in Houston, but now he lives with just his wife Noor.",
        "For backend Jordan used to write Python, but he switched to Go about six months ago.",
        "Jordan used to study Portuguese in college, but these days he's focused on learning Spanish instead.",
    ]),
    ("sess_16", [
        "Jordan quit drinking coffee for years and was a strict tea person, but he went back to coffee when he started at Cumbre AI.",
        "Jordan used to use a Windows desktop for everything, but he switched to a MacBook Pro two years ago.",
        "Jordan gave up running after a knee injury and took up cycling as his main cardio instead.",
        "Jordan used to be a vegetarian, but now he just eats pescatarian — minus the shellfish he's allergic to.",
        "Jordan's main editor used to be Vim, but he moved to VS Code when he joined Cumbre AI.",
    ]),
    ("sess_17", [
        "Jordan was the best man at his brother Rafael's wedding.",
        "Jordan's blood type is O negative, so the blood bank loves him.",
        "Jordan is an early riser — he's usually up by 5:30 for a ride before work.",
        "Jordan's coffee order is a flat white with almond milk.",
        "Jordan named his dog Mochi after his favorite childhood dessert, before tres leches took over.",
        "Jordan just turned 34 this year.",
        "Jordan's best friend Valentina Cruz works as a data scientist over at Palantir in Phoenix.",
    ]),
]


# --------------------------------------------------------------------------- #
# (3) eval_questions — reframed to Max's-friend phrasing, renamed values, and
#     re-categorized by hop-distance from Max. ids keep the `jq` prefix.
#     `cat` is the NEW category for this folded world.
# --------------------------------------------------------------------------- #

def Q(qid, question, answer, cat, *keywords):
    return {
        "id": qid,
        "question": question,
        "answer": answer,
        "keywords": list(keywords) or [answer],
        "category": cat,
    }


QUESTIONS = [
    # === Jordan's OWN direct attributes: flat-recall -> relational ===========
    Q("jq01", "Where does Max's friend Jordan currently live?", "Austin, Texas", "relational", "Austin"),
    Q("jq02", "What city was Jordan born in?", "Miami, Florida", "relational", "Miami"),
    Q("jq03", "How old is Jordan?", "34", "relational", "34"),
    Q("jq04", "What company does Jordan work at?", "Cumbre AI", "relational", "Cumbre"),
    Q("jq05", "What is Jordan's job title?", "Senior Software Engineer", "relational", "Senior Software Engineer", "senior"),
    Q("jq06", "What is the name of Jordan's dog?", "Mochi", "relational", "Mochi"),
    Q("jq07", "What breed is Jordan's dog?", "a greyhound", "relational", "greyhound"),
    Q("jq08", "What is the name of Jordan's cat?", "Pelusa", "relational", "Pelusa"),
    Q("jq09", "What instrument does Jordan play?", "acoustic guitar", "relational", "guitar"),
    Q("jq10", "Who is Jordan's favorite author?", "Ted Chiang", "relational", "Ted Chiang", "Chiang"),
    Q("jq11", "What is Jordan's favorite food?", "tacos al pastor", "relational", "tacos", "al pastor"),
    Q("jq12", "What book has Jordan been reading?", "Project Hail Mary", "relational", "Project Hail Mary", "Hail Mary"),
    Q("jq13", "What kind of bike does Jordan own?", "a Specialized Diverge gravel bike", "relational", "Specialized", "Diverge"),
    Q("jq14", "What programming language does Jordan use for the backend now?", "Go", "relational", "Go"),
    Q("jq15", "What does Jordan use for frontend development?", "React", "relational", "React"),
    Q("jq16", "What is the codename of Jordan's team's main product?", "Driftwood", "relational", "Driftwood"),
    Q("jq17", "What team does Jordan work on at Cumbre AI?", "the Recommendations team", "relational", "Recommendations"),
    Q("jq18", "What neighborhood does Jordan live in in Austin?", "Travis Heights", "relational", "Travis Heights"),
    Q("jq19", "What kind of home does Jordan own in Austin?", "a small bungalow", "relational", "bungalow"),
    Q("jq20", "What car does Jordan currently drive?", "a 2019 Toyota 4Runner", "relational", "4Runner", "Toyota"),
    Q("jq21", "What phone does Jordan currently use?", "a Samsung Galaxy S24", "relational", "Galaxy S24"),
    Q("jq22", "What camera does Jordan use for photography?", "an Olympus OM-1", "relational", "Olympus", "OM-1"),
    Q("jq23", "What brand of watch does Jordan wear?", "a Coros Apex", "relational", "Coros"),
    Q("jq24", "What is Jordan allergic to?", "shellfish", "relational", "shellfish"),
    Q("jq25", "What is Jordan's favorite dessert?", "tres leches cake", "relational", "tres leches"),
    Q("jq26", "What is Jordan's favorite holiday?", "Nochebuena", "relational", "Nochebuena"),
    Q("jq27", "What is Jordan's favorite band?", "Khruangbin", "relational", "Khruangbin"),
    Q("jq28", "What is Jordan's comfort movie?", "Coherence", "relational", "Coherence"),
    Q("jq29", "What is Jordan's favorite video game?", "Hollow Knight", "relational", "Hollow Knight"),
    Q("jq30", "What TV show is Jordan a big fan of?", "Severance", "relational", "Severance"),
    Q("jq31", "What is Jordan's go-to board game?", "Wingspan", "relational", "Wingspan"),
    Q("jq32", "What is Jordan's blood type?", "O negative", "relational", "O negative", "O-"),
    Q("jq33", "What is Jordan's coffee order?", "a flat white with almond milk", "relational", "flat white"),
    Q("jq34", "What is Jordan's favorite Ted Chiang story?", "Story of Your Life", "relational", "Story of Your Life"),

    # === Jordan's 1-hop relations: relational -> multi-hop ===================
    Q("jq35", "What is the name of Jordan's wife?", "Noor Haddad", "multi-hop", "Noor"),
    Q("jq36", "What is the name of Jordan's brother?", "Rafael Rivera", "multi-hop", "Rafael"),
    Q("jq37", "What is the name of Jordan's sister?", "Lucia Rivera", "multi-hop", "Lucia"),
    Q("jq38", "What are the names of Jordan's parents?", "Elena and Carlos", "multi-hop", "Elena", "Carlos"),
    Q("jq39", "What is the name of Jordan's grandmother?", "Abuela Marta", "multi-hop", "Marta"),
    Q("jq40", "What is the name of Jordan's niece?", "Camila", "multi-hop", "Camila"),
    Q("jq41", "What is the name of Jordan's nephew?", "Mateo", "multi-hop", "Mateo"),
    Q("jq42", "What is the name of Jordan's sister-in-law?", "Yuki Tanaka", "multi-hop", "Yuki"),
    Q("jq43", "Who is Jordan's best friend?", "Valentina Cruz", "multi-hop", "Valentina"),
    Q("jq44", "Who is Jordan's closest friend at work?", "Devon Ellison", "multi-hop", "Devon"),
    Q("jq45", "Who is Jordan's oldest childhood friend?", "Hector Morales", "multi-hop", "Hector"),
    Q("jq46", "Who is Jordan's cycling buddy?", "Greta Lindqvist", "multi-hop", "Greta"),
    Q("jq47", "Who is Jordan's manager at Cumbre AI?", "Adaeze Nwosu", "multi-hop", "Adaeze Nwosu", "Nwosu"),
    Q("jq48", "Where does Jordan's brother Rafael live?", "Seattle", "multi-hop", "Seattle"),
    Q("jq49", "Where does Jordan's sister Lucia live?", "Monterey, California", "multi-hop", "Monterey"),
    Q("jq50", "Where do Jordan's parents live?", "Miami, Florida", "multi-hop", "Miami"),
    Q("jq51", "What company does Jordan's best friend Valentina work at?", "Palantir", "multi-hop", "Palantir"),
    Q("jq52", "What city does Jordan's best friend Valentina live in?", "Phoenix", "multi-hop", "Phoenix"),
    Q("jq53", "What does Jordan's brother Rafael do for work?", "a product manager at Google", "multi-hop", "product manager", "Google"),
    Q("jq54", "What is the profession of Jordan's wife Noor?", "an emergency room physician", "multi-hop", "physician", "ER", "emergency"),
    Q("jq55", "Where did Jordan meet his best friend Valentina?", "at PyCon 2021 in Salt Lake City", "multi-hop", "PyCon", "Salt Lake City"),
    Q("jq56", "Where did Jordan meet his wife Noor?", "at a tango class", "multi-hop", "tango"),
    Q("jq57", "In what city is Jordan's employer Cumbre AI headquartered?", "Austin", "multi-hop", "Austin"),
    Q("jq58", "Who was the best man at Rafael's wedding?", "Jordan", "multi-hop", "best man"),

    # === Jordan's 2-hop relations: multi-hop (kept) ==========================
    Q("jq59", "What does Jordan's sister do for work?", "a marine biologist", "multi-hop", "marine biologist"),
    Q("jq60", "Where does Jordan's sister work?", "the Monterey Bay Aquarium", "multi-hop", "Monterey Bay Aquarium"),
    Q("jq61", "What is Jordan's niece obsessed with?", "sea turtles", "multi-hop", "sea turtles"),
    Q("jq62", "What sport does Jordan's nephew play?", "soccer", "multi-hop", "soccer"),
    Q("jq63", "What position does Jordan's nephew play in soccer?", "goalkeeper", "multi-hop", "goalkeeper"),
    Q("jq64", "What hospital does Jordan's wife work at?", "Dell Seton Medical Center", "multi-hop", "Dell Seton"),
    Q("jq65", "What city did Jordan's wife grow up in?", "Amman, Jordan", "multi-hop", "Amman"),
    Q("jq66", "What was Jordan's grandmother's profession?", "a seamstress", "multi-hop", "seamstress"),
    Q("jq67", "What city does Jordan's grandmother live in?", "Tampa, Florida", "multi-hop", "Tampa"),
    Q("jq68", "What company does Jordan's sister-in-law work at?", "Microsoft", "multi-hop", "Microsoft"),
    Q("jq69", "What is Jordan's sister-in-law's profession?", "a UX researcher", "multi-hop", "UX researcher"),
    Q("jq70", "Where did Jordan's sister-in-law grow up?", "Calgary, Canada", "multi-hop", "Calgary"),
    Q("jq71", "What is the profession of Jordan's coworker Devon?", "a machine learning engineer", "multi-hop", "machine learning engineer", "ML engineer"),
    Q("jq72", "Where did Jordan's coworker Devon grow up?", "New Orleans", "multi-hop", "New Orleans"),
    Q("jq73", "What does Jordan's childhood friend Hector do for work?", "a high school chemistry teacher", "multi-hop", "chemistry teacher"),
    Q("jq74", "What city does Jordan's childhood friend Hector live in?", "Orlando, Florida", "multi-hop", "Orlando"),
    Q("jq75", "What is the profession of Jordan's cycling buddy Greta?", "a veterinarian", "multi-hop", "veterinarian", "vet"),
    Q("jq76", "What is the job title of Jordan's manager Adaeze Nwosu?", "VP of Engineering", "multi-hop", "VP of Engineering", "VP"),
    Q("jq77", "Where did Jordan's manager Adaeze Nwosu do her undergrad?", "Georgia Tech", "multi-hop", "Georgia Tech"),
    Q("jq78", "In what city was Jordan's employer Cumbre AI originally founded?", "Toronto", "multi-hop", "Toronto"),
    Q("jq79", "What does Jordan's best friend Valentina do for work?", "a data scientist", "multi-hop", "data scientist"),
    Q("jq80", "Which aquarium does Jordan's niece's mother work at?", "the Monterey Bay Aquarium", "multi-hop", "Monterey Bay Aquarium"),
    Q("jq81", "What dessert recipe did Jordan's grandmother pass down?", "tres leches cake", "multi-hop", "tres leches"),
    Q("jq82", "What did Jordan's grandmother run for decades?", "her own tailoring shop", "multi-hop", "tailoring shop"),

    # === temporal-update (KEPT; values updated) ==============================
    Q("jq83", "What city does Jordan currently live in?", "Austin", "temporal-update", "Austin"),
    Q("jq84", "What city did Jordan live in before Austin?", "Houston", "temporal-update", "Houston"),
    Q("jq85", "What company does Jordan currently work for?", "Cumbre AI", "temporal-update", "Cumbre"),
    Q("jq86", "What company did Jordan work for before Cumbre AI?", "Larkspur Pay", "temporal-update", "Larkspur"),
    Q("jq87", "What language does Jordan use for backend work now?", "Go", "temporal-update", "Go"),
    Q("jq88", "What language did Jordan use for backend work before switching?", "Python", "temporal-update", "Python"),
    Q("jq89", "What car does Jordan currently drive?", "a Toyota 4Runner", "temporal-update", "4Runner"),
    Q("jq90", "What car did Jordan drive before his current one?", "a Honda Element", "temporal-update", "Honda Element"),
    Q("jq91", "What phone does Jordan use now?", "a Samsung Galaxy S24", "temporal-update", "Galaxy S24"),
    Q("jq92", "What phone did Jordan use before his current one?", "an iPhone 11", "temporal-update", "iPhone 11"),
    Q("jq93", "Who does Jordan currently live with?", "his wife Noor", "temporal-update", "Noor"),
    Q("jq94", "Who did Jordan live with before, in Houston?", "three roommates", "temporal-update", "roommates"),
    Q("jq95", "What language is Jordan learning now?", "Spanish", "temporal-update", "Spanish"),
    Q("jq96", "What language did Jordan study in college before Spanish?", "Portuguese", "temporal-update", "Portuguese"),
    Q("jq97", "What computer does Jordan use now?", "a MacBook Pro", "temporal-update", "MacBook"),
    Q("jq98", "What computer did Jordan use before his MacBook?", "a Windows desktop", "temporal-update", "Windows"),
    Q("jq99", "What code editor does Jordan use now?", "VS Code", "temporal-update", "VS Code"),
    Q("jq100", "What code editor did Jordan use before VS Code?", "Vim", "temporal-update", "Vim"),
    Q("jq101", "What is Jordan's main form of cardio now?", "cycling", "temporal-update", "cycling"),
    Q("jq102", "What cardio did Jordan do before he gave it up for cycling?", "running", "temporal-update", "running"),
    Q("jq103", "What is Jordan's current diet?", "pescatarian", "temporal-update", "pescatarian"),
    Q("jq104", "What diet did Jordan follow before going pescatarian?", "vegetarian", "temporal-update", "vegetarian"),
    Q("jq105", "What is Jordan's current job title?", "Senior Software Engineer", "temporal-update", "Senior"),
    Q("jq106", "What does Jordan drink in the morning now, after switching back at Cumbre AI?", "coffee", "temporal-update", "coffee"),

    # === enumeration (KEPT; values updated) ==================================
    Q("jq107", "List all of Jordan's pets.", "Mochi (a greyhound) and Pelusa (a cat)", "enumeration", "Mochi", "Pelusa"),
    Q("jq108", "Name all of Jordan's siblings.", "Rafael and Lucia", "enumeration", "Rafael", "Lucia"),
    Q("jq109", "List all the cities Jordan has lived in.", "Miami, Houston, and Austin", "enumeration", "Miami", "Houston", "Austin"),
    Q("jq110", "Name every company Jordan has worked for.", "Larkspur Pay and Cumbre AI", "enumeration", "Larkspur", "Cumbre"),
    Q("jq111", "List all of Jordan's hobbies.", "gravel cycling, bouldering, sea kayaking, birdwatching, and playing guitar", "enumeration", "cycling", "bouldering", "kayaking", "birdwatching", "guitar"),
    Q("jq112", "What are all of Jordan's named friends?", "Valentina Cruz, Devon Ellison, Hector Morales, and Greta Lindqvist", "enumeration", "Valentina", "Devon", "Hector", "Greta"),
    Q("jq113", "List the things Jordan is allergic to or intolerant of.", "shellfish (allergy) and lactose (intolerance)", "enumeration", "shellfish", "lactose"),
    Q("jq114", "Name Jordan's wife and his two siblings.", "his wife Noor, brother Rafael, and sister Lucia", "enumeration", "Noor", "Rafael", "Lucia"),
    Q("jq115", "List Jordan's niece and nephew.", "Camila (niece) and Mateo (nephew)", "enumeration", "Camila", "Mateo"),
    Q("jq116", "What devices and gadgets does Jordan own?", "a Samsung Galaxy S24 phone, an Olympus OM-1 camera, a Coros Apex watch, and a MacBook Pro", "enumeration", "Galaxy S24", "Olympus", "Coros", "MacBook"),
    Q("jq117", "Name all the parents and grandparents Jordan has mentioned.", "his parents Elena and Carlos and his grandmother Abuela Marta", "enumeration", "Elena", "Carlos", "Marta"),
    Q("jq118", "List all of Jordan's favorite media (band, movie, game, show, board game).", "band Khruangbin, movie Coherence, video game Hollow Knight, TV show Severance, and board game Wingspan", "enumeration", "Khruangbin", "Coherence", "Hollow Knight", "Severance", "Wingspan"),

    # === aggregation (KEPT; values updated) ==================================
    Q("jq119", "How many siblings does Jordan have?", "two (Rafael and Lucia)", "aggregation", "two", "2"),
    Q("jq120", "How many pets does Jordan have?", "two (a dog, Mochi, and a cat, Pelusa)", "aggregation", "two", "2"),
    Q("jq121", "How many cities has Jordan lived in?", "three (Miami, Houston, and Austin)", "aggregation", "three", "3"),
    Q("jq122", "How many companies has Jordan worked for?", "two (Larkspur Pay and Cumbre AI)", "aggregation", "two", "2"),
    Q("jq123", "Which member of Jordan's family is a doctor?", "his wife Noor, an ER physician", "aggregation", "Noor"),
    Q("jq124", "Which of Jordan's relatives is a marine biologist?", "his sister Lucia", "aggregation", "Lucia"),
    Q("jq125", "How many of Jordan's named friends work as a veterinarian?", "one (Greta Lindqvist)", "aggregation", "one", "1", "Greta"),
    Q("jq126", "How many children do Jordan's siblings have in total?", "two (Camila and Mateo)", "aggregation", "two", "2"),

    # === absence (KEPT; reworded to Max's third-person voice) ================
    Q("jq127", "Does Jordan have a pet bird?", "No — Jordan's only pets are a dog (Mochi) and a cat (Pelusa). He enjoys birdwatching, but owns no bird.", "absence", "no"),
    Q("jq128", "Does Jordan have a third sibling?", "No — Jordan has exactly two siblings, his brother Rafael and his sister Lucia.", "absence", "no"),
    Q("jq129", "Does Jordan work at Palantir?", "No — Jordan works at Cumbre AI. Palantir is where his best friend Valentina Cruz works.", "absence", "no"),
    Q("jq130", "Is Jordan a doctor?", "No — Jordan is a software engineer. His wife Noor is the doctor (an ER physician).", "absence", "no"),
    Q("jq131", "Does Jordan have any children of his own?", "No — Jordan has a niece (Camila) and a nephew (Mateo), but no children of his own.", "absence", "no"),
    Q("jq132", "Has Jordan ever worked at Google?", "No — Jordan has worked at Larkspur Pay and Cumbre AI. His brother Rafael is the one at Google.", "absence", "no"),
    Q("jq133", "Does Jordan currently live in Houston?", "No — Jordan moved to Austin three years ago. He lived in Houston before that, not now.", "absence", "no"),
    Q("jq134", "Is Jordan a veterinarian?", "No — Jordan is a software engineer. His cycling buddy Greta Lindqvist is the veterinarian.", "absence", "no"),
    Q("jq135", "Does Jordan currently use an iPhone?", "No — Jordan now uses a Samsung Galaxy S24. He used an iPhone 11 before, but switched this spring.", "absence", "no"),
    Q("jq136", "Does Jordan play the piano?", "No — Jordan plays acoustic guitar, not piano.", "absence", "no"),
    Q("jq137", "Does Jordan still write Python for the backend?", "No — Jordan switched from Python to Go about six months ago.", "absence", "no"),
    Q("jq138", "Is Jordan currently a vegetarian?", "No — Jordan used to be vegetarian but is now pescatarian.", "absence", "no"),
    Q("jq139", "Does Jordan live in Phoenix?", "No — Jordan lives in Austin. Phoenix is where his best friend Valentina Cruz lives.", "absence", "no"),
    Q("jq140", "Is Jordan allergic to peanuts?", "No — Jordan is allergic to shellfish (and lactose intolerant), but not peanuts.", "absence", "no"),
    Q("jq141", "Does Jordan have a sister named Yuki?", "No — Jordan's sister is Lucia. Yuki Tanaka is his sister-in-law (his brother Rafael's wife).", "absence", "no"),
    Q("jq142", "Does Jordan use Vim as his code editor now?", "No — Jordan switched from Vim to VS Code when he joined Cumbre AI.", "absence", "no"),

    # === presence-control (KEPT; reworded to Max's third-person voice) =======
    Q("jq143", "Does Jordan have a sister?", "Yes — his sister Lucia, a marine biologist.", "presence-control", "yes", "Lucia"),
    Q("jq144", "Does Jordan own a cat?", "Yes — a tabby cat named Pelusa.", "presence-control", "yes", "Pelusa"),
    Q("jq145", "Is Jordan married?", "Yes — to his wife Noor Haddad.", "presence-control", "yes", "Noor"),
    Q("jq146", "Does Jordan play a musical instrument?", "Yes — acoustic guitar.", "presence-control", "yes", "guitar"),
    Q("jq147", "Does Jordan have a nephew?", "Yes — his nephew Mateo.", "presence-control", "yes", "Mateo"),
    Q("jq148", "Does Jordan work at Cumbre AI?", "Yes — as a Senior Software Engineer on the Recommendations team.", "presence-control", "yes", "Cumbre"),
    Q("jq149", "Has Jordan lived in Austin?", "Yes — he currently lives in Austin.", "presence-control", "yes", "Austin"),
    Q("jq150", "Does Jordan own a dog?", "Yes — a rescue greyhound named Mochi.", "presence-control", "yes", "Mochi"),
]


# --------------------------------------------------------------------------- #
# build + self-validation
# --------------------------------------------------------------------------- #

def main() -> None:
    base = {
        "_comment": (
            "Jordan Rivera folded into the single-user benchmark world as Max "
            "Turnquist's FRIEND. All sessions are Max's first-person statements "
            "ABOUT Jordan and his sub-network (third person). Built by "
            "build_jordan_contact.py from personas/jordan_rivera_base.json: "
            "first-person -> Max-about-Jordan reframing, full collision rename "
            "(distinct from Max and Priya namespaces), and re-categorization by "
            "hop-distance from Max (Jordan = 1 hop). Canonical facts only; run "
            "generate_large_persona.py to bury under distractor noise."
        ),
        "persona_id": "jordan_contact",
        "name": "Jordan Rivera (Max's friend)",
        "description": (
            "Jordan Rivera as a contact in Max Turnquist's world — Max's friend, "
            "described entirely in Max's third-person statements. Dense "
            "entity/relationship graph (Jordan's wife, parents, siblings, niece/"
            "nephew, grandmother, friends, colleagues, manager, pets, "
            "possessions, media tastes, allergies, job history, temporal "
            "updates). Renamed to avoid all collisions with Max's and Priya "
            "Sharma's value spaces."
        ),
        "sessions": [
            {"id": sid, "messages": [{"role": "user", "content": c} for c in msgs]}
            for sid, msgs in NEW_SESSIONS
        ],
        "eval_questions": QUESTIONS,
    }

    # ---- self-validation ----------------------------------------------------
    ids = [q["id"] for q in QUESTIONS]
    assert len(ids) == len(set(ids)), f"duplicate question ids: {[i for i in ids if ids.count(i) > 1]}"

    canon = "\n".join(
        m["content"] for s in base["sessions"] for m in s["messages"] if m["role"] == "user"
    )
    canon_lower = canon.lower()

    # Every non-absence/presence question must be grounded: at least one keyword
    # present (case-insensitive) in the concatenated canonical statements.
    grounding_failures = []
    for q in QUESTIONS:
        if q["category"] in ("absence", "presence-control"):
            continue
        if not any(kw.lower() in canon_lower for kw in q["keywords"]):
            grounding_failures.append((q["id"], q["keywords"]))
    assert not grounding_failures, f"grounding failures: {grounding_failures}"

    # None of Max's avoid-list names (nor Priya's "Vance") may appear as a
    # Jordan-entity value — check canonical statements and all answers/keywords.
    haystack = canon + "\n" + "\n".join(
        q["answer"] + " " + " ".join(q["keywords"]) for q in QUESTIONS
    )
    collisions = []
    for name in MAX_AVOID + PRIYA_AVOID:
        if re.search(rf"(?<![\w]){re.escape(name)}(?![\w])", haystack):
            collisions.append(name)
    assert not collisions, f"avoid-list collisions found: {collisions}"

    OUT.write_text(json.dumps(base, indent=2, ensure_ascii=False), encoding="utf-8")

    # ---- report ------------------------------------------------------------
    cats = Counter(q["category"] for q in QUESTIONS)
    canon_msgs = sum(
        1 for s in base["sessions"] for m in s["messages"] if m["role"] == "user"
    )
    print(f"Wrote {OUT}")
    print(f"  questions: {len(QUESTIONS)}  by category:")
    for c in ("relational", "multi-hop", "temporal-update", "enumeration",
              "aggregation", "absence", "presence-control"):
        print(f"      {c:18s}: {cats.get(c, 0)}")
    print(f"  canonical sessions: {len(base['sessions'])}  canonical user-msgs: {canon_msgs}")
    print("  grounding failures: 0   avoid-list collisions: 0")


if __name__ == "__main__":
    main()
