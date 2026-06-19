#!/usr/bin/env python3
"""
Build the FULL Jordan Rivera BASE persona (canonical facts only — no distractors).

Fleshes out the thin seed in personas/jordan_rivera.json into a dense, coherent
person (~90 canonical facts): profession + employer history, a home-city move,
a full family tree (parents, siblings, spouse, niece/nephew, grandparent, in-law)
with per-person attributes for multi-hop, friends/colleagues each with their own
job/employer/city, pets, hobbies, possessions, media tastes, allergies/quirks,
and several before/after temporal updates.

EVERY fact already in jordan_rivera.json is preserved and kept consistent:
  Austin TX (current, moved from San Francisco 3y ago); born Miami FL, age 34;
  Senior Software Engineer at Meridian AI (promoted 2mo ago); dog Mochi (rescue
  greyhound, 1y); best friend Maya Chen (data scientist, Denver, Palantir, met
  PyCon 2021 Salt Lake City); brother Sam Rivera (PM at Google, Seattle); parents
  Elena & Carlos (Miami); Austin Bouldering Project; acoustic guitar 10y; Ted
  Chiang / Story of Your Life; Specialized Diverge gravel bike; Go backend /
  React frontend (switched from Python ~6mo ago); Japan trip in October; reading
  Project Hail Mary; tacos al pastor; learning Spanish (intermediate).

Names/values are chosen to NOT collide with: Max Turnquist's world, Priya
Sharma's world, OR the distractor pools in generate_large_persona.py (so adding
distractors later never breaks grounding). Jordan's texture is Cuban-American
(Miami roots), music + cycling + outdoors flavored — distinct from Priya (Indian
robotics) and Max (climbing/robotics).

Output: personas/jordan_rivera_base.json  (a BASE; run generate_large_persona.py
on it to bury the facts under distractor noise — do NOT run that here).
"""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

SEED = Path("personas/jordan_rivera.json")
OUT = Path("personas/jordan_rivera_base.json")

# --------------------------------------------------------------------------- #
# Canonical fact sessions: first-person Jordan statements ONLY.
# Every gold answer below is supported by exactly one of these lines (for
# enumeration, by a complete bounded set of them).
#
# The seed's sess_1..sess_5 (with their facts) are reused verbatim from the
# JSON; these sessions ADD the new density. Each new session is a thematic
# cluster so facts read naturally.
# --------------------------------------------------------------------------- #

