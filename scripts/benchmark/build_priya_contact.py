#!/usr/bin/env python3
"""
Build the "Priya Sharma (Max's friend)" CONTACT persona.

Folds the previously-standalone first-person Priya Sharma persona
(personas/priya_sharma_base.json) into the world of the benchmark's ONE user,
Max Turnquist. Priya becomes a person Max knows — a college friend and fellow
roboticist — so every canonical statement is now spoken by MAX in the third
person ("My friend Priya is a perception engineer ...").

Three transformations are applied (see task spec):
  1. First-person Priya facts  ->  third-person facts Max states about Priya.
  2. De-conflict ALL collisions with Max's world. Every entity that clashes with
     Max Turnquist's existing graph is renamed to a fresh value (see RENAME map
     below). Priya's people also use a first-name namespace distinct from the
     sibling "Jordan Rivera" fold-in.
  3. Re-categorize every question by hop-distance from MAX (Max is the user,
     Priya is 1 hop away):
       - Priya's OWN attributes      flat-recall -> relational
       - Priya's 1-hop relations     relational  -> multi-hop
       - Priya's 2-hop relations     multi-hop   -> multi-hop (unchanged)
       - temporal-update / enumeration / aggregation / absence /
         presence-control                          -> unchanged

Output: personas/priya_contact_base.json  (a BASE; canonical facts only — no
distractors. Run generate_large_persona.py on it to bury under noise.)
"""

from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path

OUT = Path("personas/priya_contact_base.json")

# --------------------------------------------------------------------------- #
# RENAME map: every entity in the original Priya persona that collides with Max
# Turnquist's world (old -> new). The new values are chosen to avoid Max's
# avoid-list AND the Jordan Rivera namespace. Husband "Arjun Mehta" and the rest
# of Priya's sub-network keep their original (non-colliding) names.
# --------------------------------------------------------------------------- #

RENAME = {
    # people
    "Anita": "Kavya",            # Priya's older sister
    "Deepak": "Mohan",           # father
    "Sunita": "Lalita",          # mother
    "Raj": "Vikram",             # brother-in-law (Kavya's husband)
    "Lena": "Bianca",            # best friend
    # places
    "Denver": "Phoenix",         # Priya's current city
    "Portland": "Eugene",        # parents' city
    "Chicago": "Boston",         # sister & brother-in-law's city
    "Kyoto": "Seoul",            # planned trip city
    # employers / orgs
    "Cobalt Robotics": "Verdant Automata",   # Priya's current employer
    "Cobalt": "Verdant Automata",            # (bare mentions)
    "Northwind Logistics": "Borealis Freight",
    "Northwind": "Borealis",
    "Stripe": "Plaid",           # best friend's employer
    # things / tastes
    "Biryani": "Pumpkin",        # the cat
    "Japanese": "Korean",        # language being learned
    "Rust": "Julia",             # current programming language
    "Pixel": "OnePlus",          # current phone
    "LASIK": "PRK",              # laser vision procedure
    # book (The Overstory by Richard Powers -> Cloud Atlas by David Mitchell)
    "The Overstory": "Cloud Atlas",
    "Overstory": "Cloud Atlas",
    "Richard Powers": "David Mitchell",
    # field / title tokens that collide ("Robotics", "Professor", "Synapse",
    # "Cannondale", "Logistics") are handled inline in the rewritten facts &
    # questions below rather than by blind substitution.
}

# --------------------------------------------------------------------------- #
# Canonical fact sessions — Max speaking, third-person, about Priya & network.
# These are full rewrites (not regex substitutions) so the prose reads naturally
# and every gold answer below is supported by exactly one of these lines.
# --------------------------------------------------------------------------- #

