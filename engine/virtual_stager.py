#!/usr/bin/env python3
"""
VirtueStage staging engine.

Takes a photo of an empty room and asks an image model to add furniture and
decor in a chosen style. Providers: Google Gemini (default, used by the
backend) and OpenAI gpt-image-1 (optional, CLI only).

The backend calls this script as a subprocess and looks for the output file
`<stem>_staged_<style>_<provider><ext>` next to the input image.
"""

import os
import sys
import argparse
import base64
import json
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from abc import ABC, abstractmethod

try:
    import openai
    HAS_OPENAI = True
except ImportError:
    HAS_OPENAI = False
    
try:
    import requests
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False

try:
    from google import genai
    from google.genai import types as genai_types
    HAS_GENAI = True
except ImportError:
    HAS_GENAI = False

# Styling options
STYLES = {
    'modern': 'modern minimalist interior design with clean lines, neutral colors, and contemporary furniture',
    'traditional': 'traditional classic interior design with warm colors, elegant furniture, and timeless pieces',
    'minimalist': 'minimalist interior design with very few items, clean spaces, and simple geometric furniture',
    'bohemian': 'bohemian interior design with eclectic mix of colors, patterns, plants, and vintage furniture',
    'scandinavian': 'scandinavian interior design with light wood, cozy textiles, and hygge atmosphere',
    'luxury': 'luxury interior design with high-end materials, elegant furniture, and sophisticated decor'
}

class StagingModel(ABC):
    """Abstract base class for home staging AI models."""
    
    @abstractmethod
    def stage_room(self, image_path: str, style: str, prompt: str = None, reference_image: str = None) -> Tuple[str, Dict]:
        """
        Stage a room with furniture and decor.
        
        Args:
            image_path: Path to empty room image
            style: Style keyword (modern, traditional, etc.)
            
        Returns:
            Tuple of (output_image_path, metadata)
        """
        pass

class OpenAIStagingModel(StagingModel):
    """OpenAI GPT-Image-1 based staging model."""
    
    def __init__(self, api_key: str):
        if not HAS_OPENAI:
            raise ImportError("openai package required. Install with: pip install openai")
        
        self.client = openai.OpenAI(api_key=api_key)
        self.model = "gpt-image-1"  # Latest multimodal model
    
    def stage_room(self, image_path: str, style: str, prompt: str = None, reference_image: str = None) -> Tuple[str, Dict]:
        """Stage room using OpenAI gpt-image-1 (native image editing)."""
        
        if not prompt:
            style_description = STYLES.get(style, f"{style} interior design")
            prompt = (
                f"Transform this empty room into a beautifully staged {style_description}. "
                "Add realistic furniture, lighting, and decor that fits the room's architecture and proportions. "
                "Keep the room structure, walls, windows, and flooring identical. "
                "The result should look like a professional real estate listing photo."
            )
        
        try:
            start_time = time.time()
            
            result = self.client.images.edit(
                model="gpt-image-1",
                image=open(image_path, "rb"),
                prompt=prompt,
                size="1024x1024",
            )
            
            generation_time = time.time() - start_time
            
            # Decode and save
            image_bytes = base64.b64decode(result.data[0].b64_json)
            p = Path(image_path)
            output_path = str(p.parent / f"{p.stem}_staged_{style}_openai{p.suffix}")
            with open(output_path, 'wb') as f:
                f.write(image_bytes)
            
            metadata = {
                'model': 'OpenAI gpt-image-1',
                'style': style,
                'generation_time': generation_time,
                    'image_size': '1024x1024'
            }
            
            return output_path, metadata
            
        except Exception as e:
            raise Exception(f"OpenAI staging failed: {str(e)}")
    

