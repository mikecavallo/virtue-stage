"""Step 2: turn the room analysis + style into a concrete staging plan.

The plan is deterministic (no model call), so its rules are unit-tested:
- furniture count and piece sizes scale with the room's size class;
- wall-anchored pieces never go on a wall with a door/doorway/closet/stairs,
  and medium/tall pieces never go against a window, radiator or fireplace wall;
- the bed goes on a solid headwall;
- rugs are sized by room rules and never cover floor vents;
- kitchens and bathrooms get light styling only.

Walls are named relative to the camera (left, back = facing the camera, right).
"""

from copy import deepcopy
from typing import Dict, List, Optional

from .analysis import CLEARANCE_TYPES, DO_NOT_COVER_TYPES
from .styles import get_style, piece_description

SIZE_ORDER = {"small": 0, "medium": 1, "large": 2}
CAMERA_WALLS = ("back", "left", "right")
BLOCKING_FOR_ALL = CLEARANCE_TYPES | {"radiator"}
BLOCKING_FOR_TALL = {"window", "fireplace", "built_in", "radiator", "cabinetry"}

ROOM_CATEGORY = {
    "living-room": "living", "studio": "living", "basement": "living",
    "bedroom": "bedroom", "attic": "bedroom",
    "dining-room": "dining", "kitchen": "kitchen", "bathroom": "bathroom",
    "office": "office", "nursery": "nursery", "sunroom": "sunroom", "patio": "outdoor",
}

STYLING_LEVEL = {"kitchen": "minimal", "bathroom": "accessories_only"}
ART_HOSTS = ("bed", "crib", "sofa", "sideboard", "dresser", "media_console", "desk")


def P(category, height, anchor, placement, sizes=None, min_size="small", condition=None, pid=None):
    """Piece template. ``sizes`` maps size class -> size text. ``anchor``: headwall | wall | float | surface."""
    return {"id": pid or category, "category": category, "height": height, "anchor": anchor,
            "placement": placement, "sizes": sizes or {}, "min_size": min_size, "condition": condition}


