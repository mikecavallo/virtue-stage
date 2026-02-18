#!/usr/bin/env python3
"""Generate staged room images using OpenAI gpt-image-1."""
import os, base64, sys
from pathlib import Path
from openai import OpenAI

client = OpenAI()
BEFORE = Path("public/images/before")
AFTER = Path("public/images/after")
AFTER.mkdir(parents=True, exist_ok=True)

rooms = {
    "living-room.jpg": "a modern living room with a comfortable sofa, coffee table, area rug, floor lamp, and wall art",
    "bedroom.jpg": "a cozy bedroom with a queen bed, nightstands, table lamps, dresser, and soft bedding",
    "kitchen.jpg": "a modern kitchen with bar stools, pendant lights, fruit bowl, small appliances, and decorative items on counters",
    "dining-room.jpg": "an elegant dining room with a dining table, chairs, centerpiece, chandelier, and sideboard",
    "bathroom.jpg": "a spa-like bathroom with fluffy towels, bath mat, candles, plants, and decorative accessories",
}

for filename, description in rooms.items():
    before_path = BEFORE / filename
    after_path = AFTER / filename
    
    if after_path.exists():
        print(f"SKIP {filename} (already exists)")
        continue
    
    print(f"Staging {filename}...")
    
    with open(before_path, "rb") as f:
        img_data = base64.b64encode(f.read()).decode()
    
    try:
        response = client.images.edit(
            model="gpt-image-1",
            image=open(before_path, "rb"),
            prompt=f"Add beautiful furniture and staging to this empty room to make it look like {description}. Keep the exact same room structure, walls, floors, windows, and lighting. Make it look photorealistic and inviting for real estate listing photos. The furniture should look natural and professionally placed.",
            size="1024x1024",
        )
        
        # gpt-image-1 returns base64
        img_bytes = base64.b64decode(response.data[0].b64_json)
        with open(after_path, "wb") as f:
            f.write(img_bytes)
        print(f"  ✓ Saved {after_path}")
        
    except Exception as e:
        print(f"  ✗ Failed: {e}")
        # Try alternative approach with dall-e-3
        try:
            print(f"  Trying dall-e-3 fallback...")
            response = client.images.generate(
                model="dall-e-3",
                prompt=f"A photorealistic interior real estate photo of {description}. Professional staging, warm lighting, inviting atmosphere. High-end real estate listing quality photo.",
                size="1024x1024",
                quality="hd",
                n=1,
            )
            import requests
            img_url = response.data[0].url
            r = requests.get(img_url)
            with open(after_path, "wb") as f:
                f.write(r.content)
            print(f"  ✓ Saved {after_path} (dall-e-3)")
        except Exception as e2:
            print(f"  ✗ Fallback also failed: {e2}")

print("Done!")
