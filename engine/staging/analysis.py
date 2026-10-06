"""Step 1: analyze the room photo with a vision model and normalize the result.

The analysis drives everything downstream: which furniture fits (size class),
where it can go (fixed elements and walls), what must not change (preserve
list and the fidelity regions) and how to light it (light direction and color).
"""

from copy import deepcopy
from typing import List, Optional

from PIL import Image

from .providers import Provider

ROOM_TYPES = ("living-room", "bedroom", "kitchen", "dining-room", "bathroom", "office", "nursery",
              "studio", "basement", "attic", "sunroom", "patio")
OCCUPANCY = ("empty", "partially_furnished", "furnished", "cluttered")
SIZE_CLASSES = ("small", "medium", "large")
WALLS = ("left", "back", "right", "ceiling", "floor")
FIXED_TYPES = ("window", "door", "doorway", "sliding_door", "closet", "outlet", "vent", "radiator",
               "fireplace", "built_in", "ceiling_fixture", "ceiling_fan", "stairs", "column",
               "cabinetry", "appliance", "plumbing_fixture", "other")
# Fixed elements that need floor clearance in front of them.
CLEARANCE_TYPES = {"door", "doorway", "sliding_door", "closet", "stairs"}
# Elements furniture must not cover or sit against (heat, airflow, access).
DO_NOT_COVER_TYPES = {"vent", "radiator", "outlet"}

ANALYSIS_SCHEMA = {
    "type": "object",
    "properties": {
        "room_type": {"type": "string", "enum": list(ROOM_TYPES)},
        "room_type_confidence": {"type": "number"},
        "is_interior": {"type": "boolean"},
        "occupancy": {"type": "string", "enum": list(OCCUPANCY)},
        "existing_items": {"type": "array", "items": {"type": "string"}},
        "camera": {
            "type": "object",
            "properties": {
                "height": {"type": "string", "enum": ["low", "eye_level", "high"]},
                "angle": {"type": "string", "enum": ["straight_on", "two_point", "corner", "oblique"]},
                "pitch": {"type": "string", "enum": ["level", "tilted_up", "tilted_down"]},
                "lens": {"type": "string", "enum": ["normal", "wide", "ultra_wide"]},
                "vanishing_direction": {"type": "string"},
            },
        },
        "lighting": {
            "type": "object",
            "properties": {
                "primary_source": {"type": "string"},
                "direction": {"type": "string"},
                "color_temperature": {"type": "string", "enum": ["warm", "neutral", "cool", "mixed"]},
                "kelvin_estimate": {"type": "number"},
                "time_of_day": {"type": "string"},
                "shadow_softness": {"type": "string", "enum": ["soft", "hard", "mixed"]},
                "sources": {"type": "array", "items": {"type": "object", "properties": {
                    "type": {"type": "string"}, "location": {"type": "string"}}}},
            },
        },
        "fixed_elements": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "type": {"type": "string", "enum": list(FIXED_TYPES)},
                    "description": {"type": "string"},
                    "wall": {"type": "string", "enum": list(WALLS)},
                    "bbox": {"type": "array", "items": {"type": "number"}},
                },
                "required": ["type", "description"],
            },
        },
        "flooring": {"type": "object", "properties": {"material": {"type": "string"}, "color": {"type": "string"}}},
        "walls": {"type": "object", "properties": {"color": {"type": "string"}, "finish": {"type": "string"}}},
        "ceiling": {"type": "object", "properties": {
            "type": {"type": "string"}, "height": {"type": "string"},
            "fixtures": {"type": "array", "items": {"type": "string"}}}},
        "walkable_floor_bbox": {"type": "array", "items": {"type": "number"}},
        "traffic_paths": {"type": "array", "items": {"type": "string"}},
        "size_class": {"type": "string", "enum": list(SIZE_CLASSES)},
        "approx_floor_area_sqft": {"type": "number"},
        "notes": {"type": "string"},
    },
    "required": ["room_type", "occupancy", "fixed_elements", "size_class"],
}

