#!/usr/bin/env python3
"""
Build the FULL Priya Sharma BASE persona (~90 canonical facts, ~170 questions).

This EXTENDS the existing personas/priya_sharma.json. Every base fact (f01-f15
plus the incidental facts in its sessions) is preserved verbatim and kept
consistent; we flesh Priya out into a dense, coherent person: spouse, parents,
two siblings (each with their own life), in-laws, niece/nephew, close friends &
colleagues (each with job/employer/city), pet, hobbies, possessions, media
tastes, allergies/quirks, and many temporal before/after pairs.

Like build_100_base.py, this writes ONLY canonical first-person `user` messages
(NO distractors) plus eval_questions across all nine categories. Distractor
noise is layered on later by generate_large_persona.py, so the canonical
names/values here are chosen to NOT collide with:
  - the distractor pools in generate_large_persona.py (OTHER_PEOPLE, INSTRUMENTS,
    PETS, FOODS, BOOKS, BIKES, LANGUAGES, CITIES, COMPANIES, HOBBIES, JOBS),
  - Max Turnquist's world (max_turnquist_100.json),
  - Jordan Rivera's world (jordan_rivera.json).

Output: personas/priya_sharma_base.json  (a BASE; run generate_large_persona.py
on it to bury the facts under distractor noise).
"""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

OUT = Path("personas/priya_sharma_base.json")

# --------------------------------------------------------------------------- #
# Canonical fact sessions (first-person Priya statements only). Every gold
# answer below is supported by exactly one of these lines (enumeration answers
# by a known complete set of lines). Base facts f01-f15 are restated here so
# this file is self-contained and re-ingestable on its own.
# --------------------------------------------------------------------------- #