SESSIONS = [
    ("sess_01", [
        "My friend Priya Sharma currently lives in Phoenix; she moved there from Eugene last spring.",
        "Priya works at Verdant Automata now as a perception engineer; she left Borealis Freight back in March.",
        "At Verdant Automata, Priya leads the perception team.",
        "Priya's official job title at Verdant Automata is now Principal Perception Engineer — she got promoted from Senior Engineer in April.",
    ]),
    ("sess_02", [
        "Priya's husband is named Arjun Mehta.",
        "Arjun is a structural engineer at a firm called Halcyon Bridgeworks in Phoenix.",
        "Arjun plays the harmonium and sings at their temple on weekends.",
        "Arjun grew up in Nairobi and moved to the US for grad school.",
        "Priya and Arjun got married in Udaipur four years ago.",
    ]),
    ("sess_03", [
        "Priya's parents are Mohan and Lalita Sharma, and they still live in Eugene.",
        "Priya's father Mohan is a retired botany professor.",
        "Priya's mother Lalita runs a small textile shop called Marigold Looms.",
        "Priya's grandmother, whom she calls Naani Asha, lives with her parents in Eugene.",
        "Naani Asha was a radio playback singer in Lucknow when she was young.",
    ]),
    ("sess_04", [
        "Priya's older sister is Kavya, and she's an architect.",
        "Kavya lives in Boston with her husband Vikram.",
        "Last year Kavya designed a public library in Boston.",
        "Kavya and Vikram have two kids: Priya's niece Tara and her nephew Kiran.",
        "Priya's niece Tara is twelve and is a competitive figure skater.",
        "Priya's nephew Kiran is eight and is obsessed with building marble runs.",
    ]),
    ("sess_05", [
        "Priya's brother-in-law Vikram — Kavya's husband — is a cardiologist.",
        "Vikram works at a hospital called Lakeshore Cardiac Center in Boston.",
        "Vikram is an avid open-water swimmer and does a relay across the lake every summer.",
    ]),
    ("sess_06", [
        "Priya also has a younger brother named Rohan.",
        "Rohan is a marine biologist at the Coralline Institute.",
        "Rohan lives in Kochi, in India.",
        "Rohan is married to Priya's sister-in-law Fatima, who is a documentary filmmaker.",
        "Rohan and Fatima have a baby daughter named Zoya.",
    ]),
    ("sess_07", [
        "Priya's best friend is Bianca, and she works at Plaid.",
        "Bianca is a staff product manager at Plaid.",
        "Bianca lives in Oakland and commutes across the bay.",
        "Priya and Bianca met in college, where they were both on the rowing team.",
    ]),
    ("sess_08", [
        "Priya's close friend Meera Iyer is a pediatrician.",
        "Meera works at Saint Brigid Hospital in Phoenix.",
        "Meera owns a Bernese mountain dog named Laddoo.",
        "Priya and Meera do a pottery class together on Thursday evenings.",
    ]),
    ("sess_09", [
        "Priya's friend Gabriel Okonkwo is a wine sommelier.",
        "Gabriel runs the wine program at a restaurant in Reykjavik.",
        "Gabriel was Priya's roommate during her exchange semester abroad.",
    ]),
    ("sess_10", [
        "Priya's manager at Verdant Automata is named Helena Vance.",
        "Helena was an astronaut candidate before she went into the robotics field.",
        "On the perception team, Priya works most closely with her teammate Oscar Mbeki.",
        "Oscar joined Verdant Automata from a drone company called Skylark Dynamics.",
        "Priya's mentor from grad school, Dr. Nadia Brandt, teaches at Rutgers.",
    ]),
    ("sess_11", [
        "Priya's cat is named Pumpkin, a little tabby with strong opinions.",
        "Pumpkin is the only pet Priya has — just the one cat.",
        "Priya adopted Pumpkin from a shelter called Mile-High Rescue.",
    ]),
    ("sess_12", [
        "Priya rides a Trek Domane road bike.",
        "Priya drives a Rivian R1S — it's electric.",
        "Priya plays the violin; she picked it back up after years.",
        "Priya's everyday watch is a Withings ScanWatch.",
    ]),
    ("sess_13", [
        "Priya is reading Cloud Atlas by David Mitchell right now.",
        "Priya's comfort show is Schitt's Creek — she's rewatched it four times.",
        "Priya's favorite film of all time is Spirited Away.",
        "Priya's go-to karaoke song is Mr. Brightside.",
        "Priya is completely hooked on a podcast called Ologies.",
    ]),
    ("sess_14", [
        "Priya's favorite food is palak paneer — total childhood comfort food for her.",
        "Priya's favorite dessert is gulab jamun.",
        "Priya is allergic to shellfish; she found out the hard way at a wedding.",
        "Priya takes her chai with cardamom and no sugar.",
        "Priya is strictly vegetarian and has been her whole life.",
    ]),
    ("sess_15", [
        "Priya enjoys hiking — she did the Mount Falcon trail her first weekend in Phoenix.",
        "Priya has recently taken up indoor rock climbing at a gym called Summit Stone.",
        "Priya keeps a beehive on their rooftop and harvests honey in the fall.",
        "Priya is terrified of deep open water, ironic given her brother's job.",
        "Priya is learning Korean for a trip to Seoul in November.",
        "Priya collects vintage fountain pens — she has about a dozen.",
    ]),
    ("sess_16", [
        "Priya used to commute on an old Vespa scooter, but now she drives her Rivian.",
        "For years Priya's daily phone was a BlackBerry, but she switched to a OnePlus last year.",
        "Priya used to code mostly in MATLAB, but at Verdant Automata she works almost entirely in Julia now.",
        "Priya lived with three roommates in Eugene, but now she lives just with her husband Arjun in Phoenix.",
        "Priya gave up coffee two years ago and switched entirely to chai.",
    ]),
    ("sess_17", [
        "Priya used to wear contact lenses, but she got PRK the year before last and ditched them.",
        "Priya's old laptop was a clunky Dell, but her work machine now is a Framework laptop.",
        "Priya was learning the sitar for a while, but she set it aside and went back to the violin.",
        "Priya used to run marathons, but a knee injury pushed her toward cycling instead.",
        "Priya quit biting her nails after twenty years — she finally kicked it last winter.",
    ]),
    ("sess_18", [
        "Priya's favorite season is autumn, hands down.",
        "Priya is a green-tea-over-everything kind of person, but chai is her real love.",
        "Priya's lucky number is seven.",
        "Priya volunteers monthly at an engineering club for middle-schoolers called GearWorks.",
        "Priya left Borealis Freight, where she had been a logistics systems engineer, back in March.",
    ]),
]

