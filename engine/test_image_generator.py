#!/usr/bin/env python3
"""
Generate test empty room images for testing the virtual staging engine.
Creates simple room mockups with basic architectural features.
"""

from PIL import Image, ImageDraw, ImageFont
import os

def create_empty_room_image(width=1024, height=1024, room_type="living_room"):
    """Create a simple empty room image for testing."""
    
    # Create base image
    img = Image.new('RGB', (width, height), color='#F5F5F5')  # Light gray walls
    draw = ImageDraw.Draw(img)
    
    if room_type == "living_room":
        # Draw floor
        floor_color = '#D4A574'  # Light wood
        draw.rectangle([0, height*0.7, width, height], fill=floor_color)
        
        # Draw window
        window_color = '#87CEEB'  # Sky blue
        window_frame = '#8B4513'  # Dark brown
        draw.rectangle([width*0.7, height*0.1, width*0.95, height*0.5], fill=window_frame)
        draw.rectangle([width*0.72, height*0.12, width*0.93, height*0.48], fill=window_color)
        
        # Draw baseboard
        draw.rectangle([0, height*0.68, width, height*0.72], fill='#FFFFFF')
        
    elif room_type == "bedroom":
        # Draw floor
        floor_color = '#F0E68C'  # Light carpet
        draw.rectangle([0, height*0.75, width, height], fill=floor_color)
        
        # Draw two windows
        window_color = '#87CEEB'
        window_frame = '#8B4513'
        # Window 1
        draw.rectangle([width*0.1, height*0.1, width*0.35, height*0.45], fill=window_frame)
        draw.rectangle([width*0.12, height*0.12, width*0.33, height*0.43], fill=window_color)
        # Window 2
        draw.rectangle([width*0.65, height*0.1, width*0.9, height*0.45], fill=window_frame)
        draw.rectangle([width*0.67, height*0.12, width*0.88, height*0.43], fill=window_color)
        
        # Door outline
        draw.rectangle([width*0.02, height*0.3, width*0.08, height*0.75], fill='#8B4513')
        
    elif room_type == "kitchen":
        # Draw floor (tile pattern suggestion)
        floor_color = '#F8F8FF'  # Ghost white tiles
        draw.rectangle([0, height*0.7, width, height], fill=floor_color)
        
        # Counter space outline
        draw.rectangle([0, height*0.55, width*0.25, height*0.7], fill='#D3D3D3')  # Counter
        draw.rectangle([width*0.75, height*0.55, width, height*0.7], fill='#D3D3D3')  # Counter
        
        # Window above sink area
        window_color = '#87CEEB'
        window_frame = '#8B4513'
        draw.rectangle([width*0.3, height*0.2, width*0.7, height*0.5], fill=window_frame)
        draw.rectangle([width*0.32, height*0.22, width*0.68, height*0.48], fill=window_color)
    
    return img

def main():
    """Generate test images for each room type."""
    
    room_types = ["living_room", "bedroom", "kitchen"]
    
    for room_type in room_types:
        print(f"Creating {room_type} test image...")
        img = create_empty_room_image(room_type=room_type)
        
        filename = f"test_{room_type}_empty.png"
        img.save(filename)
        print(f"Saved: {filename}")
    
    print("\nTest images created! You can now run:")
    print("python virtual_stager.py test_living_room_empty.png --style modern")

if __name__ == "__main__":
    main()