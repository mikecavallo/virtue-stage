#!/usr/bin/env python3
"""
Room type detection using Gemini vision.
Returns JSON: { "room_type": "living-room", "confidence": 0.95, "details": "..." }
"""

import sys
import json
import os

try:
    from google import genai
    from google.genai import types as genai_types
    from PIL import Image as PILImage
except ImportError as e:
    print(json.dumps({"error": f"Missing dependency: {e}"}))
    sys.exit(1)

VALID_ROOMS = ["living-room", "bedroom", "kitchen", "dining-room", "bathroom", "office", "nursery", "studio", "basement", "attic", "sunroom", "patio"]

def detect_room(image_path):
    client = genai.Client()
    img = PILImage.open(image_path)
    
    prompt = (
        "Analyze this photo of an empty room. Determine the room type.\n\n"
        "Respond with ONLY valid JSON (no markdown, no code fences):\n"
        '{"room_type": "<type>", "confidence": <0.0-1.0>, "details": "<brief description>"}\n\n'
        f"Valid room types: {', '.join(VALID_ROOMS)}\n\n"
        "Base your answer on architectural features: fixtures (sink, toilet, shower = bathroom), "
        "appliances (stove, fridge = kitchen), size and shape, window placement, flooring type, "
        "built-in features (closets = bedroom, counters = kitchen)."
    )
    
    response = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=[prompt, img],
        config=genai_types.GenerateContentConfig(response_modalities=['TEXT'])
    )
    
    text = response.candidates[0].content.parts[0].text.strip()
    # Clean up potential markdown fences
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text[3:]
    if text.endswith("```"):
        text = text[:-3]
    text = text.strip()
    
    result = json.loads(text)
    
    # Validate room type
    if result.get("room_type") not in VALID_ROOMS:
        # Fuzzy match
        rt = result.get("room_type", "").lower().replace(" ", "-")
        if rt in VALID_ROOMS:
            result["room_type"] = rt
        else:
            result["room_type"] = "living-room"
            result["auto_fallback"] = True
    
    return result

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: detect_room.py <image_path>"}))
        sys.exit(1)
    
    try:
        result = detect_room(sys.argv[1])
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