# --------------------------------------------------------------------------- #
# Eval questions — the 150, reframed to third-person and re-categorized by
# hop-distance from Max. ids keep the `pq` prefix.
# --------------------------------------------------------------------------- #


def Q(qid, question, answer, category, *keywords):
    return {"id": qid, "question": question, "answer": answer,
            "keywords": list(keywords), "category": category}


QUESTIONS = [
    # ---- Priya's OWN attributes: flat-recall -> relational ----
    Q("pq01", "What instrument does Priya play?", "the violin", "relational", "violin"),
    Q("pq02", "What is the name of Priya's cat?", "Pumpkin", "relational", "Pumpkin"),
    Q("pq03", "What kind of cat does Priya have?", "a tabby", "relational", "tabby"),
    Q("pq04", "What is Priya's favorite food?", "palak paneer", "relational", "palak paneer", "palak"),
    Q("pq05", "What is Priya's favorite dessert?", "gulab jamun", "relational", "gulab jamun"),
    Q("pq06", "What book is Priya reading?", "Cloud Atlas by David Mitchell", "relational", "Cloud Atlas", "David Mitchell"),
    Q("pq07", "What kind of bike does Priya ride?", "a Trek Domane road bike", "relational", "Trek", "Domane"),
    Q("pq08", "What language is Priya learning?", "Korean", "relational", "Korean"),
    Q("pq09", "What outdoor hobby does Priya enjoy?", "hiking", "relational", "hiking", "hike"),
    Q("pq10", "What is Priya's comfort TV show?", "Schitt's Creek", "relational", "Schitt's Creek", "Schitt"),
    Q("pq11", "What is Priya's favorite film?", "Spirited Away", "relational", "Spirited Away"),
    Q("pq12", "What food is Priya allergic to?", "shellfish", "relational", "shellfish"),
    Q("pq13", "What is Priya's go-to karaoke song?", "Mr. Brightside", "relational", "Mr. Brightside", "Brightside"),
    Q("pq14", "What podcast is Priya hooked on?", "Ologies", "relational", "Ologies"),
    Q("pq15", "What car does Priya drive?", "a Rivian R1S", "relational", "Rivian"),
    Q("pq16", "What brand of watch does Priya wear?", "a Withings ScanWatch", "relational", "Withings", "ScanWatch"),
    Q("pq17", "What does Priya collect?", "vintage fountain pens", "relational", "fountain pens", "pens"),
    Q("pq18", "What climbing gym does Priya go to?", "Summit Stone", "relational", "Summit Stone"),
    Q("pq19", "What does Priya keep on her rooftop?", "a beehive", "relational", "beehive", "bees"),
    Q("pq20", "What is Priya afraid of?", "deep open water", "relational", "open water", "deep"),
    Q("pq21", "How does Priya take her chai?", "with cardamom and no sugar", "relational", "cardamom"),
    Q("pq22", "What is Priya's dietary preference?", "vegetarian", "relational", "vegetarian"),
    Q("pq23", "What is Priya's favorite season?", "autumn", "relational", "autumn"),
    Q("pq24", "What is Priya's lucky number?", "seven", "relational", "seven", "7"),
    Q("pq25", "What city is Priya planning to travel to?", "Seoul", "relational", "Seoul"),
    Q("pq26", "In what month is Priya's Seoul trip?", "November", "relational", "November"),
    Q("pq27", "What trail did Priya hike her first weekend in Phoenix?", "the Mount Falcon trail", "relational", "Mount Falcon"),
    Q("pq28", "What is Priya's current job title at Verdant Automata?", "Principal Perception Engineer", "relational", "Principal Perception Engineer", "Principal"),
    Q("pq29", "What team does Priya lead at Verdant Automata?", "the perception team", "relational", "perception"),
    Q("pq30", "Where did Priya adopt her cat?", "Mile-High Rescue", "relational", "Mile-High Rescue", "Mile-High"),
    Q("pq31", "What youth engineering club does Priya volunteer at?", "GearWorks", "relational", "GearWorks"),
    Q("pq32", "What city did Priya hike Mount Falcon in?", "Phoenix", "relational", "Phoenix"),
    Q("pq33", "What kind of engineer is Priya at Verdant Automata?", "a perception engineer", "relational", "perception engineer"),
    Q("pq34", "What sweetener does Priya use in her chai?", "none — she takes it with no sugar", "relational", "no sugar"),

    # ---- Priya's 1-hop relations: relational -> multi-hop ----
    Q("pq35", "What is the name of Priya's husband?", "Arjun Mehta", "multi-hop", "Arjun"),
    Q("pq36", "What is the name of Priya's older sister?", "Kavya", "multi-hop", "Kavya"),
    Q("pq37", "What is the name of Priya's younger brother?", "Rohan", "multi-hop", "Rohan"),
    Q("pq38", "What are the names of Priya's parents?", "Mohan and Lalita", "multi-hop", "Mohan", "Lalita"),
    Q("pq39", "What is the name of Priya's grandmother?", "Naani Asha", "multi-hop", "Asha", "Naani"),
    Q("pq40", "Who is Priya's brother-in-law (her sister's husband)?", "Vikram", "multi-hop", "Vikram"),
    Q("pq41", "What is the name of Priya's niece?", "Tara", "multi-hop", "Tara"),
    Q("pq42", "What is the name of Priya's nephew?", "Kiran", "multi-hop", "Kiran"),
    Q("pq43", "Who is Priya's best friend?", "Bianca", "multi-hop", "Bianca"),
    Q("pq44", "What is the name of Priya's pediatrician friend?", "Meera Iyer", "multi-hop", "Meera"),
    Q("pq45", "Who is Priya's friend that works as a sommelier?", "Gabriel Okonkwo", "multi-hop", "Gabriel"),
    Q("pq46", "Who is Priya's manager at Verdant Automata?", "Helena Vance", "multi-hop", "Helena"),
    Q("pq47", "Who is Priya's closest teammate on the perception team?", "Oscar Mbeki", "multi-hop", "Oscar"),
    Q("pq48", "Who was Priya's grad-school mentor?", "Dr. Nadia Brandt", "multi-hop", "Nadia", "Brandt"),
    Q("pq49", "What city do Priya's sister and brother-in-law live in?", "Boston", "multi-hop", "Boston"),
    Q("pq50", "Where do Priya's parents live?", "Eugene", "multi-hop", "Eugene"),
    Q("pq51", "What is the name of Priya's sister-in-law (her brother's wife)?", "Fatima", "multi-hop", "Fatima"),
    Q("pq52", "What is the name of Priya's brother Rohan's baby daughter?", "Zoya", "multi-hop", "Zoya"),
    Q("pq53", "Where does Priya's brother Rohan live?", "Kochi", "multi-hop", "Kochi"),
    Q("pq54", "What is Priya's sister Kavya's profession?", "architect", "multi-hop", "architect"),
    Q("pq55", "What does Priya's brother-in-law Vikram do for work?", "He is a cardiologist", "multi-hop", "cardiologist"),
    Q("pq56", "What pet does Priya's friend Meera own?", "a Bernese mountain dog named Laddoo", "multi-hop", "Laddoo", "Bernese"),
    Q("pq57", "Where did Priya and Bianca meet?", "in college, on the rowing team", "multi-hop", "college", "rowing"),
    Q("pq58", "What city was Priya married in?", "Udaipur", "multi-hop", "Udaipur"),

    # ---- Priya's 2-hop relations: multi-hop -> multi-hop (unchanged) ----
    Q("pq59", "What does Priya's husband do for work?", "structural engineer", "multi-hop", "structural engineer"),
    Q("pq60", "What firm does Priya's husband work at?", "Halcyon Bridgeworks", "multi-hop", "Halcyon"),
    Q("pq61", "What instrument does Priya's husband play?", "the harmonium", "multi-hop", "harmonium"),
    Q("pq62", "Where did Priya's husband grow up?", "Nairobi", "multi-hop", "Nairobi"),
    Q("pq63", "Where does Priya's best friend work?", "Plaid", "multi-hop", "Plaid"),
    Q("pq64", "What is Priya's best friend's job title?", "staff product manager", "multi-hop", "product manager"),
    Q("pq65", "What city does Priya's best friend Bianca live in?", "Oakland", "multi-hop", "Oakland"),
    Q("pq66", "What hospital does Priya's brother-in-law Vikram work at?", "Lakeshore Cardiac Center", "multi-hop", "Lakeshore"),
    Q("pq67", "What sport is Priya's brother-in-law Vikram into?", "open-water swimming", "multi-hop", "swimming", "swimmer"),
    Q("pq68", "What is Priya's niece Tara's sport?", "figure skating", "multi-hop", "figure skater", "skating"),
    Q("pq69", "What is Priya's nephew Kiran obsessed with building?", "marble runs", "multi-hop", "marble runs", "marble"),
    Q("pq70", "What does Priya's brother Rohan do for work?", "marine biologist", "multi-hop", "marine biologist"),
    Q("pq71", "What institute does Priya's brother Rohan work at?", "the Coralline Institute", "multi-hop", "Coralline"),
    Q("pq72", "What does Priya's sister-in-law Fatima do for work?", "documentary filmmaker", "multi-hop", "filmmaker", "documentary"),
    Q("pq73", "What hospital does Priya's friend Meera work at?", "Saint Brigid Hospital", "multi-hop", "Saint Brigid"),
    Q("pq74", "In what city does Priya's friend Gabriel work?", "Reykjavik", "multi-hop", "Reykjavik"),
    Q("pq75", "What was Priya's manager Helena before she went into robotics?", "an astronaut candidate", "multi-hop", "astronaut"),
    Q("pq76", "What company did Priya's teammate Oscar join Verdant Automata from?", "Skylark Dynamics", "multi-hop", "Skylark"),
    Q("pq77", "At what university does Priya's mentor Nadia Brandt teach?", "Rutgers", "multi-hop", "Rutgers"),
    Q("pq78", "What was Priya's grandmother's former profession?", "a radio playback singer", "multi-hop", "playback singer", "singer"),
    Q("pq79", "What is Priya's father Mohan's former profession?", "a botany professor", "multi-hop", "botany professor", "botany"),
    Q("pq80", "What shop does Priya's mother Lalita run?", "Marigold Looms", "multi-hop", "Marigold Looms", "Marigold"),
    Q("pq81", "What kind of public building did Priya's sister Kavya design last year?", "a public library", "multi-hop", "library"),
    Q("pq82", "In what city did Priya's grandmother sing on the radio?", "Lucknow", "multi-hop", "Lucknow"),

    # ---- temporal-update (unchanged category) ----
    Q("pq83", "What city does Priya currently live in?", "Phoenix", "temporal-update", "Phoenix"),
    Q("pq84", "What city did Priya live in before her current one?", "Eugene", "temporal-update", "Eugene"),
    Q("pq85", "What company does Priya currently work for?", "Verdant Automata", "temporal-update", "Verdant"),
    Q("pq86", "What company did Priya work for before her current job?", "Borealis Freight", "temporal-update", "Borealis"),
    Q("pq87", "What phone does Priya currently use?", "a OnePlus", "temporal-update", "OnePlus"),
    Q("pq88", "What phone did Priya use before her current one?", "a BlackBerry", "temporal-update", "BlackBerry"),
    Q("pq89", "What programming language does Priya mainly use now?", "Julia", "temporal-update", "Julia"),
    Q("pq90", "What programming language did Priya mainly use before Julia?", "MATLAB", "temporal-update", "MATLAB"),
    Q("pq91", "What does Priya drive now for her commute?", "a Rivian", "temporal-update", "Rivian"),
    Q("pq92", "What did Priya commute on before her current car?", "an old Vespa scooter", "temporal-update", "Vespa"),
    Q("pq93", "Who does Priya currently live with?", "her husband Arjun", "temporal-update", "Arjun"),
    Q("pq94", "What was Priya's living situation before her current one?", "she lived with three roommates", "temporal-update", "three roommates", "roommates"),
    Q("pq95", "What is Priya's current job title?", "Principal Perception Engineer", "temporal-update", "Principal"),
    Q("pq96", "What was Priya's job title before her promotion?", "Senior Engineer", "temporal-update", "Senior Engineer", "Senior"),
    Q("pq97", "How does Priya correct her vision now?", "she got PRK", "temporal-update", "PRK"),
    Q("pq98", "How did Priya correct her vision before PRK?", "she wore contact lenses", "temporal-update", "contact lenses", "contacts"),
    Q("pq99", "What is Priya's current work laptop?", "a Framework laptop", "temporal-update", "Framework"),
    Q("pq100", "What laptop did Priya use before her current one?", "an old Dell", "temporal-update", "Dell"),
    Q("pq101", "What endurance sport does Priya do now?", "cycling", "temporal-update", "cycling", "cycle"),
    Q("pq102", "What endurance sport did Priya do before her knee injury?", "running marathons", "temporal-update", "marathon"),
    Q("pq103", "What stringed instrument did Priya set aside before going back to the violin?", "the sitar", "temporal-update", "sitar"),
    Q("pq104", "What hot drink did Priya switch to after giving up coffee?", "chai", "temporal-update", "chai"),
    Q("pq105", "What drink did Priya give up two years ago?", "coffee", "temporal-update", "coffee"),
    Q("pq106", "What habit did Priya quit last winter after twenty years?", "biting her nails", "temporal-update", "biting", "nails"),

    # ---- enumeration (unchanged category) ----
    Q("pq107", "List all of Priya's siblings.", "Kavya (sister) and Rohan (brother)", "enumeration", "Kavya", "Rohan"),
    Q("pq108", "List all the cities Priya has lived in.", "Eugene and Phoenix", "enumeration", "Eugene", "Phoenix"),
    Q("pq109", "Name every company Priya has worked for.", "Verdant Automata and Borealis Freight", "enumeration", "Verdant", "Borealis"),
    Q("pq110", "Name Priya's parents.", "Mohan and Lalita", "enumeration", "Mohan", "Lalita"),
    Q("pq111", "List Priya's sister Kavya's children.", "Tara and Kiran", "enumeration", "Tara", "Kiran"),
    Q("pq112", "Who are all of Priya's close friends?", "Bianca, Meera, and Gabriel", "enumeration", "Bianca", "Meera", "Gabriel"),
    Q("pq113", "List Priya's hobbies and activities.",
      "hiking, rock climbing, violin, cycling, beekeeping, collecting fountain pens",
      "enumeration", "hiking", "climbing", "violin", "cycling", "beehive", "fountain pens"),
    Q("pq114", "List the musical instruments played by Priya and her husband.",
      "violin (Priya) and harmonium (Arjun)", "enumeration", "violin", "harmonium"),
    Q("pq115", "Name all of Priya's coworkers at Verdant Automata that she has mentioned.",
      "Helena Vance (manager) and Oscar Mbeki (teammate)", "enumeration", "Helena", "Oscar"),
    Q("pq116", "List the cities where Priya's relatives live.",
      "Eugene (parents), Boston (sister), and Kochi (brother)", "enumeration", "Eugene", "Boston", "Kochi"),
    Q("pq117", "Name all of Priya's pets.", "one cat, named Pumpkin", "enumeration", "Pumpkin"),
    Q("pq118", "List the in-laws Priya has gained through her siblings.",
      "Vikram (sister's husband) and Fatima (brother's wife)", "enumeration", "Vikram", "Fatima"),

    # ---- aggregation (unchanged category) ----
    Q("pq119", "How many siblings does Priya have?", "two (Kavya and Rohan)", "aggregation", "two", "2"),
    Q("pq120", "How many cities has Priya lived in?", "two (Eugene and Phoenix)", "aggregation", "two", "2"),
    Q("pq121", "How many companies has Priya worked for?", "two (Verdant Automata and Borealis Freight)", "aggregation", "two", "2"),
    Q("pq122", "How many children does Priya's sister Kavya have?", "two (Tara and Kiran)", "aggregation", "two", "2"),
    Q("pq123", "How many pets does Priya have?", "one (a cat named Pumpkin)", "aggregation", "one", "1"),
    Q("pq124", "Which of Priya's relatives is a doctor?", "Vikram, her brother-in-law, who is a cardiologist", "aggregation", "Vikram"),
    Q("pq125", "Which member of Priya's family is an architect?", "her sister Kavya", "aggregation", "Kavya"),
    Q("pq126", "How many close friends has Priya named?", "three (Bianca, Meera, and Gabriel)", "aggregation", "three", "3"),

    # ---- absence (unchanged category) ----
    Q("pq127", "Does Priya own a dog?",
      "No — Priya's only pet is a cat named Pumpkin. (The Bernese mountain dog Laddoo belongs to her friend Meera.)",
      "absence", "no"),
    Q("pq128", "Does Priya have a brother named Vikram?",
      "No — Priya's brother is named Rohan. Vikram is her brother-in-law (her sister Kavya's husband).",
      "absence", "no"),
    Q("pq129", "Is Priya a cardiologist?",
      "No — Priya is a perception engineer. Her brother-in-law Vikram is the cardiologist.",
      "absence", "no"),
    Q("pq130", "Does Priya play the harmonium?",
      "No — Priya plays the violin. Her husband Arjun is the one who plays the harmonium.",
      "absence", "no"),
    Q("pq131", "Has Priya ever lived in Boston?",
      "No — Priya has only lived in Eugene and Phoenix. Boston is where her sister Kavya lives.",
      "absence", "no"),
    Q("pq132", "Does Priya work at Plaid?",
      "No — Priya works at Verdant Automata. Plaid is where her best friend Bianca works.",
      "absence", "no"),
    Q("pq133", "Does Priya have any children?",
      "No — Priya has a niece (Tara) and a nephew (Kiran), but no children of her own.",
      "absence", "no"),
    Q("pq134", "Is Priya a marine biologist?",
      "No — Priya is a perception engineer. Her brother Rohan is the marine biologist.",
      "absence", "no"),
    Q("pq135", "Does Priya have a second cat?",
      "No — Priya has exactly one cat, Pumpkin.",
      "absence", "no"),
    Q("pq136", "Is Priya allergic to penicillin?",
      "No — Priya's allergy is to shellfish, not penicillin.",
      "absence", "no"),
    Q("pq137", "Does Priya currently run marathons?",
      "No — Priya used to run marathons but switched to cycling after a knee injury.",
      "absence", "no"),
    Q("pq138", "Does Priya eat meat?",
      "No — Priya is strictly vegetarian.",
      "absence", "no"),
    Q("pq139", "Is Priya learning Spanish?",
      "No — Priya is learning Korean, not Spanish.",
      "absence", "no"),
    Q("pq140", "Does Priya drive a Vespa to work now?",
      "No — Priya used to commute on a Vespa scooter but now drives a Rivian.",
      "absence", "no"),
    Q("pq141", "Is Priya's husband a structural engineer at Verdant Automata?",
      "No — Priya's husband Arjun is a structural engineer at Halcyon Bridgeworks; Verdant Automata is where Priya herself works.",
      "absence", "no"),
    Q("pq142", "Does Priya still drink coffee?",
      "No — Priya gave up coffee two years ago and switched to chai.",
      "absence", "no"),

    # ---- presence-control (unchanged category) ----
    Q("pq143", "Does Priya have a sister?", "Yes — her older sister Kavya.", "presence-control", "yes"),
    Q("pq144", "Does Priya own a cat?", "Yes — a tabby named Pumpkin.", "presence-control", "yes"),
    Q("pq145", "Does Priya play a musical instrument?", "Yes — the violin.", "presence-control", "yes"),
    Q("pq146", "Is Priya married?", "Yes — to her husband Arjun Mehta.", "presence-control", "yes"),
    Q("pq147", "Does Priya have a brother?", "Yes — her younger brother Rohan.", "presence-control", "yes"),
    Q("pq148", "Does Priya work at Verdant Automata?", "Yes — she leads the perception team there.", "presence-control", "yes"),
    Q("pq149", "Does Priya have a niece?", "Yes — her niece Tara.", "presence-control", "yes"),
    Q("pq150", "Is Priya learning Korean?", "Yes — for a trip to Seoul in November.", "presence-control", "yes"),
]