NEW_SESSIONS = [
    # --- Employer / job history (employer change over time) ----------------- #
    ("sess_6", [
        "Before Meridian AI, I spent four years at a fintech startup called Larkspur Pay.",
        "At Larkspur Pay I was a mid-level backend engineer, not yet senior.",
        "My manager at Meridian AI is named Adaeze Nwosu, and she's the VP of Engineering.",
        "Adaeze Nwosu did her undergrad at Georgia Tech.",
        "Meridian AI's headquarters is in Austin, but it was originally founded in Toronto.",
        "My team at Meridian AI is the Recommendations team, and our main product is codenamed Driftwood.",
        "I write Go on the backend and use React on the frontend day to day.",
    ]),
    # --- Home-city move detail (already: SF -> Austin 3y ago) --------------- #
    ("sess_7", [
        "In San Francisco, before I moved to Austin, I lived in the Mission District.",
        "Back in San Francisco I rented a tiny studio apartment, but here in Austin I bought a small bungalow.",
        "My neighborhood in Austin is called Travis Heights, just south of the river.",
        "When I lived in San Francisco I worked at Larkspur Pay, whose office was downtown.",
    ]),
    # --- Family tree: spouse + sister + nephew, each with own attributes ----- #
    ("sess_8", [
        "My wife's name is Noor Haddad, and we got married four years ago.",
        "Noor is an emergency room physician at Dell Seton Medical Center here in Austin.",
        "Noor grew up in Amman, Jordan, and moved to the US for medical school.",
        "Noor and I met at a tango class about seven years ago.",
        "Noor is the only doctor in our family.",
    ]),
    ("sess_9", [
        "Besides my brother Sam, I have a younger sister named Lucia Rivera.",
        "Lucia is a marine biologist and works at the Monterey Bay Aquarium.",
        "Lucia lives in Monterey, California.",
        "Lucia has a daughter — my niece — named Camila, who is six.",
        "Camila is completely obsessed with sea turtles, thanks to her mom.",
        "Sam, my brother, has a son named Mateo, my nephew, who is nine.",
        "Mateo plays in a youth soccer league and is the goalkeeper.",
    ]),
    # --- Grandparent + in-law branch ---------------------------------------- #
    ("sess_10", [
        "My grandmother on my dad's side, whom we call Abuela Rosa, lives in Tampa, Florida.",
        "Abuela Rosa was a seamstress who ran her own tailoring shop for decades.",
        "Sam's wife — my sister-in-law — is named Hana Kim, and she's a UX researcher at Microsoft.",
        "Hana Kim grew up in Vancouver, Canada.",
    ]),
    # --- Friends & colleagues, each with own job/employer/city -------------- #
    ("sess_11", [
        "My closest friend at work is a colleague named Devon Ellison.",
        "Devon Ellison is a machine learning engineer, also at Meridian AI.",
        "Devon moved to Austin from New Orleans, where he grew up.",
        "My oldest friend from childhood is Theo Vance — we've known each other since middle school.",
        "Theo Vance is a high school chemistry teacher in Orlando, Florida.",
        "I have a cycling buddy named Greta Lindqvist who races competitively.",
        "Greta Lindqvist is a veterinarian and runs her own small-animal clinic.",
    ]),
    # --- Pets (complete bounded set), more possessions ---------------------- #
    ("sess_12", [
        "Mochi the greyhound is my only dog, but I also have a tabby cat named Pixel.",
        "Pixel the cat is fourteen years old — I've had her since college.",
        "Those two, Mochi and Pixel, are my only pets.",
        "I drive a 2019 Toyota 4Runner that I take camping.",
        "My everyday phone is a Google Pixel 8.",
        "For photography I shoot with a Fujifilm X-T4 mirrorless camera.",
        "I wear a Garmin Fenix watch when I'm cycling and hiking.",
    ]),
    # --- Hobbies, media tastes (complete-ish hobby set), quirks ------------- #
    ("sess_13", [
        "Outside of guitar, my hobbies are gravel cycling, bouldering, sea kayaking, and birdwatching.",
        "My favorite band is Khruangbin, and I've seen them live three times.",
        "My comfort movie is Arrival — fitting, since I love Ted Chiang.",
        "My favorite video game is Hollow Knight.",
        "I'm a huge fan of the TV show Severance.",
        "My go-to board game is Wingspan, which pairs well with my birdwatching.",
    ]),
    # --- Allergies / quirks / preferences ----------------------------------- #
    ("sess_14", [
        "I'm allergic to shellfish, which makes coastal trips a little nerve-wracking.",
        "I'm also lactose intolerant, so I drink my coffee with almond milk.",
        "I'm mildly colorblind — red-green — which my designer friends never let me forget.",
        "My favorite dessert is tres leches cake, an old family recipe from Abuela Rosa.",
        "My favorite holiday is Nochebuena, Christmas Eve, when the whole family cooks together.",
        "I'm terrified of deep open water, which is ironic given the kayaking.",
    ]),
    # --- Temporal updates: BEFORE -> AFTER pairs ---------------------------- #
    ("sess_15", [
        "I used to drive a Honda Element for years, but I replaced it with my Toyota 4Runner last year.",
        "My old phone was an iPhone 11, but I switched to a Google Pixel 8 this spring.",
        "I used to live with three roommates in San Francisco, but now I live with just my wife Noor.",
        "For backend I used to write Python, but I switched to Go about six months ago.",
        "I used to study Portuguese in college, but these days I'm focused on learning Spanish instead.",
    ]),
    ("sess_16", [
        "I quit drinking coffee for years and was a strict tea person, but I went back to coffee when I started at Meridian AI.",
        "I used to use a Windows desktop for everything, but I switched to a MacBook Pro two years ago.",
        "I gave up running after a knee injury and took up cycling as my main cardio instead.",
        "I used to be a vegetarian, but now I just eat pescatarian — well, minus the shellfish I'm allergic to.",
        "My main editor used to be Vim, but I moved to VS Code when I joined Meridian AI.",
    ]),
    # --- A few more flat facts to round him out ----------------------------- #
    ("sess_17", [
        "I was the best man at my brother Sam's wedding.",
        "My blood type is O negative, so the blood bank loves me.",
        "I'm an early riser — I'm usually up by 5:30 for a ride before work.",
        "My coffee order is a flat white with almond milk.",
        "I named my dog Mochi after my favorite dessert as a kid, before tres leches took over.",
        "I just turned 34 this year, which somehow feels older than it should.",
        "My best friend Maya Chen works as a data scientist over at Palantir in Denver.",
    ]),
]