ROOM_RULES: Dict[str, dict] = {
    "living": {
        "pieces": [
            P("sofa", "low", "wall", "primary seating facing the room's focal point (fireplace, view or the longest open wall); its back may sit under a window but never in front of a door",
              {"small": "apartment-size, about 72-78 in wide", "medium": "about 84 in wide", "large": "about 90-96 in wide"}),
            P("accent_chair", "low", "float", "angled toward the sofa to close the conversation area, about 8 ft or less from the sofa",
              {"medium": "one or two chairs", "large": "two matching chairs"}, min_size="medium"),
            P("coffee_table", "low", "float", "centered in front of the sofa with 14-18 in between table and sofa seat",
              {"small": "small round, about 30-36 in", "medium": "about 48 in long, roughly two-thirds the sofa length", "large": "about 54-60 in long"}),
            P("side_table", "low", "float", "at one sofa arm",
              {"small": "one", "medium": "one", "large": "two, one at each sofa arm"}),
            P("floor_lamp", "tall", "float", "in a corner or beside the sofa, away from doors and window glass", min_size="medium"),
            P("media_console", "low", "wall", "on a solid wall facing the seating (no TV)", min_size="large"),
            P("art", "medium", "wall", "one piece centered above the sofa or console, about 2/3 the furniture width, bottom edge 8-10 in above it; never on window glass or a door"),
            P("plant", "tall", "float", "one plant in an empty corner that is not a walkway"),
        ],
        "rug": {"small": "5x8 ft", "medium": "8x10 ft", "large": "9x12 ft",
                "rule": "centered on the conversation area with the front legs of every seat on the rug; 8-18 in of bare floor visible between the rug and the walls"},
        "rules": ["Create one conversation area; seats within about 8 ft of each other, facing each other or the focal point.",
                  "Leave walkways of at least 36 in between doorways and through the room."],
    },
    "bedroom": {
        "pieces": [
            P("bed", "medium", "headwall", "headboard against a solid wall with no window, door or closet, ideally the wall facing the entry; centered on that wall",
              {"small": "full or queen", "medium": "queen", "large": "king"}),
            P("bedding", "low", "surface", "on the bed, neatly made, pillows propped against the headboard"),
            P("nightstand", "low", "float", "flanking the bed at mattress height",
              {"small": "one or two slim nightstands, about 18-20 in wide", "medium": "two, about 24 in wide", "large": "two, about 28 in wide"}),
            P("table_lamp", "low", "surface", "on the nightstands"),
            P("dresser", "medium", "wall", "on a solid wall, not under a window and not blocking a door or closet", min_size="medium"),
            P("bench", "low", "float", "at the foot of the bed", min_size="large"),
            P("accent_chair", "low", "float", "in a corner with a small side table, out of walkways", min_size="large"),
            P("art", "medium", "wall", "one piece centered above the headboard, about 2/3 the bed width"),
            P("plant", "medium", "float", "one plant on a nightstand or in a corner", min_size="medium"),
        ],
        "rug": {"small": "6x9 ft", "medium": "8x10 ft", "large": "9x12 ft",
                "rule": "under the lower two-thirds of the bed, extending 18-24 in beyond each side and the foot"},
        "rules": ["Leave at least 24-30 in on each side of the bed and 36 in at the foot.",
                  "Do not place the bed under a window, across a doorway or in front of a closet."],
    },
    "dining": {
        "pieces": [
            P("dining_table", "low", "float", "centered in the room or under the existing ceiling fixture, with at least 36 in clearance on every side",
              {"small": "round, about 36-42 in, seats 4", "medium": "rectangular, about 60-72 in, seats 6", "large": "rectangular, about 84-96 in, seats 8"},
              pid="dining_table"),
            P("dining_chair", "low", "float", "evenly around the table, pushed in",
              {"small": "4 chairs", "medium": "6 chairs", "large": "8 chairs"}),
            P("sideboard", "medium", "wall", "against a solid wall, not under a window and not near a doorway", min_size="medium"),
            P("art", "medium", "wall", "one piece centered above the sideboard or on the main wall", min_size="medium"),
            P("kitchen_accents", "low", "surface", "a simple centerpiece on the table, nothing else"),
        ],
        "rug": {"small": None, "medium": "8x10 ft", "large": "9x12 ft",
                "rule": "extends at least 24 in beyond the table edge on every side so pulled-out chairs stay on it"},
        "rules": ["Table size must leave 36 in clearance to walls and walkways; choose smaller if in doubt."],
    },
    "kitchen": {
        "pieces": [
            P("bar_stool", "low", "float", "tucked under the existing island or peninsula overhang only",
              {"small": "two", "medium": "two or three", "large": "three"}, condition="island"),
            P("kitchen_accents", "low", "surface", "on the counter, grouped in one or two spots; leave most counter space clear"),
        ],
        "rug": {"small": None, "medium": None, "large": None, "rule": "no rug"},
        "rules": ["Minimal styling only: do not add furniture to the kitchen floor.",
                  "Do not change cabinets, countertops, backsplash, hardware or appliances."],
    },
    "bathroom": {
        "pieces": [
            P("bath_accents", "low", "surface", "towels folded on existing bars or hooks or the vanity; a small tray and plant on the vanity"),
        ],
        "rug": {"small": "bath mat", "medium": "bath mat", "large": "bath mat",
                "rule": "one small bath mat in front of the tub or vanity"},
        "rules": ["Accessories only: no furniture.",
                  "Do not add towel bars, mirrors, shower curtains or fixtures; do not change tile, vanity, glass or plumbing."],
    },
    "office": {
        "pieces": [
            P("desk", "low", "wall", "facing into the room or perpendicular to the window for natural light, never blocking a door",
              {"small": "compact, about 42-48 in", "medium": "about 55-60 in", "large": "about 60-72 in"}),
            P("desk_chair", "low", "float", "at the desk"),
            P("table_lamp", "low", "surface", "on the desk with a closed laptop-free surface"),
            P("bookshelf", "tall", "wall", "on a solid wall away from windows and doors, lightly styled", min_size="medium"),
            P("accent_chair", "low", "float", "reading chair in a corner", min_size="large"),
            P("art", "medium", "wall", "one piece on the main wall", min_size="medium"),
            P("plant", "medium", "float", "one plant in a corner"),
        ],
        "rug": {"small": None, "medium": "5x8 ft", "large": "8x10 ft",
                "rule": "under the desk and chair, large enough that the chair stays on it"},
        "rules": ["No computers with visible screens, no papers, no cables."],
    },
    "nursery": {
        "pieces": [
            P("crib", "medium", "headwall", "against a solid wall away from windows, blinds cords and radiators"),
            P("glider", "low", "float", "in a corner near the crib", min_size="medium"),
            P("dresser", "medium", "wall", "on a solid wall; doubles as changing table", min_size="medium"),
            P("art", "medium", "wall", "one soft print above the dresser or crib"),
        ],
        "rug": {"small": "5x8 ft", "medium": "5x8 ft", "large": "8x10 ft", "rule": "soft rug in the open floor area"},
        "rules": ["Keep it calm and uncluttered; no stuffed-animal piles, no names or lettering."],
    },
    "sunroom": {
        "pieces": [
            P("accent_chair", "low", "float", "pair of chairs angled toward each other or the view",
              {"small": "two", "medium": "two", "large": "two"}),
            P("sofa", "low", "wall", "below the windows only if it stays below the sill", min_size="medium"),
            P("coffee_table", "low", "float", "between the seats", min_size="medium"),
            P("side_table", "low", "float", "between the chairs"),
            P("plant", "tall", "float", "two or three plants near the windows, not blocking them"),
        ],
        "rug": {"small": "5x8 ft", "medium": "8x10 ft", "large": "8x10 ft",
                "rule": "under the seating group"},
        "rules": ["Keep every window unobstructed; nothing above the sill line."],
    },
    "outdoor": {
        "pieces": [
            P("outdoor_seating", "low", "float", "grouped on the deck/patio surface facing the view or each other",
              {"small": "two chairs and a small side table", "medium": "a loveseat and two chairs", "large": "a sofa and two chairs"}),
            P("outdoor_table", "low", "float", "on a level area with clearance to steps and doors", min_size="large"),
            P("outdoor_accents", "medium", "float", "planters at corners or flanking the door, not on steps"),
        ],
        "rug": {"small": None, "medium": "outdoor rug under the seating", "large": "outdoor rug under the seating",
                "rule": "outdoor rug sized to the seating group"},
        "rules": ["Do not change siding, railings, decking material, landscaping, sky or the view.",
                  "Keep steps, doors and gates clear."],
    },
}


