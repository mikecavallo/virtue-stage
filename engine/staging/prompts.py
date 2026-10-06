"""Step 3: build the constrained edit prompts (staging, declutter) from analysis + plan."""

from typing import List, Optional

MLS_RULES = [
    "no people, no pets, no reflections of a photographer",
    "no text, signage, logos, brand names, watermarks or lettered art",
    "no TV screens showing content, no computer screens, no personal photos",
    "no clutter, cords or loose personal items",
    "do not change the view through windows or add fake views",
]


def _fixed_elements_text(analysis: dict) -> List[str]:
    lines = []
    for el in analysis.get("fixed_elements", []):
        where = f" ({el['wall']} wall)" if el.get("wall") in ("left", "back", "right") else (
            f" ({el['wall']})" if el.get("wall") else "")
        lines.append(f"{el['description']}{where}")
    return lines


def preserve_section(analysis: dict) -> str:
    walls = analysis.get("walls", {})
    floor = analysis.get("flooring", {})
    ceiling = analysis.get("ceiling", {})
    fixtures = ceiling.get("fixtures") or []
    lines = [
        "KEEP IDENTICAL (this is a photo edit, not a new image; these pixels must not change):",
        f"- walls and wall color ({walls.get('color', 'as in the photo')}{', ' + walls['finish'] if walls.get('finish') else ''}), trim and baseboards",
        f"- floor material, color and pattern ({floor.get('material', 'as in the photo')}); floor area not covered by furniture keeps its exact grain and reflections",
        f"- ceiling ({ceiling.get('type', 'as in the photo')}) and every existing lighting fixture{': ' + ', '.join(fixtures) if fixtures else ''}; do not add ceiling lights, pendants or fans",
        "- windows, window frames, glass and the view through them; do not add curtains, blinds or rods",
        "- doors, doorways, outlets, switches, vents, radiators and built-ins",
    ]
    for item in _fixed_elements_text(analysis):
        lines.append(f"- {item}")
    lines += [
        "- camera position, camera angle, lens, perspective and vertical lines",
        "- image framing and crop: same field of view, same aspect ratio, nothing zoomed, shifted, rotated or extended",
        "- overall exposure and white balance of the room",
        "Do not add, remove, move or resize any architectural element.",
    ]
    return "\n".join(lines)


def camera_section(analysis: dict) -> str:
    cam = analysis.get("camera", {})
    return "\n".join([
        "CAMERA AND SCALE:",
        f"- Camera: {cam.get('height', 'eye_level').replace('_', ' ')} height, {cam.get('angle', 'two_point').replace('_', ' ')} view, "
        f"{cam.get('pitch', 'level').replace('_', ' ')}, {cam.get('lens', 'wide').replace('_', ' ')} lens. "
        f"Floor lines converge toward the {cam.get('vanishing_direction', 'center')}.",
        "- Draw every piece in this exact perspective: its edges follow the room's vanishing lines, verticals stay vertical.",
        "- Use real-world scale: doors are about 80 in tall, sofa seats 17-19 in high, tables 29-30 in high, "
        "nightstands about mattress height. Furniture must sit on the floor plane, not float or sink.",
        f"- Room size class: {analysis.get('size_class', 'medium')}"
        + (f" (about {analysis['approx_floor_area_sqft']:.0f} sq ft)" if analysis.get("approx_floor_area_sqft") else "")
        + ". Do not overfill; keep generous open floor.",
    ])


def lighting_section(analysis: dict) -> str:
    light = analysis.get("lighting", {})
    k = light.get("kelvin_estimate")
    return "\n".join([
        "LIGHTING (match the existing photo exactly):",
        f"- Main light: {light.get('primary_source', 'existing light')}, travelling {light.get('direction', 'as in the photo')}; "
        f"color temperature {light.get('color_temperature', 'neutral')}{f' (about {int(k)}K)' if k else ''}; "
        f"{light.get('shadow_softness', 'soft')} shadows.",
        "- Every piece is lit from that same direction, with highlights and shading consistent with it.",
        "- Add contact shadows where every leg and base meets the floor, soft ambient occlusion where furniture meets walls "
        "and rugs, and cast shadows pointing away from the main light.",
        "- Reflections on glossy floors or glass must match the furniture above them.",
        "- Lamps may be off or glowing softly; they must not change the room's exposure.",
    ])


