"""Style presets.

The presets live in ``styles.json`` so the Node backend can read the same list
(labels, validation) without duplicating it. Each preset has a palette,
materials, a description for every furniture category the planner can ask for,
and an explicit list of things to avoid.
"""

import json
from pathlib import Path
from typing import Dict

STYLES_PATH = Path(__file__).with_name("styles.json")

REQUIRED_KEYS = ("label", "summary", "palette", "materials", "lighting_decor", "pieces", "avoid")


def load_styles(path: Path = STYLES_PATH) -> Dict[str, dict]:
    with open(path, encoding="utf-8") as f:
        styles = json.load(f)
    for key, preset in styles.items():
        missing = [k for k in REQUIRED_KEYS if k not in preset]
        if missing:
            raise ValueError(f"style '{key}' is missing {missing}")
    return styles


STYLES: Dict[str, dict] = load_styles()
STYLE_KEYS = tuple(STYLES.keys())


def get_style(key: str) -> dict:
    try:
        return STYLES[key]
    except KeyError:
        raise ValueError(f"unknown style '{key}'. Choose from: {', '.join(STYLE_KEYS)}") from None


def piece_description(style_key: str, category: str) -> str:
    """Style-specific description for a furniture category (falls back to a generic one)."""
    pieces = get_style(style_key)["pieces"]
    return pieces.get(category, f"{category.replace('_', ' ')} in {get_style(style_key)['label'].lower()} style")