def _size_ok(min_size: str, size_class: str) -> bool:
    return SIZE_ORDER[size_class] >= SIZE_ORDER[min_size]


def wall_features(analysis: dict) -> Dict[str, set]:
    """Map camera-relative wall -> set of fixed element types on it."""
    walls = {w: set() for w in CAMERA_WALLS}
    for el in analysis.get("fixed_elements", []):
        if el.get("wall") in walls:
            walls[el["wall"]].add(el["type"])
    return walls


def eligible_walls(analysis: dict, height: str) -> List[str]:
    feats = wall_features(analysis)
    blocked = BLOCKING_FOR_ALL | (BLOCKING_FOR_TALL if height in ("medium", "tall") else set())
    return [w for w in CAMERA_WALLS if not (feats[w] & blocked)]


def choose_wall(analysis: dict, height: str, used: Dict[str, int], prefer=CAMERA_WALLS) -> Optional[str]:
    """Pick a camera-relative wall for a wall-anchored piece, or None (free-standing)."""
    candidates = eligible_walls(analysis, height)
    if not candidates:
        return None
    feats = wall_features(analysis)
    order = {w: i for i, w in enumerate(prefer)}
    # Prefer walls with fewer features and fewer pieces already against them.
    return min(candidates, key=lambda w: (used.get(w, 0), len(feats[w]), order.get(w, 9)))


def has_island(analysis: dict) -> bool:
    text = " ".join(el.get("description", "") + " " + el.get("type", "")
                    for el in analysis.get("fixed_elements", [])).lower()
    return "island" in text or "peninsula" in text or "breakfast bar" in text


def keep_clear_list(analysis: dict) -> List[str]:
    items = []
    for el in analysis.get("fixed_elements", []):
        where = f" on the {el['wall']} wall" if el.get("wall") in CAMERA_WALLS else ""
        desc = el["description"]
        if el["type"] in CLEARANCE_TYPES:
            items.append(f"{desc}{where}: keep at least 36 in of clear floor in front of it; nothing in its swing or opening")
        elif el["type"] in ("window", "sliding_door"):
            items.append(f"{desc}{where}: do not block or cover it; nothing taller than the sill in front of it")
        elif el["type"] in DO_NOT_COVER_TYPES:
            items.append(f"{desc}{where}: leave fully visible and uncovered (no rug, furniture or decor over it)")
        elif el["type"] == "fireplace":
            items.append(f"{desc}{where}: keep the hearth clear; it is the focal point")
    for path in analysis.get("traffic_paths", []):
        items.append(f"walkway {path}: keep at least 36 in wide and clear")
    return items