NEW_SESSIONS = [
    # ---- Identity / current vs prior home & job (preserves base f01, f02, f03) ----
    ("sess_01", [
        "Hi, I'm Priya Sharma. I currently live in Denver, but I moved here from Portland last spring.",
        "I work at Cobalt Robotics now as a robotics engineer; I left Northwind Logistics back in March.",
        "At Cobalt I lead the perception team.",
        "My official job title at Cobalt is now Principal Robotics Engineer — I got promoted from Senior Engineer in April.",
    ]),
    # ---- Spouse Arjun (his own attributes for multi-hop) ----
    ("sess_02", [
        "My husband is named Arjun Mehta.",
        "Arjun is a structural engineer at a firm called Halcyon Bridgeworks here in Denver.",
        "Arjun plays the harmonium and sings at our temple on weekends.",
        "Arjun grew up in Nairobi and moved to the US for grad school.",
        "Arjun and I got married in Udaipur four years ago.",
    ]),
    # ---- Parents (preserve f07) + grandmother ----
    ("sess_03", [
        "My parents are Deepak and Sunita Sharma, and they still live in Portland.",
        "My father Deepak is a retired botany professor.",
        "My mother Sunita runs a small textile shop called Marigold Looms.",
        "My grandmother, whom I call Naani Asha, lives with my parents in Portland.",
        "Naani Asha was a radio playback singer in Lucknow when she was young.",
    ]),
    # ---- Sister Anita (preserve f04, f06, f17 library) + her kids ----
    ("sess_04", [
        "My older sister is Anita, and she's an architect.",
        "Anita lives in Chicago with her husband Raj.",
        "Last year Anita designed a public library in Chicago.",
        "Anita and Raj have two kids: my niece Tara and my nephew Kiran.",
        "My niece Tara is twelve and is a competitive figure skater.",
        "My nephew Kiran is eight and is obsessed with building marble runs.",
    ]),
    # ---- Brother-in-law Raj (preserve f05 cardiologist) ----
    ("sess_05", [
        "My brother-in-law Raj — Anita's husband — is a cardiologist.",
        "Raj works at a hospital called Lakeshore Cardiac Center in Chicago.",
        "Raj is an avid open-water swimmer and does a relay across the lake every summer.",
    ]),
    # ---- Brother Rohan (his own life) ----
    ("sess_06", [
        "I also have a younger brother named Rohan.",
        "Rohan is a marine biologist at the Coralline Institute.",
        "Rohan lives in Kochi, in India.",
        "Rohan is married to my sister-in-law Fatima, who is a documentary filmmaker.",
        "Rohan and Fatima have a baby daughter named Zoya.",
    ]),
    # ---- Best friend Lena (preserve f08 Stripe) + her own life ----
    ("sess_07", [
        "My best friend is Lena, and she works at Stripe.",
        "Lena is a staff product manager at Stripe.",
        "Lena lives in Oakland and commutes across the bay.",
        "Lena and I met in college, where we were both on the rowing team.",
    ]),
    # ---- Friend Meera (her own job/employer/city) + her dog (absence bait) ----
    ("sess_08", [
        "My close friend Meera Iyer is a pediatrician.",
        "Meera works at Saint Brigid Hospital here in Denver.",
        "Meera owns a Bernese mountain dog named Laddoo.",
        "Meera and I do a pottery class together on Thursday evenings.",
    ]),
    # ---- Friend Gabriel (his own job/city) ----
    ("sess_09", [
        "My friend Gabriel Okonkwo is a wine sommelier.",
        "Gabriel runs the wine program at a restaurant in Reykjavik.",
        "Gabriel was my roommate during my exchange semester abroad.",
    ]),
    # ---- Manager / colleague (their own attributes) ----
    ("sess_10", [
        "My manager at Cobalt is named Helena Vance.",
        "Helena was an astronaut candidate before she went into robotics.",
        "On the perception team I work most closely with my teammate Oscar Mbeki.",
        "Oscar joined Cobalt from a drone company called Skylark Dynamics.",
        "My mentor from grad school, Professor Nadia Brandt, teaches at Rutgers.",
    ]),
    # ---- Pet (preserve f11 Biryani tabby) — Biryani is her ONLY pet ----
    ("sess_11", [
        "My cat is named Biryani, a little tabby with strong opinions.",
        "Biryani is the only pet I have — just the one cat.",
        "I adopted Biryani from a shelter called Mile-High Rescue.",
    ]),
    # ---- Possessions: bike (preserve f09), car, instrument (preserve f10 violin) ----
    ("sess_12", [
        "I ride a Cannondale Synapse road bike.",
        "I drive a Rivian R1S — it's electric.",
        "I play the violin; I picked it back up after years.",
        "My everyday watch is a Withings ScanWatch.",
    ]),
    # ---- Media tastes (preserve f13 Overstory) ----
    ("sess_13", [
        "I'm reading The Overstory by Richard Powers right now.",
        "My comfort show is Schitt's Creek — I've rewatched it four times.",
        "My favorite film of all time is Spirited Away.",
        "My go-to karaoke song is Mr. Brightside.",
        "I'm completely hooked on a podcast called Ologies.",
    ]),
    # ---- Food / drink (preserve f12 palak paneer) + allergy/quirks ----
    ("sess_14", [
        "My favorite food is palak paneer — total childhood comfort food.",
        "My favorite dessert is gulab jamun.",
        "I'm allergic to shellfish, found out the hard way at a wedding.",
        "I take my chai with cardamom and no sugar.",
        "I'm strictly vegetarian and have been my whole life.",
    ]),
    # ---- Hobbies / quirks (preserve f15 hiking, f14 Japanese/Kyoto) ----
    ("sess_15", [
        "I enjoy hiking — I did the Mount Falcon trail my first weekend in Denver.",
        "I've recently taken up indoor rock climbing at a gym called Summit Stone.",
        "I keep a beehive on our rooftop and harvest honey in the fall.",
        "I'm terrified of deep open water, ironic given my brother's job.",
        "I'm learning Japanese for a trip to Kyoto in November.",
        "I collect vintage fountain pens — I have about a dozen.",
    ]),
    # ---- Temporal updates: before/after pairs (each in one "used to ... now ..." line) ----
    ("sess_16", [
        "I used to commute on an old Vespa scooter, but now I drive my Rivian.",
        "For years my daily phone was a BlackBerry, but I switched to a Pixel last year.",
        "I used to code mostly in MATLAB, but at Cobalt I work almost entirely in Rust now.",
        "I lived with three roommates in Portland, but now I live just with my husband Arjun in Denver.",
        "I gave up coffee two years ago and switched entirely to chai.",
    ]),
    ("sess_17", [
        "I used to wear contact lenses, but I got LASIK the year before last and ditched them.",
        "My old laptop was a clunky Dell, but my work machine now is a Framework laptop.",
        "I was learning the sitar for a while, but I set it aside and went back to the violin.",
        "I used to run marathons, but a knee injury pushed me toward cycling instead.",
        "I quit biting my nails after twenty years — finally kicked it last winter.",
    ]),
    # ---- A few more flat facts to round her out ----
    ("sess_18", [
        "My favorite season is autumn, hands down.",
        "I'm a green-tea-over-everything kind of person, but chai is my real love.",
        "My lucky number is seven.",
        "I volunteer monthly at a robotics club for middle-schoolers called GearWorks.",
        "I left Northwind Logistics, where I had been a logistics systems engineer, back in March.",
    ]),
]