# --------------------------------------------------------------------------- #
# Eval questions. "jq" prefix so ids never collide with Max ("q"/"s"/"n") or
# Priya ("pq").
# --------------------------------------------------------------------------- #

def Q(i, question, answer, category, *keywords):
    return {"id": f"jq{i:02d}", "question": question, "answer": answer,
            "keywords": list(keywords) or [answer], "category": category}


QUESTIONS = [
    # ===================================================================== #
    # FLAT-RECALL (34) — direct attributes of Jordan
    # ===================================================================== #
    Q(1,  "Where does Jordan currently live?", "Austin, Texas", "flat-recall", "Austin"),
    Q(2,  "What city was Jordan born in?", "Miami, Florida", "flat-recall", "Miami"),
    Q(3,  "How old is Jordan?", "34", "flat-recall", "34"),
    Q(4,  "What company does Jordan work at?", "Meridian AI", "flat-recall", "Meridian"),
    Q(5,  "What is Jordan's job title?", "Senior Software Engineer", "flat-recall", "Senior Software Engineer", "senior"),
    Q(6,  "What is the name of Jordan's dog?", "Mochi", "flat-recall", "Mochi"),
    Q(7,  "What breed is Jordan's dog?", "a greyhound", "flat-recall", "greyhound"),
    Q(8,  "What is the name of Jordan's cat?", "Pixel", "flat-recall", "Pixel"),
    Q(9,  "What instrument does Jordan play?", "acoustic guitar", "flat-recall", "guitar"),
    Q(10, "Who is Jordan's favorite author?", "Ted Chiang", "flat-recall", "Ted Chiang", "Chiang"),
    Q(11, "What is Jordan's favorite food?", "tacos al pastor", "flat-recall", "tacos", "al pastor"),
    Q(12, "What book is Jordan currently reading?", "Project Hail Mary", "flat-recall", "Project Hail Mary", "Hail Mary"),
    Q(13, "What kind of bike does Jordan own?", "a Specialized Diverge gravel bike", "flat-recall", "Specialized", "Diverge"),
    Q(14, "What programming language does Jordan use for the backend now?", "Go", "flat-recall", "Go"),
    Q(15, "What does Jordan use for frontend development?", "React", "flat-recall", "React"),
    Q(16, "What is the codename of Jordan's team's main product?", "Driftwood", "flat-recall", "Driftwood"),
    Q(17, "What team does Jordan work on at Meridian AI?", "the Recommendations team", "flat-recall", "Recommendations"),
    Q(18, "What neighborhood does Jordan live in in Austin?", "Travis Heights", "flat-recall", "Travis Heights"),
    Q(19, "What kind of home does Jordan own in Austin?", "a small bungalow", "flat-recall", "bungalow"),
    Q(20, "What car does Jordan currently drive?", "a 2019 Toyota 4Runner", "flat-recall", "4Runner", "Toyota"),
    Q(21, "What phone does Jordan currently use?", "a Google Pixel 8", "flat-recall", "Pixel 8"),
    Q(22, "What camera does Jordan use for photography?", "a Fujifilm X-T4", "flat-recall", "Fujifilm", "X-T4"),
    Q(23, "What brand of watch does Jordan wear?", "a Garmin Fenix", "flat-recall", "Garmin"),
    Q(24, "What is Jordan allergic to?", "shellfish", "flat-recall", "shellfish"),
    Q(25, "What is Jordan's favorite dessert?", "tres leches cake", "flat-recall", "tres leches"),
    Q(26, "What is Jordan's favorite holiday?", "Nochebuena", "flat-recall", "Nochebuena"),
    Q(27, "What is Jordan's favorite band?", "Khruangbin", "flat-recall", "Khruangbin"),
    Q(28, "What is Jordan's comfort movie?", "Arrival", "flat-recall", "Arrival"),
    Q(29, "What is Jordan's favorite video game?", "Hollow Knight", "flat-recall", "Hollow Knight"),
    Q(30, "What TV show is Jordan a big fan of?", "Severance", "flat-recall", "Severance"),
    Q(31, "What is Jordan's go-to board game?", "Wingspan", "flat-recall", "Wingspan"),
    Q(32, "What is Jordan's blood type?", "O negative", "flat-recall", "O negative", "O-"),
    Q(33, "What is Jordan's coffee order?", "a flat white with almond milk", "flat-recall", "flat white"),
    Q(34, "What is Jordan's favorite Ted Chiang story?", "Story of Your Life", "flat-recall", "Story of Your Life"),

    # ===================================================================== #
    # RELATIONAL (24) — one hop from Jordan, or a named relation's direct attr
    # ===================================================================== #
    Q(35, "What is the name of Jordan's wife?", "Noor Haddad", "relational", "Noor"),
    Q(36, "What is the name of Jordan's brother?", "Sam Rivera", "relational", "Sam"),
    Q(37, "What is the name of Jordan's sister?", "Lucia Rivera", "relational", "Lucia"),
    Q(38, "What are the names of Jordan's parents?", "Elena and Carlos", "relational", "Elena", "Carlos"),
    Q(39, "What is the name of Jordan's grandmother?", "Abuela Rosa", "relational", "Rosa"),
    Q(40, "What is the name of Jordan's niece?", "Camila", "relational", "Camila"),
    Q(41, "What is the name of Jordan's nephew?", "Mateo", "relational", "Mateo"),
    Q(42, "What is the name of Jordan's sister-in-law?", "Hana Kim", "relational", "Hana"),
    Q(43, "Who is Jordan's best friend?", "Maya Chen", "relational", "Maya"),
    Q(44, "Who is Jordan's closest friend at work?", "Devon Ellison", "relational", "Devon"),
    Q(45, "Who is Jordan's oldest childhood friend?", "Theo Vance", "relational", "Theo"),
    Q(46, "Who is Jordan's cycling buddy?", "Greta Lindqvist", "relational", "Greta"),
    Q(47, "Who is Jordan's manager at Meridian AI?", "Adaeze Nwosu", "relational", "Adaeze Nwosu", "Nwosu"),
    Q(48, "Where does Jordan's brother Sam live?", "Seattle", "relational", "Seattle"),
    Q(49, "Where does Jordan's sister Lucia live?", "Monterey, California", "relational", "Monterey"),
    Q(50, "Where do Jordan's parents live?", "Miami, Florida", "relational", "Miami"),
    Q(51, "What company does Maya Chen work at?", "Palantir", "relational", "Palantir"),
    Q(52, "What city does Maya Chen live in?", "Denver", "relational", "Denver"),
    Q(53, "What does Jordan's brother Sam do for work?", "a product manager at Google", "relational", "product manager", "Google"),
    Q(54, "What is Jordan's wife Noor's profession?", "an emergency room physician", "relational", "physician", "ER", "emergency"),
    Q(55, "Where did Jordan meet his best friend Maya?", "at PyCon 2021 in Salt Lake City", "relational", "PyCon", "Salt Lake City"),
    Q(56, "Where did Jordan meet his wife Noor?", "at a tango class", "relational", "tango"),
    Q(57, "What is Jordan's job title at Meridian AI's headquarters city?", "Austin", "relational", "Austin"),
    Q(58, "Who was the best man at Sam's wedding?", "Jordan", "relational", "best man"),

    # ===================================================================== #
    # MULTI-HOP (24) — 2-3 relations from Jordan
    # ===================================================================== #
    Q(59, "What does Jordan's sister do for work?", "a marine biologist", "multi-hop", "marine biologist"),
    Q(60, "Where does Jordan's sister work?", "the Monterey Bay Aquarium", "multi-hop", "Monterey Bay Aquarium"),
    Q(61, "What is Jordan's niece obsessed with?", "sea turtles", "multi-hop", "sea turtles"),
    Q(62, "What sport does Jordan's nephew play?", "soccer", "multi-hop", "soccer"),
    Q(63, "What position does Jordan's nephew play in soccer?", "goalkeeper", "multi-hop", "goalkeeper"),
    Q(64, "What hospital does Jordan's wife work at?", "Dell Seton Medical Center", "multi-hop", "Dell Seton"),
    Q(65, "What city did Jordan's wife grow up in?", "Amman, Jordan", "multi-hop", "Amman"),
    Q(66, "What was Jordan's grandmother's profession?", "a seamstress", "multi-hop", "seamstress"),
    Q(67, "What city does Jordan's grandmother live in?", "Tampa, Florida", "multi-hop", "Tampa"),
    Q(68, "What company does Jordan's sister-in-law work at?", "Microsoft", "multi-hop", "Microsoft"),
    Q(69, "What is Jordan's sister-in-law's profession?", "a UX researcher", "multi-hop", "UX researcher"),
    Q(70, "Where did Jordan's sister-in-law grow up?", "Vancouver, Canada", "multi-hop", "Vancouver"),
    Q(71, "What is the profession of Jordan's coworker Devon?", "a machine learning engineer", "multi-hop", "machine learning engineer", "ML engineer"),
    Q(72, "Where did Jordan's coworker Devon grow up?", "New Orleans", "multi-hop", "New Orleans"),
    Q(73, "What does Jordan's childhood friend Theo do for work?", "a high school chemistry teacher", "multi-hop", "chemistry teacher"),
    Q(74, "What city does Jordan's childhood friend Theo live in?", "Orlando, Florida", "multi-hop", "Orlando"),
    Q(75, "What is the profession of Jordan's cycling buddy Greta?", "a veterinarian", "multi-hop", "veterinarian", "vet"),
    Q(76, "What is the job title of Jordan's manager Adaeze Nwosu?", "VP of Engineering", "multi-hop", "VP of Engineering", "VP"),
    Q(77, "Where did Jordan's manager Adaeze Nwosu do her undergrad?", "Georgia Tech", "multi-hop", "Georgia Tech"),
    Q(78, "In what city was Jordan's employer Meridian AI originally founded?", "Toronto", "multi-hop", "Toronto"),
    Q(79, "What does Jordan's best friend Maya do for work?", "a data scientist", "multi-hop", "data scientist"),
    Q(80, "Which aquarium does Jordan's niece's mother work at?", "the Monterey Bay Aquarium", "multi-hop", "Monterey Bay Aquarium"),
    Q(81, "What dessert recipe did Jordan's grandmother pass down?", "tres leches cake", "multi-hop", "tres leches"),
    Q(82, "What did Jordan's grandmother run for decades?", "her own tailoring shop", "multi-hop", "tailoring shop"),

    # ===================================================================== #
    # TEMPORAL-UPDATE (24) — current AND prior values, both directions
    # ===================================================================== #
    Q(83, "What city does Jordan currently live in?", "Austin", "temporal-update", "Austin"),
    Q(84, "What city did Jordan live in before Austin?", "San Francisco", "temporal-update", "San Francisco"),
    Q(85, "What company does Jordan currently work for?", "Meridian AI", "temporal-update", "Meridian"),
    Q(86, "What company did Jordan work for before Meridian AI?", "Larkspur Pay", "temporal-update", "Larkspur"),
    Q(87, "What language does Jordan use for backend work now?", "Go", "temporal-update", "Go"),
    Q(88, "What language did Jordan use for backend work before switching?", "Python", "temporal-update", "Python"),
    Q(89, "What car does Jordan currently drive?", "a Toyota 4Runner", "temporal-update", "4Runner"),
    Q(90, "What car did Jordan drive before his current one?", "a Honda Element", "temporal-update", "Honda Element"),
    Q(91, "What phone does Jordan use now?", "a Google Pixel 8", "temporal-update", "Pixel 8"),
    Q(92, "What phone did Jordan use before his current one?", "an iPhone 11", "temporal-update", "iPhone 11"),
    Q(93, "Who does Jordan currently live with?", "his wife Noor", "temporal-update", "Noor"),
    Q(94, "Who did Jordan live with before, in San Francisco?", "three roommates", "temporal-update", "roommates"),
    Q(95, "What language is Jordan learning now?", "Spanish", "temporal-update", "Spanish"),
    Q(96, "What language did Jordan study in college before Spanish?", "Portuguese", "temporal-update", "Portuguese"),
    Q(97, "What computer does Jordan use now?", "a MacBook Pro", "temporal-update", "MacBook"),
    Q(98, "What computer did Jordan use before his MacBook?", "a Windows desktop", "temporal-update", "Windows"),
    Q(99, "What code editor does Jordan use now?", "VS Code", "temporal-update", "VS Code"),
    Q(100, "What code editor did Jordan use before VS Code?", "Vim", "temporal-update", "Vim"),
    Q(101, "What is Jordan's main form of cardio now?", "cycling", "temporal-update", "cycling"),
    Q(102, "What cardio did Jordan do before he gave it up for cycling?", "running", "temporal-update", "running"),
    Q(103, "What is Jordan's current diet?", "pescatarian", "temporal-update", "pescatarian"),
    Q(104, "What diet did Jordan follow before going pescatarian?", "vegetarian", "temporal-update", "vegetarian"),
    Q(105, "What is Jordan's current job title?", "Senior Software Engineer", "temporal-update", "Senior"),
    Q(106, "What does Jordan drink in the morning now, after switching back at Meridian AI?", "coffee", "temporal-update", "coffee"),

    # ===================================================================== #
    # ENUMERATION (12) — complete bounded gold sets
    # ===================================================================== #
    Q(107, "List all of Jordan's pets.", "Mochi (a greyhound) and Pixel (a cat)", "enumeration", "Mochi", "Pixel"),
    Q(108, "Name all of Jordan's siblings.", "Sam and Lucia", "enumeration", "Sam", "Lucia"),
    Q(109, "List all the cities Jordan has lived in.", "Miami, San Francisco, and Austin", "enumeration", "Miami", "San Francisco", "Austin"),
    Q(110, "Name every company Jordan has worked for.", "Larkspur Pay and Meridian AI", "enumeration", "Larkspur", "Meridian"),
    Q(111, "List all of Jordan's hobbies.", "gravel cycling, bouldering, sea kayaking, birdwatching, and playing guitar", "enumeration", "cycling", "bouldering", "kayaking", "birdwatching", "guitar"),
    Q(112, "What are all of Jordan's named friends?", "Maya Chen, Devon Ellison, Theo Vance, and Greta Lindqvist", "enumeration", "Maya", "Devon", "Theo", "Greta"),
    Q(113, "List the things Jordan is allergic to or intolerant of.", "shellfish (allergy) and lactose (intolerance)", "enumeration", "shellfish", "lactose"),
    Q(114, "Name Jordan's wife and his two siblings.", "his wife Noor, brother Sam, and sister Lucia", "enumeration", "Noor", "Sam", "Lucia"),
    Q(115, "List Jordan's niece and nephew.", "Camila (niece) and Mateo (nephew)", "enumeration", "Camila", "Mateo"),
    Q(116, "What devices and gadgets does Jordan own?", "a Google Pixel 8 phone, a Fujifilm X-T4 camera, a Garmin Fenix watch, and a MacBook Pro", "enumeration", "Pixel 8", "Fujifilm", "Garmin", "MacBook"),
    Q(117, "Name all the parents and grandparents Jordan has mentioned.", "his parents Elena and Carlos and his grandmother Abuela Rosa", "enumeration", "Elena", "Carlos", "Rosa"),
    Q(118, "List all of Jordan's favorite media (band, movie, game, show, board game).", "band Khruangbin, movie Arrival, video game Hollow Knight, TV show Severance, and board game Wingspan", "enumeration", "Khruangbin", "Arrival", "Hollow Knight", "Severance", "Wingspan"),

    # ===================================================================== #
    # AGGREGATION (8) — counts + single-target filters
    # ===================================================================== #
    Q(119, "How many siblings does Jordan have?", "two (Sam and Lucia)", "aggregation", "two", "2"),
    Q(120, "How many pets does Jordan have?", "two (a dog, Mochi, and a cat, Pixel)", "aggregation", "two", "2"),
    Q(121, "How many cities has Jordan lived in?", "three (Miami, San Francisco, and Austin)", "aggregation", "three", "3"),
    Q(122, "How many companies has Jordan worked for?", "two (Larkspur Pay and Meridian AI)", "aggregation", "two", "2"),
    Q(123, "Which member of Jordan's family is a doctor?", "his wife Noor, an ER physician", "aggregation", "Noor"),
    Q(124, "Which of Jordan's relatives is a marine biologist?", "his sister Lucia", "aggregation", "Lucia"),
    Q(125, "How many of Jordan's named friends work as a veterinarian?", "one (Greta Lindqvist)", "aggregation", "one", "1", "Greta"),
    Q(126, "How many children do Jordan's siblings have in total?", "two (Camila and Mateo)", "aggregation", "two", "2"),

    # ===================================================================== #
    # ABSENCE (16) — baited "No"; the tempting wrong answer exists about
    # someone else. Each bait is a canonical statement.
    # ===================================================================== #
    Q(127, "Does Jordan have a pet bird?",
           "No — Jordan's only pets are a dog (Mochi) and a cat (Pixel). He enjoys birdwatching, but owns no bird.",
           "absence", "no"),
    Q(128, "Does Jordan have a third sibling?",
           "No — Jordan has exactly two siblings, his brother Sam and his sister Lucia.",
           "absence", "no"),
    Q(129, "Does Jordan work at Palantir?",
           "No — Jordan works at Meridian AI. Palantir is where his best friend Maya Chen works.",
           "absence", "no"),
    Q(130, "Is Jordan a doctor?",
           "No — Jordan is a software engineer. His wife Noor is the doctor (an ER physician).",
           "absence", "no"),
    Q(131, "Does Jordan have any children of his own?",
           "No — Jordan has a niece (Camila) and a nephew (Mateo), but no children of his own.",
           "absence", "no"),
    Q(132, "Has Jordan ever worked at Google?",
           "No — Jordan has worked at Larkspur Pay and Meridian AI. His brother Sam is the one at Google.",
           "absence", "no"),
    Q(133, "Does Jordan currently live in San Francisco?",
           "No — Jordan moved to Austin three years ago. He lived in San Francisco before that, not now.",
           "absence", "no"),
    Q(134, "Is Jordan a veterinarian?",
           "No — Jordan is a software engineer. His cycling buddy Greta Lindqvist is the veterinarian.",
           "absence", "no"),
    Q(135, "Does Jordan currently use an iPhone?",
           "No — Jordan now uses a Google Pixel 8. He used an iPhone 11 before, but switched this spring.",
           "absence", "no"),
    Q(136, "Does Jordan play the piano?",
           "No — Jordan plays acoustic guitar, not piano.",
           "absence", "no"),
    Q(137, "Does Jordan still write Python for the backend?",
           "No — Jordan switched from Python to Go about six months ago.",
           "absence", "no"),
    Q(138, "Is Jordan currently a vegetarian?",
           "No — Jordan used to be vegetarian but is now pescatarian.",
           "absence", "no"),
    Q(139, "Does Jordan live in Denver?",
           "No — Jordan lives in Austin. Denver is where his best friend Maya Chen lives.",
           "absence", "no"),
    Q(140, "Is Jordan allergic to peanuts?",
           "No — Jordan is allergic to shellfish (and lactose intolerant), but not peanuts.",
           "absence", "no"),
    Q(141, "Does Jordan have a sister named Hana?",
           "No — Jordan's sister is Lucia. Hana Kim is his sister-in-law (his brother Sam's wife).",
           "absence", "no"),
    Q(142, "Does Jordan use Vim as his code editor now?",
           "No — Jordan switched from Vim to VS Code when he joined Meridian AI.",
           "absence", "no"),

    # ===================================================================== #
    # PRESENCE-CONTROL (8) — genuine "yes" about things that DO exist
    # ===================================================================== #
    Q(143, "Does Jordan have a sister?",
           "Yes — his sister Lucia, a marine biologist.",
           "presence-control", "yes", "Lucia"),
    Q(144, "Does Jordan own a cat?",
           "Yes — a tabby cat named Pixel.",
           "presence-control", "yes", "Pixel"),
    Q(145, "Is Jordan married?",
           "Yes — to his wife Noor Haddad.",
           "presence-control", "yes", "Noor"),
    Q(146, "Does Jordan play a musical instrument?",
           "Yes — acoustic guitar.",
           "presence-control", "yes", "guitar"),
    Q(147, "Does Jordan have a nephew?",
           "Yes — his nephew Mateo.",
           "presence-control", "yes", "Mateo"),
    Q(148, "Does Jordan work at Meridian AI?",
           "Yes — as a Senior Software Engineer on the Recommendations team.",
           "presence-control", "yes", "Meridian"),
    Q(149, "Has Jordan lived in Austin?",
           "Yes — he currently lives in Austin.",
           "presence-control", "yes", "Austin"),
    Q(150, "Does Jordan own a dog?",
           "Yes — a rescue greyhound named Mochi.",
           "presence-control", "yes", "Mochi"),
]