# Max Turnquist's avoid-list (DO NOT reuse any of these as a Priya-entity value).
AVOID = set("""Aerolith Anita Arrival Bashir Bear Biryani Blazers Caltech Cannondale
Cardoza Catan Chicago Civic Cobalt Deepak Denver Diego Diwali Felix Field Francisco
Fridman Fujifilm Garmin General Halford Hargrove Imani Ines Japanese Kyoto LASIK Labs
Lena Lex Lisbon Logistics Lumen Mac Magpie Meridian Mesa Mira Montreal Nana Northwind
Okafor Outback Overstory Phone Pixel Portland Powers Priyanka Professor Radiohead Raj
Richard Rim Robotics Rose Rust Sam San Stripe Subaru Sunita Synapse Theo ThinkPad Trail
University Vancouver Yusuf""".split())

# Words that legitimately appear in the *question/answer prose* about Max's role
# as narrator or in generic descriptions, and must NOT be flagged as Priya-entity
# collisions. "perception" team etc. are fine. The avoid-list is about reusing
# Max's specific *entity names*; these generic/structural tokens are allowed.
AVOID_PROSE_OK = {
    # generic profession/field words that are not Max-specific entity names but
    # happen to share a token with the avoid-list:
    "Robotics",   # appears only as "the robotics field" (generic), pq75 question
}