# --------------------------------------------------------------------------- #
# Eval questions. "pq" prefix so ids never collide with Max's "q"/"s"/"n".
# --------------------------------------------------------------------------- #

def Q(i, question, answer, category, *keywords):
    return {"id": f"pq{i:02d}", "question": question, "answer": answer,
            "keywords": list(keywords) or [answer], "category": category}


QUESTIONS = [
    # =================================================================== #
    # flat-recall (34) — direct attributes of Priya
    # =================================================================== #
    Q(1,  "What instrument does Priya play?", "the violin", "flat-recall", "violin"),
    Q(2,  "What is the name of Priya's cat?", "Biryani", "flat-recall", "Biryani"),
    Q(3,  "What kind of cat does Priya have?", "a tabby", "flat-recall", "tabby"),
    Q(4,  "What is Priya's favorite food?", "palak paneer", "flat-recall", "palak paneer", "palak"),
    Q(5,  "What is Priya's favorite dessert?", "gulab jamun", "flat-recall", "gulab jamun"),
    Q(6,  "What book is Priya reading?", "The Overstory by Richard Powers", "flat-recall", "Overstory", "Richard Powers"),
    Q(7,  "What kind of bike does Priya ride?", "a Cannondale Synapse road bike", "flat-recall", "Cannondale", "Synapse"),
    Q(8,  "What language is Priya learning?", "Japanese", "flat-recall", "Japanese"),
    Q(9,  "What outdoor hobby does Priya enjoy?", "hiking", "flat-recall", "hiking", "hike"),
    Q(10, "What is Priya's comfort TV show?", "Schitt's Creek", "flat-recall", "Schitt's Creek", "Schitt"),
    Q(11, "What is Priya's favorite film?", "Spirited Away", "flat-recall", "Spirited Away"),
    Q(12, "What food is Priya allergic to?", "shellfish", "flat-recall", "shellfish"),
    Q(13, "What is Priya's go-to karaoke song?", "Mr. Brightside", "flat-recall", "Mr. Brightside", "Brightside"),
    Q(14, "What podcast is Priya hooked on?", "Ologies", "flat-recall", "Ologies"),
    Q(15, "What car does Priya drive?", "a Rivian R1S", "flat-recall", "Rivian"),
    Q(16, "What brand of watch does Priya wear?", "a Withings ScanWatch", "flat-recall", "Withings", "ScanWatch"),
    Q(17, "What does Priya collect?", "vintage fountain pens", "flat-recall", "fountain pens", "pens"),
    Q(18, "What climbing gym does Priya go to?", "Summit Stone", "flat-recall", "Summit Stone"),
    Q(19, "What does Priya keep on her rooftop?", "a beehive", "flat-recall", "beehive", "bees"),
    Q(20, "What is Priya afraid of?", "deep open water", "flat-recall", "open water", "deep"),
    Q(21, "How does Priya take her chai?", "with cardamom and no sugar", "flat-recall", "cardamom"),
    Q(22, "What is Priya's dietary preference?", "vegetarian", "flat-recall", "vegetarian"),
    Q(23, "What is Priya's favorite season?", "autumn", "flat-recall", "autumn"),
    Q(24, "What is Priya's lucky number?", "seven", "flat-recall", "seven", "7"),
    Q(25, "What city is Priya planning to travel to?", "Kyoto", "flat-recall", "Kyoto"),
    Q(26, "In what month is Priya's Kyoto trip?", "November", "flat-recall", "November"),
    Q(27, "What trail did Priya hike her first weekend in Denver?", "the Mount Falcon trail", "flat-recall", "Mount Falcon"),
    Q(28, "What is Priya's current job title at Cobalt?", "Principal Robotics Engineer", "flat-recall", "Principal Robotics Engineer", "Principal"),
    Q(29, "What team does Priya lead at Cobalt?", "the perception team", "flat-recall", "perception"),
    Q(30, "Where did Priya adopt her cat?", "Mile-High Rescue", "flat-recall", "Mile-High Rescue", "Mile-High"),
    Q(31, "What youth robotics club does Priya volunteer at?", "GearWorks", "flat-recall", "GearWorks"),
    Q(32, "What city did Priya hike Mount Falcon in?", "Denver", "flat-recall", "Denver"),
    Q(33, "What kind of engineer is Priya at Cobalt Robotics?", "a robotics engineer", "flat-recall", "robotics engineer"),
    Q(34, "What sweetener does Priya use in her chai?", "none — she takes it with no sugar", "flat-recall", "no sugar"),

    # =================================================================== #
    # relational (24) — 1 hop from Priya, or a named relation's direct attribute
    # =================================================================== #
    Q(35, "What is the name of Priya's husband?", "Arjun Mehta", "relational", "Arjun"),
    Q(36, "What is the name of Priya's older sister?", "Anita", "relational", "Anita"),
    Q(37, "What is the name of Priya's younger brother?", "Rohan", "relational", "Rohan"),
    Q(38, "What are Priya's parents' names?", "Deepak and Sunita", "relational", "Deepak", "Sunita"),
    Q(39, "What is the name of Priya's grandmother?", "Naani Asha", "relational", "Asha", "Naani"),
    Q(40, "Who is Priya's brother-in-law (her sister's husband)?", "Raj", "relational", "Raj"),
    Q(41, "What is the name of Priya's niece?", "Tara", "relational", "Tara"),
    Q(42, "What is the name of Priya's nephew?", "Kiran", "relational", "Kiran"),
    Q(43, "Who is Priya's best friend?", "Lena", "relational", "Lena"),
    Q(44, "What is the name of Priya's pediatrician friend?", "Meera Iyer", "relational", "Meera"),
    Q(45, "Who is Priya's friend that works as a sommelier?", "Gabriel Okonkwo", "relational", "Gabriel"),
    Q(46, "Who is Priya's manager at Cobalt?", "Helena Vance", "relational", "Helena"),
    Q(47, "Who is Priya's closest teammate on the perception team?", "Oscar Mbeki", "relational", "Oscar"),
    Q(48, "Who was Priya's grad-school mentor?", "Professor Nadia Brandt", "relational", "Nadia", "Brandt"),
    Q(49, "What city do Priya's sister and brother-in-law live in?", "Chicago", "relational", "Chicago"),
    Q(50, "Where do Priya's parents live?", "Portland", "relational", "Portland"),
    Q(51, "What is the name of Priya's sister-in-law (her brother's wife)?", "Fatima", "relational", "Fatima"),
    Q(52, "What is the name of Priya's brother Rohan's baby daughter?", "Zoya", "relational", "Zoya"),
    Q(53, "Where does Priya's brother Rohan live?", "Kochi", "relational", "Kochi"),
    Q(54, "What is Priya's sister Anita's profession?", "architect", "relational", "architect"),
    Q(55, "What does Priya's brother-in-law Raj do for work?", "He is a cardiologist", "relational", "cardiologist"),
    Q(56, "What pet does Priya's friend Meera own?", "a Bernese mountain dog named Laddoo", "relational", "Laddoo", "Bernese"),
    Q(57, "Where did Priya and Lena meet?", "in college, on the rowing team", "relational", "college", "rowing"),
    Q(58, "What city was Priya married in?", "Udaipur", "relational", "Udaipur"),

    # =================================================================== #
    # multi-hop (24) — 2-3 relations from Priya
    # =================================================================== #
    Q(59, "What does Priya's husband do for work?", "structural engineer", "multi-hop", "structural engineer"),
    Q(60, "What firm does Priya's husband work at?", "Halcyon Bridgeworks", "multi-hop", "Halcyon"),
    Q(61, "What instrument does Priya's husband play?", "the harmonium", "multi-hop", "harmonium"),
    Q(62, "Where did Priya's husband grow up?", "Nairobi", "multi-hop", "Nairobi"),
    Q(63, "Where does Priya's best friend work?", "Stripe", "multi-hop", "Stripe"),
    Q(64, "What is Priya's best friend's job title?", "staff product manager", "multi-hop", "product manager"),
    Q(65, "What city does Priya's best friend Lena live in?", "Oakland", "multi-hop", "Oakland"),
    Q(66, "What hospital does Priya's brother-in-law Raj work at?", "Lakeshore Cardiac Center", "multi-hop", "Lakeshore"),
    Q(67, "What sport is Priya's brother-in-law Raj into?", "open-water swimming", "multi-hop", "swimming", "swimmer"),
    Q(68, "What is Priya's niece Tara's sport?", "figure skating", "multi-hop", "figure skater", "skating"),
    Q(69, "What is Priya's nephew Kiran obsessed with building?", "marble runs", "multi-hop", "marble runs", "marble"),
    Q(70, "What does Priya's brother Rohan do for work?", "marine biologist", "multi-hop", "marine biologist"),
    Q(71, "What institute does Priya's brother Rohan work at?", "the Coralline Institute", "multi-hop", "Coralline"),
    Q(72, "What does Priya's sister-in-law Fatima do for work?", "documentary filmmaker", "multi-hop", "filmmaker", "documentary"),
    Q(73, "What hospital does Priya's friend Meera work at?", "Saint Brigid Hospital", "multi-hop", "Saint Brigid"),
    Q(74, "In what city does Priya's friend Gabriel work?", "Reykjavik", "multi-hop", "Reykjavik"),
    Q(75, "What was Priya's manager Helena before she went into robotics?", "an astronaut candidate", "multi-hop", "astronaut"),
    Q(76, "What company did Priya's teammate Oscar join Cobalt from?", "Skylark Dynamics", "multi-hop", "Skylark"),
    Q(77, "At what university does Priya's mentor Nadia Brandt teach?", "Rutgers", "multi-hop", "Rutgers"),
    Q(78, "What was Priya's grandmother's former profession?", "a radio playback singer", "multi-hop", "playback singer", "singer"),
    Q(79, "What is Priya's father Deepak's former profession?", "a botany professor", "multi-hop", "botany professor", "botany"),
    Q(80, "What shop does Priya's mother Sunita run?", "Marigold Looms", "multi-hop", "Marigold Looms", "Marigold"),
    Q(81, "What kind of public building did Priya's sister Anita design last year?", "a public library", "multi-hop", "library"),
    Q(82, "In what city did Priya's grandmother sing on the radio?", "Lucknow", "multi-hop", "Lucknow"),

    # =================================================================== #
    # temporal-update (24) — current AND prior value, each grounded
    # =================================================================== #
    Q(83, "What city does Priya currently live in?", "Denver", "temporal-update", "Denver"),
    Q(84, "What city did Priya live in before her current one?", "Portland", "temporal-update", "Portland"),
    Q(85, "What company does Priya currently work for?", "Cobalt Robotics", "temporal-update", "Cobalt"),
    Q(86, "What company did Priya work for before her current job?", "Northwind Logistics", "temporal-update", "Northwind"),
    Q(87, "What phone does Priya currently use?", "a Pixel", "temporal-update", "Pixel"),
    Q(88, "What phone did Priya use before her current one?", "a BlackBerry", "temporal-update", "BlackBerry"),
    Q(89, "What programming language does Priya mainly use now?", "Rust", "temporal-update", "Rust"),
    Q(90, "What programming language did Priya mainly use before Rust?", "MATLAB", "temporal-update", "MATLAB"),
    Q(91, "What does Priya drive now for her commute?", "a Rivian", "temporal-update", "Rivian"),
    Q(92, "What did Priya commute on before her current car?", "an old Vespa scooter", "temporal-update", "Vespa"),
    Q(93, "Who does Priya currently live with?", "her husband Arjun", "temporal-update", "Arjun"),
    Q(94, "What was Priya's living situation before her current one?", "she lived with three roommates", "temporal-update", "three roommates", "roommates"),
    Q(95, "What is Priya's current job title?", "Principal Robotics Engineer", "temporal-update", "Principal"),
    Q(96, "What was Priya's job title before her promotion?", "Senior Engineer", "temporal-update", "Senior Engineer", "Senior"),
    Q(97, "How does Priya correct her vision now?", "she got LASIK", "temporal-update", "LASIK"),
    Q(98, "How did Priya correct her vision before LASIK?", "she wore contact lenses", "temporal-update", "contact lenses", "contacts"),
    Q(99, "What is Priya's current work laptop?", "a Framework laptop", "temporal-update", "Framework"),
    Q(100, "What laptop did Priya use before her current one?", "an old Dell", "temporal-update", "Dell"),
    Q(101, "What endurance sport does Priya do now?", "cycling", "temporal-update", "cycling", "cycle"),
    Q(102, "What endurance sport did Priya do before her knee injury?", "running marathons", "temporal-update", "marathon"),
    Q(103, "What stringed instrument did Priya set aside before going back to the violin?", "the sitar", "temporal-update", "sitar"),
    Q(104, "What hot drink did Priya switch to after giving up coffee?", "chai", "temporal-update", "chai"),
    Q(105, "What drink did Priya give up two years ago?", "coffee", "temporal-update", "coffee"),
    Q(106, "What habit did Priya quit last winter after twenty years?", "biting her nails", "temporal-update", "biting", "nails"),

    # =================================================================== #
    # enumeration (12) — each "list all X" has a COMPLETE bounded gold set
    # =================================================================== #
    Q(107, "List all of Priya's siblings.", "Anita (sister) and Rohan (brother)", "enumeration", "Anita", "Rohan"),
    Q(108, "List all the cities Priya has lived in.", "Portland and Denver", "enumeration", "Portland", "Denver"),
    Q(109, "Name every company Priya has worked for.", "Cobalt Robotics and Northwind Logistics", "enumeration", "Cobalt", "Northwind"),
    Q(110, "Name Priya's parents.", "Deepak and Sunita", "enumeration", "Deepak", "Sunita"),
    Q(111, "List Priya's sister Anita's children.", "Tara and Kiran", "enumeration", "Tara", "Kiran"),
    Q(112, "Who are all of Priya's close friends?", "Lena, Meera, and Gabriel", "enumeration", "Lena", "Meera", "Gabriel"),
    Q(113, "List Priya's hobbies and activities.", "hiking, rock climbing, violin, cycling, beekeeping, collecting fountain pens",
      "enumeration", "hiking", "climbing", "violin", "cycling", "beekeeping", "fountain pens"),
    Q(114, "List the musical instruments played by Priya and her husband.", "violin (Priya) and harmonium (Arjun)",
      "enumeration", "violin", "harmonium"),
    Q(115, "Name all of Priya's coworkers at Cobalt that she has mentioned.", "Helena Vance (manager) and Oscar Mbeki (teammate)",
      "enumeration", "Helena", "Oscar"),
    Q(116, "List the cities where Priya's relatives live.", "Portland (parents), Chicago (sister), and Kochi (brother)",
      "enumeration", "Portland", "Chicago", "Kochi"),
    Q(117, "Name all of Priya's pets.", "one cat, named Biryani", "enumeration", "Biryani"),
    Q(118, "List the in-laws Priya has gained through her siblings.", "Raj (sister's husband) and Fatima (brother's wife)",
      "enumeration", "Raj", "Fatima"),

    # =================================================================== #
    # aggregation (8) — counts and single-target filters
    # =================================================================== #
    Q(119, "How many siblings does Priya have?", "two (Anita and Rohan)", "aggregation", "two", "2"),
    Q(120, "How many cities has Priya lived in?", "two (Portland and Denver)", "aggregation", "two", "2"),
    Q(121, "How many companies has Priya worked for?", "two (Cobalt Robotics and Northwind Logistics)", "aggregation", "two", "2"),
    Q(122, "How many children does Priya's sister Anita have?", "two (Tara and Kiran)", "aggregation", "two", "2"),
    Q(123, "How many pets does Priya have?", "one (a cat named Biryani)", "aggregation", "one", "1"),
    Q(124, "Which of Priya's relatives is a doctor?", "Raj, her brother-in-law, who is a cardiologist", "aggregation", "Raj"),
    Q(125, "Which member of Priya's family is an architect?", "her sister Anita", "aggregation", "Anita"),
    Q(126, "How many close friends has Priya named?", "three (Lena, Meera, and Gabriel)", "aggregation", "three", "3"),

    # =================================================================== #
    # absence (16) — answer is "No", each BAITED by a fact about someone else
    # =================================================================== #
    Q(127, "Does Priya own a dog?",
      "No — Priya's only pet is a cat named Biryani. (The Bernese mountain dog Laddoo belongs to her friend Meera.)",
      "absence", "no"),
    Q(128, "Does Priya have a brother named Raj?",
      "No — Priya's brother is named Rohan. Raj is her brother-in-law (her sister Anita's husband).",
      "absence", "no"),
    Q(129, "Is Priya a cardiologist?",
      "No — Priya is a robotics engineer. Her brother-in-law Raj is the cardiologist.",
      "absence", "no"),
    Q(130, "Does Priya play the harmonium?",
      "No — Priya plays the violin. Her husband Arjun is the one who plays the harmonium.",
      "absence", "no"),
    Q(131, "Has Priya ever lived in Chicago?",
      "No — Priya has only lived in Portland and Denver. Chicago is where her sister Anita lives.",
      "absence", "no"),
    Q(132, "Does Priya work at Stripe?",
      "No — Priya works at Cobalt Robotics. Stripe is where her best friend Lena works.",
      "absence", "no"),
    Q(133, "Does Priya have any children?",
      "No — Priya has a niece (Tara) and a nephew (Kiran), but no children of her own.",
      "absence", "no"),
    Q(134, "Is Priya a marine biologist?",
      "No — Priya is a robotics engineer. Her brother Rohan is the marine biologist.",
      "absence", "no"),
    Q(135, "Does Priya have a second cat?",
      "No — Priya has exactly one cat, Biryani.",
      "absence", "no"),
    Q(136, "Is Priya allergic to penicillin?",
      "No — Priya's allergy is to shellfish, not penicillin.",
      "absence", "no"),
    Q(137, "Does Priya currently run marathons?",
      "No — Priya used to run marathons but switched to cycling after a knee injury.",
      "absence", "no"),
    Q(138, "Does Priya eat meat?",
      "No — Priya is strictly vegetarian.",
      "absence", "no"),
    Q(139, "Is Priya learning Spanish?",
      "No — Priya is learning Japanese, not Spanish.",
      "absence", "no"),
    Q(140, "Does Priya drive a Vespa to work now?",
      "No — Priya used to commute on a Vespa scooter but now drives a Rivian.",
      "absence", "no"),
    Q(141, "Is Priya's husband a structural engineer at Cobalt Robotics?",
      "No — Priya's husband Arjun is a structural engineer at Halcyon Bridgeworks; Cobalt Robotics is where Priya herself works.",
      "absence", "no"),
    Q(142, "Does Priya still drink coffee?",
      "No — Priya gave up coffee two years ago and switched to chai.",
      "absence", "no"),

    # =================================================================== #
    # presence-control (8) — genuine "yes" questions about things that DO exist
    # =================================================================== #
    Q(143, "Does Priya have a sister?", "Yes — her older sister Anita.", "presence-control", "yes"),
    Q(144, "Does Priya own a cat?", "Yes — a tabby named Biryani.", "presence-control", "yes"),
    Q(145, "Does Priya play a musical instrument?", "Yes — the violin.", "presence-control", "yes"),
    Q(146, "Is Priya married?", "Yes — to her husband Arjun Mehta.", "presence-control", "yes"),
    Q(147, "Does Priya have a brother?", "Yes — her younger brother Rohan.", "presence-control", "yes"),
    Q(148, "Does Priya work at Cobalt Robotics?", "Yes — she leads the perception team there.", "presence-control", "yes"),
    Q(149, "Does Priya have a niece?", "Yes — her niece Tara.", "presence-control", "yes"),
    Q(150, "Is Priya learning Japanese?", "Yes — for a trip to Kyoto in November.", "presence-control", "yes"),
]