def main() -> None:
    seed = json.loads(SEED.read_text())

    # Reuse the seed's canonical first-person sessions verbatim (they carry the
    # ~20 seed facts), then append the new dense sessions.
    base = {
        "_comment": "FULL Jordan Rivera base persona. Canonical first-person facts "
                    "only — NO distractors. Run generate_large_persona.py to bury "
                    "these under hard-negative noise. Built by build_jordan_full.py "
                    "from the thin seed personas/jordan_rivera.json; every seed fact "
                    "is preserved and kept consistent.",
        "persona_id": "jordan_rivera_full",
        "name": "Jordan Rivera",
        "description": "Jordan Rivera — full benchmark persona with a dense "
                       "entity/relationship graph (family tree, friends and "
                       "colleagues with their own jobs/cities, pets, possessions, "
                       "media tastes, allergies, multi-hop chains, and before/after "
                       "temporal updates). Cuban-American, Austin TX. Distinct in "
                       "name and value space from Max Turnquist, Priya Sharma, and "
                       "the distractor pools.",
        "sessions": seed["sessions"] + [
            {"id": sid, "messages": [{"role": "user", "content": c} for c in msgs]}
            for sid, msgs in NEW_SESSIONS
        ],
        "eval_questions": QUESTIONS,
    }

    # --- self-validation -------------------------------------------------- #
    ids = [q["id"] for q in base["eval_questions"]]
    assert len(ids) == len(set(ids)), \
        f"duplicate question ids: {[i for i in ids if ids.count(i) > 1]}"

    # Concatenated canonical user-message text (case-insensitive grounding).
    canon_text = "\n".join(
        m["content"] for s in base["sessions"] for m in s["messages"]
        if m["role"] == "user"
    ).lower()

    failures = []
    for q in base["eval_questions"]:
        if q["category"] in ("absence", "presence-control"):
            continue
        kws = q["keywords"]
        if not any(kw.lower() in canon_text for kw in kws):
            failures.append((q["id"], q["category"], q["question"], kws))

    if failures:
        print("!! GROUNDING FAILURES (no keyword found in canonical statements):")
        for qid, cat, ques, kws in failures:
            print(f"   {qid} [{cat}] {ques!r}  keywords={kws}")
    else:
        print("Grounding: OK — every non-absence/presence question has >=1 keyword "
              "present in the canonical statements.")

    OUT.write_text(json.dumps(base, indent=2, ensure_ascii=False), encoding="utf-8")

    cats = Counter(q["category"] for q in base["eval_questions"])
    canon_msgs = sum(1 for s in base["sessions"] for m in s["messages"]
                     if m["role"] == "user")
    order = ["flat-recall", "relational", "multi-hop", "temporal-update",
             "enumeration", "aggregation", "absence", "presence-control"]
    print(f"\nWrote {OUT}")
    print(f"  total questions: {len(base['eval_questions'])}")
    print("  per-category counts:")
    for c in order:
        print(f"    {c:18s} {cats.get(c, 0)}")
    extra = set(cats) - set(order)
    for c in sorted(extra):
        print(f"    {c:18s} {cats[c]}   (UNEXPECTED CATEGORY)")
    print(f"  total canonical user-messages: {canon_msgs}")
    print(f"  total sessions: {len(base['sessions'])}")
    assert not failures, "fix grounding failures above before shipping"


if __name__ == "__main__":
    main()