def main() -> None:
    base = {
        "_comment": (
            "Priya Sharma folded into Max Turnquist's world as his college "
            "friend / fellow roboticist. Canonical THIRD-PERSON facts spoken by "
            "Max about Priya & her network (no distractors). Every entity that "
            "collided with Max's world was renamed (see build_priya_contact.py "
            "RENAME map). Questions re-categorized by hop-distance from Max "
            "(Priya = 1 hop). Run generate_large_persona.py to add noise."
        ),
        "persona_id": "priya_contact",
        "name": "Priya Sharma (Max's friend)",
        "description": (
            "Priya Sharma — a contact in Max Turnquist's world (college friend, "
            "fellow roboticist). 150 questions over her full entity/relationship "
            "graph (spouse, parents, siblings, in-laws, niece/nephew, friends, "
            "colleagues, pet, hobbies, possessions, media tastes), all stated by "
            "Max in third person, with temporal updates and baited absence probes."
        ),
        "sessions": [
            {"id": sid, "messages": [{"role": "user", "content": c} for c in msgs]}
            for sid, msgs in SESSIONS
        ],
        "eval_questions": QUESTIONS,
    }

    # ----- self-validation ------------------------------------------------- #
    ids = [q["id"] for q in base["eval_questions"]]
    assert len(ids) == len(set(ids)), \
        f"duplicate question ids: {[i for i in ids if ids.count(i) > 1]}"
    assert all(i.startswith("pq") for i in ids), "all ids must use the pq prefix"

    canon_text = " ".join(
        m["content"] for s in base["sessions"] for m in s["messages"]
        if m["role"] == "user"
    )
    canon_lower = canon_text.lower()

    # Grounding: every non-absence/presence question must have >=1 keyword in the
    # concatenated canonical statements (case-insensitive).
    grounding_failures = []
    for q in base["eval_questions"]:
        if q["category"] in ("absence", "presence-control"):
            continue
        if not any(kw.lower() in canon_lower for kw in q["keywords"]):
            grounding_failures.append((q["id"], q["keywords"]))

    # Avoid-list collision check: none of Max's entity names may appear as a
    # word in the canonical statements (these describe Priya's world).
    collisions = []
    for name in AVOID:
        if name in AVOID_PROSE_OK:
            continue
        if re.search(r"\b" + re.escape(name) + r"\b", canon_text):
            collisions.append(name)

    cats = Counter(q["category"] for q in base["eval_questions"])
    canon_msgs = sum(1 for s in base["sessions"] for m in s["messages"]
                     if m["role"] == "user")

    print("=== build_priya_contact ===")
    print(f"questions: {len(base['eval_questions'])}")
    print(f"by category: {dict(cats)}")
    print(f"canonical sessions: {len(base['sessions'])}  canonical user-msgs: {canon_msgs}")
    print(f"grounding failures: {len(grounding_failures)}")
    for gid, kws in grounding_failures:
        print(f"  - {gid}: none of {kws} found in canonical text")
    print(f"avoid-list collisions: {len(collisions)}")
    for c in sorted(collisions):
        print(f"  - {c}")

    assert not grounding_failures, "grounding failures present — fix before writing"
    assert not collisions, f"avoid-list collisions present: {sorted(collisions)}"

    OUT.write_text(json.dumps(base, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {OUT}  (clean: 0 grounding failures, 0 avoid-list collisions)")


if __name__ == "__main__":
    main()