class GeminiStagingModel(StagingModel):
    """Google Gemini based staging model."""

    # Short aliases; any full Gemini model id is also accepted.
    MODELS = {
        'gemini-flash': 'gemini-2.5-flash-image',
        'gemini-pro': 'gemini-3-pro-image-preview',
    }

    def __init__(self, model_key: str = 'gemini-flash'):
        if not HAS_GENAI:
            raise ImportError("google-genai package required. Install with: pip install google-genai")
        self.model_name = self.MODELS.get(model_key, model_key)
        self.label = self.model_name
        self.client = genai.Client()  # uses GOOGLE_API_KEY env var

    def stage_room(self, image_path: str, style: str, prompt: str = None, reference_image: str = None) -> Tuple[str, Dict]:
        from PIL import Image as PILImage
        
        if not prompt:
            style_description = STYLES.get(style, f"{style} interior design")
            furniture_by_style = {
                'modern': 'a sleek low-profile sofa, minimalist coffee table, abstract wall art, geometric rug, modern floor lamp, and a few accent plants',
                'traditional': 'an elegant rolled-arm sofa, wooden coffee table, classic table lamps, a Persian-style rug, framed landscape paintings, and decorative pillows',
                'minimalist': 'a simple clean-lined sofa, one small coffee table, a single piece of wall art, and one plant — keep it very sparse',
                'bohemian': 'a comfortable textured sofa with throw blankets, a wooden coffee table, macrame wall hangings, layered rugs, lots of plants, and eclectic cushions',
                'scandinavian': 'a light-colored linen sofa, wooden coffee table, cozy knit throw, simple pendant light, light wood shelving, and minimal greenery',
                'luxury': 'a large sectional sofa in rich fabric, marble or glass coffee table with decorative books, elegant side tables with designer lamps, a plush area rug, statement wall art, and tasteful plants',
            }
            furniture = furniture_by_style.get(style, 'appropriate furniture, lighting, and decor')
            prompt = (
                f"Edit this photo to add {style} style furniture to this empty room. "
                "Do NOT change the room itself — keep the exact same walls, floors, windows, ceiling, and lighting. "
                f"Only add furniture and decor: {furniture}. "
                "Make it look like a real photograph, not a rendering. This is for a real estate listing."
            )
        
        img = PILImage.open(image_path)
        
        # Build contents — if reference image provided, include it
        if reference_image and os.path.exists(reference_image):
            ref_img = PILImage.open(reference_image)
            contents = [prompt, "Reference (staged hero shot — match this furniture exactly):", ref_img, "Room to stage (new angle):", img]
        else:
            contents = [prompt, img]
        
        start_time = time.time()
        response = self.client.models.generate_content(
            model=self.model_name,
            contents=contents,
            config=genai_types.GenerateContentConfig(response_modalities=['TEXT', 'IMAGE'])
        )
        generation_time = time.time() - start_time

        # Extract output image
        p = Path(image_path)
        output_path = str(p.parent / f"{p.stem}_staged_{style}_gemini{p.suffix}")
        for part in response.candidates[0].content.parts:
            if part.inline_data is not None:
                out_img = part.as_image()
                out_img.save(output_path)
                break
        else:
            raise Exception("Gemini returned no image")

        metadata = {
            'model': f'Google Gemini ({self.label})',
            'style': style,
            'generation_time': generation_time,
            'image_size': 'native',
        }
        return output_path, metadata



class VirtualStager:
    """Main virtual staging engine."""
    
    def __init__(self):
        self.models = {}
    
    def add_model(self, name: str, model: StagingModel):
        """Add a staging model to the engine."""
        self.models[name] = model
    
    def stage_room_all_models(self, image_path: str, style: str, prompt: str = None, reference_image: str = None) -> Dict[str, Tuple[str, Dict]]:
        """Stage room with all available models."""
        results = {}
        
        for name, model in self.models.items():
            try:
                print(f"Testing {name} model...")
                output_path, metadata = model.stage_room(image_path, style, prompt=prompt, reference_image=reference_image)
                results[name] = (output_path, metadata)
                print(f"OK {name}: {metadata.get('generation_time', 0):.2f}s")
            except Exception as e:
                print(f"FAILED {name}: {str(e)}", file=sys.stderr)
                results[name] = (None, {'error': str(e)})
        
        return results
    
    def compare_models(self, results: Dict[str, Tuple[str, Dict]]):
        """Compare model performance and output comparison report."""
        
        print("\n" + "="*60)
        print("MODEL COMPARISON REPORT")
        print("="*60)
        
        for name, (output_path, metadata) in results.items():
            print(f"\n{name.upper()}")
            print("-" * len(name))
            
            if 'error' in metadata:
                print(f"Status: FAILED - {metadata['error']}")
                continue
            
            print(f"Model: {metadata.get('model', 'Unknown')}")
            print(f"Generation Time: {metadata.get('generation_time', 0):.2f}s")
            print(f"Output: {output_path}")
            
            if 'analysis' in metadata:
                print(f"Analysis: {metadata['analysis'][:100]}...")