def main() -> None:
    sessions = [
        {"id": sid, "messages": [{"role": "user", "content": c} for c in msgs]}
        for sid, msgs in NEW_SESSIONS
    ]

    base = {
        "_comment": (
            "FULL Priya Sharma base persona. Extends personas/priya_sharma.json — every "
            "base fact preserved and consistent. Canonical first-person facts only (NO "
            "distractors); run generate_large_persona.py to bury them under hard-negative "
            "noise. Names/values chosen to avoid the distractor pools, Max Turnquist's "
            "world, and Jordan Rivera's world. Every non-absence gold answer is supported "
            "by exactly one canonical statement (enumeration by a complete set)."
        ),
        "persona_id": "priya_sharma_full",
        "name": "Priya Sharma",
        "description": (
            "Priya Sharma — dense full benchmark persona (~90 canonical facts, ~170 "
            "questions) with a rich entity/relationship graph (spouse, parents, two "
            "siblings with their own lives, in-laws, niece/nephew, friends & colleagues, "
            "pet, hobbies, possessions, media tastes) plus many temporal before/after "
            "updates and baited absence probes."
        ),
        "sessions": sessions,
        "eval_questions": QUESTIONS,
    }

    OUT.write_text(json.dumps(base, indent=2, ensure_ascii=False), encoding="utf-8")

    # ----------------------------- self-validation ----------------------------- #
    ids = [q["id"] for q in QUESTIONS]
    assert len(ids) == len(set(ids)), f"duplicate question ids: {[i for i in ids if ids.count(i) > 1]}"

    canonical_text = " ".join(
        m["content"] for s in sessions for m in s["messages"] if m["role"] == "user"
    ).lower()

    failures = []
    for q in QUESTIONS:
        if q["category"] in ("absence", "presence-control"):
            continue
        if not any(kw.lower() in canonical_text for kw in q["keywords"]):
            failures.append((q["id"], q["question"], q["keywords"]))

    cats = Counter(q["category"] for q in QUESTIONS)
    canon_msgs = sum(1 for s in sessions for m in s["messages"] if m["role"] == "user")

    print(f"Wrote {OUT}")
    print(f"  total questions: {len(QUESTIONS)}")
    print(f"  by category: {dict(cats)}")
    print(f"  canonical sessions: {len(sessions)}  canonical user-msgs: {canon_msgs}")
    if failures:
        print(f"\n  !! GROUNDING FAILURES ({len(failures)}):")
        for qid, question, kws in failures:
            print(f"     {qid}: {question}  keywords={kws}")
    else:
        print("  grounding: OK — every non-absence question has >=1 keyword in canonical text")


if __name__ == "__main__":
    main()