def build_plan(analysis: dict, style_key: str, room_type: Optional[str] = None,
               reference_plan: Optional[dict] = None) -> dict:
    style = get_style(style_key)
    room_type = room_type or analysis.get("room_type") or "living-room"
    category = ROOM_CATEGORY.get(room_type, "living")
    size = analysis.get("size_class", "medium")
    if room_type == "studio":
        size = "small"
    rules = ROOM_RULES[category]

    plan = {
        "version": 1,
        "style": style_key,
        "style_label": style["label"],
        "style_summary": style["summary"],
        "room_type": room_type,
        "room_category": category,
        "size_class": size,
        "styling_level": STYLING_LEVEL.get(category, "full"),
        "palette": list(style["palette"]),
        "materials": list(style["materials"]),
        "lighting_decor": style["lighting_decor"],
        "avoid": list(style["avoid"]),
        "rules": list(rules["rules"]),
        "keep_clear": keep_clear_list(analysis),
        "pieces": [],
        "rug": None,
        "consistency": None,
    }

    if reference_plan and reference_plan.get("pieces"):
        return _plan_from_reference(plan, reference_plan)

    used: Dict[str, int] = {}
    headwalls: set = set()
    # The headwall piece (bed/crib) chooses first so it gets the best solid wall.
    templates = sorted(rules["pieces"], key=lambda t: 0 if t["anchor"] == "headwall" else 1)
    for t in templates:
        if not _size_ok(t["min_size"], size):
            continue
        if t["condition"] == "island" and not has_island(analysis):
            continue
        piece = {
            "id": t["id"],
            "category": t["category"],
            "description": piece_description(style_key, t["category"]),
            "size": t["sizes"].get(size) or t["sizes"].get("medium") or "",
            "height": t["height"],
            "anchor": t["anchor"],
            "placement": t["placement"],
            "wall": None,
        }
        if t["anchor"] in ("headwall", "wall"):
            wall = None
            if t["category"] == "art":
                # Art hangs above the main wall piece when that wall can take it.
                hosts = [p for p in plan["pieces"] if p["category"] in ART_HOSTS and p.get("wall")]
                ok = eligible_walls(analysis, t["height"])
                wall = next((p["wall"] for p in hosts if p["wall"] in ok), None)
            wall = wall or choose_wall(analysis, t["height"], used)
            if (wall and t["anchor"] == "wall" and t["category"] != "art" and wall in headwalls
                    and size != "large"):
                # Only wall left is the bed's headwall: drop the piece rather than crowd the room.
                plan.setdefault("omitted", []).append(
                    f"{t['id']}: no free solid wall besides the {wall} headwall in a {size} room")
                continue
            piece["wall"] = wall
            if wall:
                used[wall] = used.get(wall, 0) + 1
                if t["anchor"] == "headwall":
                    headwalls.add(wall)
                verb = "on" if t["category"] == "art" else "against"
                piece["placement"] = f"{verb} the {wall} wall: {t['placement']}"
            else:
                piece["anchor"] = "float"
                piece["placement"] = (f"free-standing, because every visible wall has a door, window or other feature: "
                                      f"{t['placement']}; keep 36 in from any door")
        plan["pieces"].append(piece)

    # Keep the original room-rule order for readability (headwall-first was only for wall choice).
    order = {t["id"]: i for i, t in enumerate(rules["pieces"])}
    plan["pieces"].sort(key=lambda p: order.get(p["id"], 99))

    rug_size = rules["rug"].get(size)
    has_floor_vent = any(el["type"] == "vent" and el.get("wall") in (None, "floor")
                         for el in analysis.get("fixed_elements", []))
    if rug_size:
        rug_rule = rules["rug"]["rule"]
        if has_floor_vent:
            rug_rule += "; never over a floor vent"
        plan["rug"] = {"size": rug_size, "rule": rug_rule, "description": piece_description(style_key, "rug")}
    if category in ("kitchen", "bathroom") or analysis.get("occupancy") in ("furnished", "partially_furnished"):
        plan["rules"].append("Do not move, remove or restyle anything already in the room.")
    return plan


def _plan_from_reference(plan: dict, reference_plan: dict) -> dict:
    """Additional angle of an already-staged room: same pieces, positions tied to the room, not the camera."""
    plan["palette"] = reference_plan.get("palette", plan["palette"])
    plan["materials"] = reference_plan.get("materials", plan["materials"])
    plan["rug"] = deepcopy(reference_plan.get("rug"))
    for p in reference_plan["pieces"]:
        q = deepcopy(p)
        q["wall"] = None  # camera-relative walls differ between angles
        q["placement"] = ("exactly where it stands in the reference image, in the same position relative to the room's "
                          "windows, doors and walls; omit it only if it would be outside this camera's view")
        plan["pieces"].append(q)
    plan["consistency"] = {
        "reference_plan_style": reference_plan.get("style"),
        "rule": "Use only the pieces listed here, identical in model, color, material and size to the reference image. "
                "Do not add, drop or substitute pieces that would be visible from this angle.",
    }
    return plan


def validate_plan(plan: dict, analysis: dict) -> List[str]:
    """Return rule violations (empty list = OK). Used by tests and recorded in metadata."""
    problems = []
    feats = wall_features(analysis)
    for p in plan["pieces"]:
        wall = p.get("wall")
        if not wall:
            continue
        on_wall = feats.get(wall, set())
        if on_wall & BLOCKING_FOR_ALL:
            problems.append(f"{p['id']} is against the {wall} wall, which has {sorted(on_wall & BLOCKING_FOR_ALL)}")
        if p["height"] in ("medium", "tall") and on_wall & BLOCKING_FOR_TALL:
            problems.append(f"{p['id']} ({p['height']}) is against the {wall} wall, which has {sorted(on_wall & BLOCKING_FOR_TALL)}")
    return problems
