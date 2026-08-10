from ci.prompt_taxonomy import LIFE_DOMAIN_TAXONOMY, format_directional_considerations


def test_taxonomy_includes_core_domains() -> None:
    assert "Health & Wellness" in LIFE_DOMAIN_TAXONOMY
    assert "Personal Finances" in LIFE_DOMAIN_TAXONOMY
    assert "exercise" in LIFE_DOMAIN_TAXONOMY["Health & Wellness"]


def test_format_includes_domains_and_keywords() -> None:
    text = format_directional_considerations()
    assert "Directional considerations" in text
    assert "Health & Wellness: exercise" in text
    assert "Sleep: major night sleep, naps" in text