ANALYSIS_PROMPT = """You are an architectural photographer and home stager analyzing a real estate listing photo before virtual staging.
Return ONLY a JSON object matching the schema below. Be literal and precise; describe only what is visible.

Fields:
- room_type: one of {room_types}. room_type_confidence: 0.0-1.0. is_interior: false for patios, decks, yards.
- occupancy: "empty" (no furniture), "partially_furnished", "furnished", or "cluttered" (lots of loose items). existing_items: list movable items present.
- camera: height ("low" below 4 ft, "eye_level" 4-6 ft, "high"), angle ("straight_on" one-point view of the back wall, "two_point" corner view, "corner", "oblique"), pitch, lens ("wide" if walls lean or the room looks stretched), vanishing_direction (where floor lines converge, e.g. "center", "left of center").
- lighting: primary_source (e.g. "large window on left wall"), direction light travels across the room (e.g. "from the left"), color_temperature, kelvin_estimate, time_of_day, shadow_softness, sources (each with type and location).
- fixed_elements: EVERY element that must not change: windows, doors, doorways, sliding doors, closets, outlets, vents, radiators, fireplaces, built-ins, ceiling fixtures/fans, stairs, columns, cabinetry, appliances, plumbing fixtures. For each give type, a short description (material/color/shape), wall ("left", "back" (the wall facing the camera), "right", "ceiling", "floor") and bbox = [x0, y0, x1, y1] in normalized image coordinates (0-1, origin top-left).
- flooring (material, color), walls (color, finish), ceiling (type, height: "low"/"standard"/"high"/"vaulted", fixtures).
- walkable_floor_bbox: normalized bbox of open floor visible in the photo.
- traffic_paths: natural walking routes between doorways/openings that furniture must leave clear (e.g. "from the hallway doorway on the right to the sliding door at back").
- size_class: "small" (< 150 sq ft, e.g. a 10x12 bedroom), "medium" (150-300), "large" (> 300). approx_floor_area_sqft: estimate using doors (~80 in tall, ~32-36 in wide) and windows as scale references.
- notes: anything a stager should know (sloped ceiling, odd angles, focal point such as a fireplace or view).
"""


def analysis_prompt() -> str:
    return ANALYSIS_PROMPT.format(room_types=", ".join(ROOM_TYPES))


def _clamp(v, lo=0.0, hi=1.0):
    try:
        return max(lo, min(hi, float(v)))
    except (TypeError, ValueError):
        return None


def normalize_bbox(bbox) -> Optional[List[float]]:
    """Clamp to [0, 1], fix ordering; accept 0-1000 scaled boxes (some models use that)."""
    if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
        return None
    try:
        vals = [float(v) for v in bbox]
    except (TypeError, ValueError):
        return None
    if max(vals) > 1.5:
        vals = [v / 1000.0 for v in vals]
    x0, y0, x1, y1 = [_clamp(v) for v in vals]
    x0, x1 = sorted((x0, x1))
    y0, y1 = sorted((y0, y1))
    if x1 - x0 < 0.005 or y1 - y0 < 0.005:
        return None
    return [round(x0, 4), round(y0, 4), round(x1, 4), round(y1, 4)]


def default_analysis(room_type: str = "living-room") -> dict:
    """Used when no vision provider is available or the call fails. Conservative defaults."""
    return {
        "room_type": room_type if room_type in ROOM_TYPES else "living-room",
        "room_type_confidence": 0.0,
        "is_interior": room_type != "patio",
        "occupancy": "empty",
        "existing_items": [],
        "camera": {"height": "eye_level", "angle": "two_point", "pitch": "level", "lens": "wide",
                   "vanishing_direction": "center"},
        "lighting": {"primary_source": "existing natural light", "direction": "as in the photo",
                     "color_temperature": "neutral", "kelvin_estimate": None, "time_of_day": "unknown",
                     "shadow_softness": "soft", "sources": []},
        "fixed_elements": [],
        "flooring": {"material": "existing flooring", "color": "as in the photo"},
        "walls": {"color": "existing wall color", "finish": ""},
        "ceiling": {"type": "existing ceiling", "height": "standard", "fixtures": []},
        "walkable_floor_bbox": None,
        "traffic_paths": [],
        "size_class": "medium",
        "approx_floor_area_sqft": None,
        "notes": "",
        "source": "default",
    }