def plan_section(plan: dict) -> str:
    lines = [f"STAGING PLAN: {plan['style_label']} style. {plan['style_summary']}",
             f"Palette: {', '.join(plan['palette'])}. Materials: {', '.join(plan['materials'])}.",
             f"Lighting decor: {plan['lighting_decor']}",
             "Place exactly these items (nothing else):"]
    for i, p in enumerate(plan["pieces"], 1):
        size = f" [{p['size']}]" if p.get("size") else ""
        lines.append(f"{i}. {p['description']}{size}: {p['placement']}.")
    if plan.get("rug"):
        r = plan["rug"]
        lines.append(f"{len(plan['pieces']) + 1}. Rug: {r['description']} [{r['size']}]: {r['rule']}.")
    if plan.get("styling_level") == "minimal":
        lines.append("Styling level: MINIMAL. Only the small accessories listed; the room should look almost unchanged.")
    elif plan.get("styling_level") == "accessories_only":
        lines.append("Styling level: ACCESSORIES ONLY. No furniture of any kind.")
    if plan.get("consistency"):
        lines.append(plan["consistency"]["rule"])
    lines.append("Rules:")
    lines += [f"- {r}" for r in plan.get("rules", [])]
    return "\n".join(lines)


def keep_clear_section(plan: dict) -> str:
    if not plan.get("keep_clear"):
        return "KEEP CLEAR: every doorway, window and walkway stays unobstructed (36 in walkways)."
    return "KEEP CLEAR:\n" + "\n".join(f"- {k}" for k in plan["keep_clear"])


def avoid_section(plan: dict) -> str:
    items = list(plan.get("avoid", [])) + MLS_RULES
    return "AVOID:\n" + "\n".join(f"- {a}" for a in items)


def build_render_prompt(plan: dict, analysis: dict, *, has_reference: bool = False,
                        feedback: Optional[str] = None, custom_instructions: Optional[str] = None) -> str:
    parts = [
        "Virtually stage this real estate listing photo by adding furniture and decor according to the plan below. "
        "Edit the provided photo in place: everything that is not new furniture or decor stays exactly as it is.",
    ]
    if has_reference:
        parts.append(
            "IMAGE 1 is the photo to edit. IMAGE 2 shows the SAME room already staged from a different camera angle. "
            "Use the identical furniture pieces from IMAGE 2 (same model, shape, color, fabric, wood tone and size) in the "
            "same positions relative to the room. Keep IMAGE 1's own camera angle and framing; do not copy IMAGE 2's viewpoint."
        )
    parts += [preserve_section(analysis), camera_section(analysis), lighting_section(analysis),
              plan_section(plan), keep_clear_section(plan), avoid_section(plan)]
    if custom_instructions:
        parts.append(f"ADDITIONAL INSTRUCTIONS (lower priority than KEEP IDENTICAL):\n{custom_instructions.strip()}")
    if feedback:
        parts.append(f"A PREVIOUS ATTEMPT WAS REJECTED. Fix these problems:\n{feedback.strip()}")
    parts.append(
        "OUTPUT: one photorealistic image indistinguishable from a professional real estate photograph of a professionally "
        "staged home (not a 3D render, no CGI look, no illustration). Same size, framing and aspect ratio as IMAGE 1."
    )
    return "\n\n".join(parts)


def build_declutter_prompt(analysis: dict, feedback: Optional[str] = None) -> str:
    items = analysis.get("existing_items") or []
    parts = [
        "Remove all movable furniture, decor, rugs, personal items and clutter from this real estate photo so the room is "
        "empty and clean, ready to be staged."
        + (f" Items to remove include: {', '.join(items)}." if items else ""),
        "Reconstruct the floor, walls and baseboards hidden behind removed items so they continue the visible material, "
        "pattern, grain and lighting seamlessly. Remove shadows the removed items cast.",
        preserve_section(analysis),
        "Do not remove anything fixed: cabinetry, appliances, plumbing fixtures, built-ins, light fixtures, window "
        "treatments that are part of the house, or anything attached to walls that is architectural.",
        "AVOID:\n" + "\n".join(f"- {a}" for a in MLS_RULES),
    ]
    if feedback:
        parts.append(f"A PREVIOUS ATTEMPT WAS REJECTED. Fix these problems:\n{feedback.strip()}")
    parts.append("OUTPUT: one photorealistic photo of the same empty room, same camera, framing and aspect ratio.")
    return "\n\n".join(parts)