def main():
    parser = argparse.ArgumentParser(description='Virtual Home Staging Engine')
    parser.add_argument('image_path', help='Path to empty room image')
    parser.add_argument('--style', choices=list(STYLES.keys()), 
                       default='modern', help='Staging style')
    parser.add_argument('--models', nargs='+',
                       choices=['openai', 'gemini', 'all'],
                       default=['gemini'], help='Providers to run (default: gemini)')
    parser.add_argument('--prompt', help='Staging prompt (passed from backend; overrides built-in prompts)')
    parser.add_argument('--reference-image', help='Path to a staged reference image for multi-angle consistency')
    parser.add_argument('--gemini-model', default=os.getenv('GEMINI_IMAGE_MODEL', 'gemini-flash'),
                       help="Gemini model alias (gemini-flash, gemini-pro) or full model id. Env: GEMINI_IMAGE_MODEL")
    parser.add_argument('--openai-key', help='OpenAI API key (or set OPENAI_API_KEY env var)')
    
    args = parser.parse_args()
    
    # Validate input image
    if not os.path.exists(args.image_path):
        print(f"Error: Image file '{args.image_path}' not found")
        sys.exit(1)
    
    # Initialize virtual stager
    stager = VirtualStager()
    
    # Add models based on available API keys
    if 'openai' in args.models or 'all' in args.models:
        openai_key = args.openai_key or os.getenv('OPENAI_API_KEY')
        if openai_key:
            try:
                stager.add_model('openai', OpenAIStagingModel(openai_key))
            except ImportError as e:
                print(f"Skipping OpenAI: {e}")
        else:
            print("Skipping OpenAI: No API key provided")
    
    if 'gemini' in args.models or 'all' in args.models:
        google_key = os.getenv('GOOGLE_API_KEY') or os.getenv('GEMINI_API_KEY')
        if google_key:
            try:
                os.environ['GOOGLE_API_KEY'] = google_key
                stager.add_model('gemini', GeminiStagingModel(args.gemini_model))
            except ImportError as e:
                print(f"Skipping Gemini: {e}")
        else:
            print("Skipping Gemini: No GOOGLE_API_KEY or GEMINI_API_KEY provided")
    
    if not stager.models:
        print("Error: No models available. Set GEMINI_API_KEY (or OPENAI_API_KEY with --models openai).", file=sys.stderr)
        sys.exit(1)
    
    print(f"Staging room with style: {args.style}")
    print(f"Available models: {list(stager.models.keys())}")
    
    # Run staging tests
    results = stager.stage_room_all_models(args.image_path, args.style, prompt=args.prompt, reference_image=args.reference_image)
    
    # Compare results
    stager.compare_models(results)
    
    # Save results to JSON
    results_file = Path(args.image_path).stem + f'_staging_results_{args.style}.json'
    with open(results_file, 'w') as f:
        # Convert results to JSON-serializable format
        json_results = {}
        for name, (output_path, metadata) in results.items():
            json_results[name] = {
                'output_path': output_path,
                'metadata': metadata
            }
        json.dump(json_results, f, indent=2)
    
    print(f"\nResults saved to: {results_file}")

    # Non-zero exit if every provider failed, so callers can surface the error.
    if all(output is None for output, _ in results.values()):
        sys.exit(2)

if __name__ == '__main__':
    main()