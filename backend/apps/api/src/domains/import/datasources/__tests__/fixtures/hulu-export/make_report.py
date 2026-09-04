"""Regenerate the synthetic Hulu "Personal Information Report" fixture.

The real report is a PDF of tables and holds nothing but personal data, so
the checked-in fixture is a look-alike built from made-up rows. It keeps
every structural quirk the parser (`datasources/_hulu_report.ts`) has to
survive: key/value grids with a key that wraps onto a second line, table
cells that wrap at a space (episode titles), a table that runs across a page
break and repeats its header with different column widths, sections that
print only the "no information" sentence, and the header-less advertising
lists. It also keeps the sections the importer deliberately skips (Plan
Details, Subscription History, Profiles, Tastes, Cloud DVR, Devices And
Logins) so the tests can prove none of their text leaks into the watch
history.

Run with a Python that has reportlab (not part of the uv workspace):

    python3 make_report.py

It writes `rtk-report-24681357.pdf` beside itself and, when `pdftotext` is on
PATH, the `-layout` text the importer reads (`rtk-report-24681357.layout.txt`)
so the parser tests can run without poppler.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

HERE = Path(__file__).resolve().parent
PDF = HERE / "rtk-report-24681357.pdf"
LAYOUT = HERE / "rtk-report-24681357.layout.txt"

BLUE = colors.HexColor("#1f5f8b")

body = ParagraphStyle("body", fontName="Helvetica", fontSize=8, leading=10)
bold = ParagraphStyle("bold", parent=body, fontName="Helvetica-Bold")
page_title = ParagraphStyle(
    "page_title", fontName="Helvetica", fontSize=24, leading=30, textColor=BLUE
)
section_title = ParagraphStyle(
    "section_title", fontName="Helvetica", fontSize=14, leading=18, textColor=BLUE
)
blurb = ParagraphStyle("blurb", parent=body, fontSize=7, leading=9)
no_info = ParagraphStyle(
    "no_info", parent=body, fontName="Helvetica-Bold", alignment=TA_CENTER
)

NO_INFORMATION = (
    "We have no information about you or your account relevant to this "
    "section of the report."
)


def p(text: str, style: ParagraphStyle = body) -> Paragraph:
    return Paragraph(text, style)


def grid(rows: list[list[str]], widths: list[float]) -> Table:
    """A bordered table with generous row padding (poppler needs the gap)."""
    cells = [[p(c, bold) for c in rows[0]]] + [[p(c) for c in r] for r in rows[1:]]
    t = Table(cells, colWidths=widths, repeatRows=1)
    t.setStyle(
        TableStyle(
            [
                ("GRID", (0, 0), (-1, -1), 0.5, colors.black),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("TOPPADDING", (0, 0), (-1, -1), 7),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
            ]
        )
    )
    return t


def bare_list(items: list[str], width: float) -> Table:
    t = Table([[p(i)] for i in items], colWidths=[width])
    t.setStyle(
        TableStyle(
            [
                ("BOX", (0, 0), (-1, -1), 0.5, colors.black),
                ("LINEBELOW", (0, 0), (-1, -2), 0.5, colors.black),
                ("TOPPADDING", (0, 0), (-1, -1), 7),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
            ]
        )
    )
    return t


def kv(pairs: list[tuple[str, str]]) -> Table:
    """Two key/value pairs per line, keys bold, no borders."""
    rows = []
    for i in range(0, len(pairs), 2):
        chunk = pairs[i : i + 2]
        row: list = []
        for key, value in chunk:
            row += [p(key, bold), p(value)]
        while len(row) < 4:
            row += ["", ""]
        rows.append(row)
    t = Table(rows, colWidths=[40 * mm, 45 * mm, 40 * mm, 45 * mm])
    t.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    return t


def section(title: str) -> list:
    return [Spacer(1, 4 * mm), p(title, section_title), Spacer(1, 3 * mm)]


def page(title: str) -> list:
    return [p(title, page_title), Spacer(1, 3 * mm)]


WATCH_ROWS: list[list[str]] = [
    [
        "2026: A Virtual Insanity",
        "It's Always Sunny in Philadelphia",
        "18",
        "03 Sep 2026 04:42:48",
    ],
    ["The Raid: Redemption", "N/A", "N/A", "31 Aug 2026 06:14:01"],
    ["The Original Beef of Chicagoland", "The Bear", "5", "06 Jul 2026 07:16:38"],
    ["Caramel", "The Bear", "5", "04 Jul 2026 06:08:28"],
    [
        "Irrational Treasure [800th episode]",
        "The Simpsons",
        "37",
        "24 Feb 2026 07:14:37",
    ],
    ["Krapocracy Now!", "Krapopolis", "3", "24 Feb 2026 07:14:37"],
    [
        "Mall Part 2: Questions & Concerns",
        "Abbott Elementary",
        "5",
        "16 Jan 2026 05:34:32",
    ],
    ["The Real Monsters", "Alien: Earth", "1", "24 Sep 2025 06:03:23"],
    ["Eyewitness News 11PM", "ABC7 Eyewitness News", "0", "12 Sep 2025 06:15:00"],
]
# Filler so the table crosses a page and repeats its header.
WATCH_ROWS += [
    [f"Episode {n}", "Shifting Gears", "2", f"{n:02d} Aug 2025 05:{n:02d}:00"]
    for n in range(1, 31)
]
# Older history: Hulu prints no play time for these.
WATCH_ROWS += [
    [
        "The Nate Bargatze Shopping Cart Nestle!",
        "The Greatest Average American",
        "1",
        "",
    ],
    ["The Devil Wears Prada 2", "N/A", "N/A", ""],
    ["Seattle Kraken vs. Utah Mammoth (Kraken Broadcast)", "NHL Hockey", "N/A", ""],
    ["Eyewitness News 11PM", "ABC7 Eyewitness News", "0", ""],
    ["Eyewitness News 11PM", "ABC7 Eyewitness News", "0", ""],
    ["Nikki Glaser; Joel Edgerton; Debbie Gibson", "Jimmy Kimmel Live", "24", ""],
]


def build() -> list:
    story: list = []

    # Cover + personal / payment / subscription
    story += page("Personal Information Report")
    story.append(
        p(
            "<b>Specific Pieces of Personal Information.</b> Below is a report that "
            "includes the specific pieces of personal information we have collected "
            "from or about you, which includes data collected in the preceding twelve "
            "months, in connection with your Hulu account, subject to certain "
            "exceptions (e.g., we do not disclose passwords or answers to security "
            "questions).",
            blurb,
        )
    )
    story += section("Personal Details")
    story.append(
        kv(
            [
                ("First Name:", "Ada"),
                ("Birthdate:", "1990-01-02"),
                ("Last Name:", "Lovelace"),
                ("Gender:", "Prefer Not To Say"),
                ("Account Name:", "Ada Lovelace"),
                ("Home Zip:", "N/A"),
                ("Email:", "ada@example.com"),
            ]
        )
    )
    story += section("Payment Details")
    story.append(p(NO_INFORMATION, no_info))
    story += section("Subscription Details")
    story.append(
        kv(
            [
                ("Created:", "N/A"),
                ("Plan:", "Hulu (With Ads)"),
                ("Canceled:", "N/A"),
                ("Last Charged Date / Amount:", "N/A / 19.98 USD"),
                ("Status:", "GOOD_STANDING"),
                ("Next Charge Date / Amount:", "N/A / N/A"),
                ("Add Ons:", "Disney+ (With Ads), ESPN Select"),
            ]
        )
    )
    story.append(PageBreak())

    story += section("Plan Details")
    story.append(
        grid(
            [
                ["Name", "ID", "Next Charge", "Type", "Duration", "Next Program"],
                [
                    "Disney+ (With Ads)",
                    "verizon_discount_inclusion_offer_hybrid",
                    "11.99",
                    "Standard",
                    "",
                    "verizon_discount_inclusion_offer_hybrid",
                ],
                [
                    "ESPN Select",
                    "verizon_discount_inclusion_offer_hybrid",
                    "12.99",
                    "Standard",
                    "",
                    "verizon_discount_inclusion_offer_hybrid",
                ],
                [
                    "Hulu (With Ads)",
                    "verizon_discount_inclusion_offer_hybrid",
                    "11.99",
                    "Standard",
                    "",
                    "verizon_discount_inclusion_offer_hybrid",
                ],
            ],
            [32 * mm, 32 * mm, 30 * mm, 30 * mm, 30 * mm, 32 * mm],
        )
    )
    story.append(PageBreak())

    story += section("Subscription History")
    story.append(
        grid(
            [
                ["Time", "Type", "Description"],
                ["09 Oct 2023 14:26:15", "ENTITLEMENT_CHANGE", ""],
                [
                    "15 Mar 2023 09:37:19",
                    "CHANGE_DISCOUNT",
                    "change discounts from List(1075) to List(2656)",
                ],
                [
                    "15 Mar 2023 09:37:19",
                    "RECURRENCE_CHANGE_COMPONENT_STATUS",
                    "Component 15: change status from GOOD_STANDING to REMOVED",
                ],
                [
                    "02 Mar 2021 09:49:43",
                    "RECURRENCE_CHANGE_SUBSCRIPTION_STATUS",
                    "Change subscription status from Pending to GoodStanding",
                ],
                [
                    "02 Mar 2021 09:49:42",
                    "SITE_ACTIVATE_SUBSCRIPTION",
                    "customer type: VerizonViaDSS",
                ],
                ["02 Mar 2021 09:49:42", "SITE_CREATE_PENDING_SUBSCRIPTION", ""],
            ],
            [58 * mm, 60 * mm, 60 * mm],
        )
    )
    story.append(PageBreak())

    story += page("Settings And Preferences")
    story += section("Profiles")
    story.append(
        grid(
            [
                ["Profile name", "Kids Profile?", "Gender", "Birthdate", "Created At"],
                ["A", "No", "Male", "31 Oct 1950", "19 Aug 2022 17:00:00"],
                [
                    "Bronx",
                    "No",
                    "Prefer Not To Say",
                    "05 Dec 1954",
                    "01 Sep 2021 17:00:00",
                ],
            ],
            [36 * mm, 36 * mm, 36 * mm, 36 * mm, 36 * mm],
        )
    )
    story.append(PageBreak())

    story += section("MyStuff")
    story.append(p(NO_INFORMATION, no_info))
    story.append(PageBreak())

    story += section("Tastes and Onboarding")
    story.append(
        grid(
            [
                ["Name", "Genre"],
                ["New Girl", "Funny & Lighthearted"],
                ["The Bear", "Dark Comedy"],
                ["Only Murders in the Building", "Dark Comedy"],
                ["Quiz Lady", "Comedy Movies"],
                ["El Señor de los Cielos", "Spanish Language"],
            ],
            [90 * mm, 90 * mm],
        )
    )
    story.append(PageBreak())

    story += section("Cloud DVR")
    story.append(kv([("Quota:", "N/A"), ("Remaining Quota:", "N/A")]))
    story.append(p(NO_INFORMATION, no_info))
    story.append(PageBreak())

    story += page("Watch History")
    story.append(
        grid(
            [["Episode Name", "Series Name", "Season", "Last Played At"], *WATCH_ROWS],
            [45 * mm, 45 * mm, 45 * mm, 45 * mm],
        )
    )
    story.append(PageBreak())

    story += page("Devices And Logins")
    story.append(
        grid(
            [
                [
                    "Activation Date",
                    "Device Name",
                    "Device ID",
                    "Last Known Location",
                    "Last Login Time",
                    "IP Address",
                    "Home",
                ],
                [
                    "03 Sep 2026 13:28:00",
                    "Web Browser",
                    "61BFD7E8EF06D6409A3C79067B8F0894",
                    "Irvine,CA,US",
                    "03 Sep 2026 13:28:00",
                    "136.52.105.11",
                    "No",
                ],
                [
                    "26 Jun 2026 14:41:37",
                    "Web Browser",
                    "3F8A889BB40BE24A9D90A8D1BFB0ADCE",
                    "Laguna niguel,CA,US",
                    "26 Jun 2026 14:41:37",
                    "2600:8802:380c:d800:c8a3:895a:9e91:cf6d",
                    "No",
                ],
                [
                    "19 May 2024 11:40:49",
                    "Android - samsung SM-P613 samsung",
                    "ae1d1837fca12c64",
                    "Rancho cucamonga,CA,US",
                    "27 Mar 2025 05:45:43",
                    "136.52.40.30",
                    "No",
                ],
                [
                    "17 Jan 2024 10:09:35",
                    "Roku Express 4K+",
                    "0c8c5aae-6e81-512e-9fe8-626c22e47ee6",
                    "Bronx,NY,US",
                    "22 May 2025 21:04:35",
                    "67.84.181.233",
                    "No",
                ],
            ],
            [24 * mm, 24 * mm, 24 * mm, 30 * mm, 24 * mm, 24 * mm, 20 * mm],
        )
    )
    story.append(PageBreak())

    story += page("Advertising")
    story += section("Advertising Device IDs")
    story.append(bare_list(["c984923d-a3a8-5ab3-911c-29d68d3db58e"], 90 * mm))
    story += section("Advertising Brands History")
    story.append(
        bare_list(
            ["ABBOTT", "AIRBNB", "Arhaus", "CHEWY INC", "HULU", "Zevia"],
            90 * mm,
        )
    )
    return story


def main() -> None:
    doc = SimpleDocTemplate(
        str(PDF),
        pagesize=A4,
        leftMargin=15 * mm,
        rightMargin=15 * mm,
        topMargin=25 * mm,
        bottomMargin=20 * mm,
        title="Personal Information Report",
    )
    doc.build(build())
    print(f"wrote {PDF}")

    if shutil.which("pdftotext"):
        text = subprocess.run(
            ["pdftotext", "-layout", "-enc", "UTF-8", str(PDF), "-"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        LAYOUT.write_text(text, encoding="utf-8")
        print(f"wrote {LAYOUT}")
    else:
        print("pdftotext not found; layout text not refreshed")


if __name__ == "__main__":
    main()
