"""Regenerate the synthetic Disney "Data Subject Access Request" report fixture.

The real report is an Excel workbook printed to PDF and holds nothing but
personal data, so the checked-in fixture is a look-alike built from made-up
rows. It keeps every structural quirk the parser
(`datasources/_disney_report.ts`) has to survive: the TITLES WATCHED table's
bottom-aligned cells, so a wrapped Program or Season puts its earlier lines
ABOVE the dated line; a table that runs across a page break with no repeated
header; a Program that fills its column so `-layout` text would glue it to
its Season with one space; a row with no Program at all; a row with an
"Episode N" Program and no Season; byte-identical rows on one day; two
profiles and two services; and the sheets around it (profile sheet, account
and subscription details, the advertiser list, the parks sheet after the
table) so the tests can prove none of their text leaks into the history.

Run with a Python that has reportlab (not part of the uv workspace):

    python3 make_report.py

It writes `A1B2C3D4E5_Final.pdf` beside itself and, when `pdftotext` is on
PATH, the `-tsv` text the importer reads (`A1B2C3D4E5_Final.tsv`) so the
parser tests can run without poppler.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import (
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

HERE = Path(__file__).resolve().parent
STEM = "A1B2C3D4E5_Final"
PDF = HERE / f"{STEM}.pdf"
TSV = HERE / f"{STEM}.tsv"

body = ParagraphStyle("body", fontName="Helvetica", fontSize=7.5, leading=9.5)
bold = ParagraphStyle("bold", parent=body, fontName="Helvetica-Bold")
heading = ParagraphStyle("heading", fontName="Helvetica-Bold", fontSize=10, leading=13)

NO_INFO = "No specific personal information."


def p(text: str, style: ParagraphStyle = body) -> Paragraph:
    return Paragraph(text, style)


def sheet(rows: list[list[str]], widths: list[float], header: bool = True) -> Table:
    """An Excel-like grid: no borders, bottom-aligned cells, header once."""
    cells = []
    for i, r in enumerate(rows):
        cells.append([p(c, bold if header and i == 0 else body) for c in r])
    t = Table(cells, colWidths=widths, repeatRows=0)
    t.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "BOTTOM"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 3),
                ("TOPPADDING", (0, 0), (-1, -1), 2),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
                ("LINEBELOW", (0, 0), (-1, -1), 0.25, colors.HexColor("#d9d9d9")),
            ]
        )
    )
    return t


def kv(pairs: list[tuple[str, str]]) -> Table:
    return sheet([[k, v] for k, v in pairs], [180, 300], header=False)


# Near the real sheet's geometry: Date 52pt wide, Service 52, Profile 65,
# Program a cramped 63 (hence all the wrapping), Season the rest — widened a
# little where Helvetica runs wider than Excel's Calibri.
TITLE_WIDTHS = [58, 50, 58, 72, 250]

TITLE_ROWS: list[list[str]] = [
    ["Date", "Service", "Profile", "Program", "Season"],
    ["30 May, 2026", "disney", "Bo", "This Little Wiggy", "The Simpsons"],
    ["16 May, 2026", "disney", "Bo", "The Rescuers Down Under", ""],
    ["18 Apr, 2026", "disney", "Bo", "Tron: Ares", ""],
    [
        "6 Apr, 2026",
        "disney",
        "Bo",
        "Chapter 1: The Mandalorian",
        "The Mandalorian Season 1",
    ],
    ["6 Apr, 2026", "disney", "Bo", "Chapter 2: The Child", "The Mandalorian Season 1"],
    # The same episode twice on one day: once by number, once by title.
    ["9 Feb, 2026", "disney", "Ada", "Episode 8", "Wonder Man"],
    ["9 Feb, 2026", "disney", "Ada", "Yucca Valley", "Wonder Man"],
    # A four-line Program.
    [
        "25 Dec, 2025",
        "disney",
        "Bo",
        "A Marvel Studios Special Presentation: The Guardians of the Galaxy Holiday Special",
        "",
    ],
    # Program AND Season wrap.
    ["10 Jul, 2025", "disney", "Bo", "Episode 2", "Star Wars: Tales of the Underworld"],
    ["10 Jul, 2025", "disney", "Bo", "Friends", "Star Wars: Tales of the Underworld"],
    [
        "27 Nov, 2025",
        "disney",
        "Bo",
        "What If…The Hulk Fought the Mech Avengers?",
        "What If...?",
    ],
    # Wraps with punctuation at the break.
    [
        "31 Oct, 2024",
        "disney",
        "Ada",
        "Follow Me My Friend / To Glory at the End",
        "Agatha All Along",
    ],
    ["3 May, 2024", "disney", "Bo", "Motendo/Lifedeath - Part 1", "X-Men ’97"],
    ["17 May, 2024", "disney", "Bo", "Tolerance Is Extinction - Part 1", "X-Men ’97"],
    # No Season, but the Program is an episode number.
    ["25 May, 2025", "disney", "Bo", "Episode 13", ""],
    # Disney's own oddity, kept as printed.
    ["26 Apr, 2025", "disney", "Ada", "Episode 13", "Star Wars: Andor Season 13"],
    # Byte-identical rows on one day.
    ["24 Dec, 2025", "disney", "Bo", "The Guardians of the Galaxy Holiday Special", ""],
    ["24 Dec, 2025", "disney", "Bo", "The Guardians of the Galaxy Holiday Special", ""],
    # A second service.
    ["12 Oct, 2025", "espn", "Ada", "Michigan vs. Ohio State", "College Football"],
]
# Filler so the table crosses a page: the fixture's Program column is the
# real one's width, so these wrap like the real rows do.
TITLE_ROWS += [
    [
        f"{n} Aug, 2023",
        "disney",
        "Ada",
        f"Very Interesting, As An Astrogation Problem {n}",
        "Star Wars: Skeleton Crew",
    ]
    for n in range(30, 0, -1)
]
TITLE_ROWS += [
    # Fills the Program column exactly: `-layout` text glues it to the Season.
    ["5 Jul, 2023", "disney", "Ada", "Relics of the Old Republic", "Star Wars Rebels"],
    # No Program at all.
    ["5 Jul, 2023", "disney", "Bo", "", ""],
    ["5 Jul, 2023", "disney", "Bo", "Episode 2", "Secret Invasion Season 1"],
]


def build() -> list:
    story: list = []

    story += [p("PROFILE SHEET", heading), Spacer(1, 6)]
    story.append(
        kv(
            [
                (
                    "You can view and manage your account at (select 'My Account'):",
                    "https://my.disney.com/",
                ),
                ("Email(s)", "ada@example.com"),
                ("Disney Account Identifier(s)", "AB12"),
                ("Name(s)", "Ada Lovelace"),
                ("Username(s)", "ada"),
            ]
        )
    )
    story.append(PageBreak())

    story += [
        p("DISNEY+/ESPN+ DATA OUTPUT", heading),
        p("All times are in UTC"),
        Spacer(1, 8),
    ]
    story += [p("ACCOUNT DETAILS", heading), Spacer(1, 4)]
    story.append(
        sheet(
            [
                ["Partner", "State", "Blocks", "Email Verified", "Country Code"],
                ["disney", "Active", "{}", "TRUE", "US"],
                ["espn", "Active", "{}", "", ""],
            ],
            [70, 70, 70, 80, 80],
        )
    )
    story.append(Spacer(1, 8))
    story += [p("SUBSCRIPTION DETAILS", heading), Spacer(1, 4)]
    story.append(
        sheet(
            [
                ["Product Name", "Bundle", "Purchase Date", "Start Date", "Free Trial"],
                [
                    "Promotion - Disney+ Non-Recurring - US - 7.99 USD - 3 Year Offer",
                    "FALSE",
                    "13 Nov, 2019",
                    "13 Nov, 2019",
                    "FALSE",
                ],
            ],
            [140, 60, 80, 80, 60],
        )
    )
    story.append(Spacer(1, 8))
    story += [p("PROFILE DETAILS", heading), Spacer(1, 4)]
    story.append(
        sheet(
            [
                [
                    "Profile Name",
                    "Partner Name",
                    "Default",
                    "Kids Mode Enabled",
                    "App Language",
                ],
                ["Ada", "disney", "TRUE", "", "en"],
                ["Bo", "disney", "", "TRUE", "en"],
            ],
            [70, 70, 70, 90, 80],
        )
    )
    story.append(Spacer(1, 8))
    story += [
        p("PAYMENT DETAILS", heading),
        p("No payment details data found"),
        Spacer(1, 8),
    ]
    story += [p("ADVERTISING BRANDS", heading), Spacer(1, 4)]
    story.append(
        sheet(
            [
                ["Brand"],
                ["ABBOTT"],
                ["AMAZON.COM"],
                ["SOUTHERN CALIFORNIA BUICK-PONTIAC-GMC DEALERS, INC."],
                ["ZOCDOC"],
            ],
            [120],
        )
    )
    story.append(Spacer(1, 8))

    story += [p("TITLES WATCHED", heading), Spacer(1, 2)]
    story.append(sheet(TITLE_ROWS, TITLE_WIDTHS))
    story.append(PageBreak())

    story += [
        p("DISNEY PARKS &amp; RESORTS DATA OUTPUT", heading),
        p("PERSONALIZATION", heading),
        Spacer(1, 4),
    ]
    story.append(sheet([["type", "description"], ["Avatar", "Default"]], [120, 200]))
    story += [Spacer(1, 8), p("WALT DISNEY WORLD", heading), p(NO_INFO)]
    story.append(PageBreak())
    story += [p("DISNEY STORE DATA OUTPUT", heading), p(NO_INFO)]
    return story


def main() -> None:
    doc = SimpleDocTemplate(
        str(PDF),
        pagesize=letter,
        leftMargin=52,
        rightMargin=36,
        topMargin=54,
        bottomMargin=54,
        title="",
    )
    doc.build(build())
    print(f"wrote {PDF}")

    if shutil.which("pdftotext"):
        text = subprocess.run(
            ["pdftotext", "-tsv", "-enc", "UTF-8", str(PDF), "-"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        TSV.write_text(text, encoding="utf-8")
        print(f"wrote {TSV}")
    else:
        print("pdftotext not found; tsv text not refreshed")


if __name__ == "__main__":
    main()