def normalize_analysis(raw: dict, room_type_hint: Optional[str] = None) -> dict:
    """Merge model output over defaults, validating enums and boxes."""
    out = default_analysis(room_type_hint or "living-room")
    if not isinstance(raw, dict):
        return out
    out["source"] = "model"
    rt = str(raw.get("room_type", "")).strip().lower().replace(" ", "-").replace("_", "-")
    if rt in ROOM_TYPES:
        out["room_type"] = rt
    conf = _clamp(raw.get("room_type_confidence"))
    out["room_type_confidence"] = conf if conf is not None else 0.5
    if isinstance(raw.get("is_interior"), bool):
        out["is_interior"] = raw["is_interior"]
    occ = str(raw.get("occupancy", "")).lower()
    out["occupancy"] = occ if occ in OCCUPANCY else "empty"
    out["existing_items"] = [str(x) for x in raw.get("existing_items") or []][:30]
    for key in ("camera", "lighting", "flooring", "walls", "ceiling"):
        if isinstance(raw.get(key), dict):
            out[key].update({k: v for k, v in raw[key].items() if v not in (None, "")})
    fixed = []
    for el in raw.get("fixed_elements") or []:
        if not isinstance(el, dict):
            continue
        t = str(el.get("type", "other")).lower().replace(" ", "_")
        wall = str(el.get("wall", "")).lower()
        fixed.append({
            "type": t if t in FIXED_TYPES else "other",
            "description": str(el.get("description", t)).strip() or t,
            "wall": wall if wall in WALLS else None,
            "bbox": normalize_bbox(el.get("bbox")),
        })
    out["fixed_elements"] = fixed
    out["walkable_floor_bbox"] = normalize_bbox(raw.get("walkable_floor_bbox"))
    out["traffic_paths"] = [str(x) for x in raw.get("traffic_paths") or []][:10]
    size = str(raw.get("size_class", "")).lower()
    out["size_class"] = size if size in SIZE_CLASSES else "medium"
    try:
        area = float(raw.get("approx_floor_area_sqft"))
        out["approx_floor_area_sqft"] = area if area > 0 else None
    except (TypeError, ValueError):
        out["approx_floor_area_sqft"] = None
    # Cross-check size class against the area estimate when both exist.
    area = out["approx_floor_area_sqft"]
    if area:
        by_area = "small" if area < 150 else "large" if area > 300 else "medium"
        if by_area != out["size_class"]:
            out["size_class_note"] = f"model said {out['size_class']}, area {area:.0f} sq ft suggests {by_area}"
            out["size_class"] = by_area
    out["notes"] = str(raw.get("notes", ""))[:500]
    return out


def analyze_room(provider: Optional[Provider], image: Image.Image, room_type_hint: Optional[str] = None,
                 log=None) -> dict:
    if provider is None or not getattr(provider, "supports_vision", True):
        result = default_analysis(room_type_hint or "living-room")
        result["source"] = "default (no vision provider)"
        return result
    try:
        raw = provider.generate_json(analysis_prompt(), [image], task="analysis", schema=ANALYSIS_SCHEMA)
    except Exception as e:
        if log:
            log(f"analysis failed, using defaults: {e}")
        result = default_analysis(room_type_hint or "living-room")
        result["source"] = f"default (analysis failed: {str(e)[:120]})"
        return result
    return normalize_analysis(raw, room_type_hint)


def apply_room_type_override(analysis: dict, room_type: Optional[str]) -> dict:
    """User-chosen room type wins over the model's guess; keep the guess for the record."""
    a = deepcopy(analysis)
    if room_type and room_type != "auto" and room_type in ROOM_TYPES and room_type != a["room_type"]:
        a["detected_room_type"] = a["room_type"]
        a["room_type"] = room_type
    return a
