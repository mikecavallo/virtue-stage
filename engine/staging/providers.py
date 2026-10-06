"""Model providers behind one small interface, plus a deterministic fake for tests.

``generate_json`` is the vision/text call (room analysis, quality judge).
``edit_image`` is the image-editing call (declutter, staging).

Real providers: Gemini (vision + image) and OpenAI gpt-image-1 (image only).
The fake provider makes no network calls and is used by the unit tests, the
backend contract test and ``python -m eval.run --provider fake``.
"""

import base64
import io
import json
import os
import re
import time
from abc import ABC, abstractmethod
from typing import Callable, Dict, List, Optional, Sequence, Union

from PIL import Image, ImageDraw

ImageInput = Union[Image.Image, str]


class ProviderError(RuntimeError):
    pass


def parse_json_loose(text: str) -> dict:
    """Parse model JSON output, tolerating code fences and leading/trailing prose."""
    if text is None:
        raise ProviderError("empty model response")
    t = text.strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z]*\s*", "", t)
        t = re.sub(r"\s*```\s*$", "", t)
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        start, end = t.find("{"), t.rfind("}")
        if start != -1 and end > start:
            return json.loads(t[start:end + 1])
        raise


class Provider(ABC):
    name = "provider"
    image_model: Optional[str] = None
    vision_model: Optional[str] = None
    supports_vision = True
    supports_image = True

    @abstractmethod
    def generate_json(self, prompt: str, images: Sequence[ImageInput], *, task: str,
                      schema: Optional[dict] = None) -> dict:
        """Text+image in, structured JSON out. ``task`` is 'analysis', 'judge', ..."""

    @abstractmethod
    def edit_image(self, prompt: str, images: Sequence[ImageInput], *,
                   aspect_ratio: Optional[str] = None) -> Image.Image:
        """Edit ``images[0]`` (later images are references). Returns a PIL image."""


# ─── Gemini ────────────────────────────────────────────────────────────────

class GeminiProvider(Provider):
    name = "gemini"
    IMAGE_MODELS = {
        "gemini-flash": "gemini-2.5-flash-image",
        "gemini-pro": "gemini-3-pro-image-preview",
    }

    def __init__(self, image_model: str = "gemini-flash", vision_model: str = "gemini-2.5-flash",
                 api_key: Optional[str] = None, retries: int = 2):
        try:
            from google import genai
            from google.genai import types
        except ImportError as e:  # pragma: no cover - depends on environment
            raise ProviderError("google-genai is not installed: pip install -r engine/requirements.txt") from e
        key = api_key or os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
        if not key:
            raise ProviderError("GEMINI_API_KEY (or GOOGLE_API_KEY) is not set")
        self._types = types
        self.client = genai.Client(api_key=key)
        self.image_model = self.IMAGE_MODELS.get(image_model, image_model)
        self.vision_model = vision_model
        self.retries = retries

    def _call(self, fn: Callable):
        last = None
        for attempt in range(self.retries + 1):
            try:
                return fn()
            except Exception as e:  # network / 5xx / rate limit
                last = e
                if attempt < self.retries:
                    time.sleep(2 * (attempt + 1))
        raise ProviderError(f"Gemini call failed: {last}") from last

    @staticmethod
    def _contents(prompt: str, images: Sequence[ImageInput], labels: Optional[List[str]] = None):
        contents: list = [prompt]
        for i, img in enumerate(images):
            if isinstance(img, str):
                img = Image.open(img)
            if labels and i < len(labels):
                contents.append(labels[i])
            contents.append(img)
        return contents

    def generate_json(self, prompt, images, *, task, schema=None):
        types = self._types
        cfg = dict(response_mime_type="application/json", temperature=0.2)
        if schema is not None and "response_json_schema" in types.GenerateContentConfig.model_fields:
            cfg["response_json_schema"] = schema
        config = types.GenerateContentConfig(**cfg)
        resp = self._call(lambda: self.client.models.generate_content(
            model=self.vision_model, contents=self._contents(prompt, images), config=config))
        return parse_json_loose(resp.text)

    def edit_image(self, prompt, images, *, aspect_ratio=None):
        types = self._types
        cfg = dict(response_modalities=["TEXT", "IMAGE"])
        if aspect_ratio and hasattr(types, "ImageConfig"):
            cfg["image_config"] = types.ImageConfig(aspect_ratio=aspect_ratio)
        config = types.GenerateContentConfig(**cfg)
        labels = None
        if len(images) > 1:
            labels = ["IMAGE 1 (the photo to edit):"] + [f"IMAGE {i + 2} (reference only, do not edit):"
                                                          for i in range(len(images) - 1)]
        resp = self._call(lambda: self.client.models.generate_content(
            model=self.image_model, contents=self._contents(prompt, images, labels), config=config))
        for cand in resp.candidates or []:
            for part in (cand.content.parts if cand.content else []) or []:
                if getattr(part, "inline_data", None) is not None and part.inline_data.data:
                    return Image.open(io.BytesIO(part.inline_data.data)).convert("RGB")
        text = getattr(resp, "text", None)
        raise ProviderError(f"Gemini returned no image{': ' + text[:200] if text else ''}")


# ─── OpenAI (image only) ───────────────────────────────────────────────────

class OpenAIImageProvider(Provider):
    """gpt-image-1 edits. No vision/JSON support here; pair it with a Gemini vision provider."""

    name = "openai"
    supports_vision = False
    SIZES = {"1536x1024": 1.5, "1024x1536": 2 / 3, "1024x1024": 1.0}

    def __init__(self, api_key: Optional[str] = None, model: str = "gpt-image-1"):
        try:
            import openai
        except ImportError as e:  # pragma: no cover
            raise ProviderError("openai is not installed: pip install openai") from e
        key = api_key or os.getenv("OPENAI_API_KEY")
        if not key:
            raise ProviderError("OPENAI_API_KEY is not set")
        self.client = openai.OpenAI(api_key=key)
        self.image_model = model

    def generate_json(self, prompt, images, *, task, schema=None):
        raise ProviderError("OpenAIImageProvider does not implement vision calls")

    def edit_image(self, prompt, images, *, aspect_ratio=None):
        first = images[0] if not isinstance(images[0], str) else Image.open(images[0])
        ratio = first.width / first.height
        size = min(self.SIZES, key=lambda s: abs(self.SIZES[s] - ratio))
        files = []
        for img in images:
            if isinstance(img, str):
                img = Image.open(img)
            buf = io.BytesIO()
            img.convert("RGB").save(buf, format="PNG")
            buf.name = "image.png"
            buf.seek(0)
            files.append(buf)
        result = self.client.images.edit(model=self.image_model, image=files if len(files) > 1 else files[0],
                                         prompt=prompt, size=size)
        return Image.open(io.BytesIO(base64.b64decode(result.data[0].b64_json))).convert("RGB")


# ─── Fake ──────────────────────────────────────────────────────────────────

DEFAULT_FAKE_ANALYSIS = {
    "room_type": "living-room",
    "room_type_confidence": 0.9,
    "is_interior": True,
    "occupancy": "empty",
    "existing_items": [],
    "camera": {"height": "eye_level", "angle": "two_point", "pitch": "level", "lens": "wide",
               "vanishing_direction": "center"},
    "lighting": {"primary_source": "window on the left wall", "direction": "from the left",
                 "color_temperature": "neutral", "kelvin_estimate": 5000, "time_of_day": "midday",
                 "shadow_softness": "soft", "sources": [{"type": "window", "location": "left wall"}]},
    "fixed_elements": [
        {"type": "window", "description": "double-hung window", "wall": "back",
         "bbox": [0.38, 0.22, 0.62, 0.5]},
        {"type": "door", "description": "interior door", "wall": "right", "bbox": [0.84, 0.2, 0.95, 0.75]},
    ],
    "flooring": {"material": "light oak hardwood", "color": "light oak"},
    "walls": {"color": "warm white", "finish": "matte"},
    "ceiling": {"type": "flat", "height": "standard", "fixtures": []},
    "walkable_floor_bbox": [0.05, 0.6, 0.95, 1.0],
    "traffic_paths": ["from the right door toward the window"],
    "size_class": "medium",
    "approx_floor_area_sqft": 220,
    "notes": "fake analysis",
}

DEFAULT_FAKE_JUDGE = {
    "photorealism": 8, "scale": 8, "perspective": 8, "lighting_match": 8,
    "architecture_preserved": 9, "mls_appropriate": 10, "style_match": 8,
    "issues": [], "feedback": "",
}


class FakeProvider(Provider):
    """Deterministic, offline provider.

    ``edit_image`` returns the input with simple "furniture" blocks drawn in the
    lower half, re-rendered at the model's native resolution: 1024 px on the long
    side at the requested aspect ratio, or exactly ``output_size`` if given (e.g. a
    square, to simulate a model that ignores the aspect ratio). ``alter_architecture=True`` also repaints the top band,
    which the fidelity scorer should catch. Pass callables in ``responses`` or
    ``edit_fn`` to script behaviour per call.
    """

    name = "fake"
    image_model = "fake-image"
    vision_model = "fake-vision"

    def __init__(self, responses: Optional[Dict[str, object]] = None, output_size=None,
                 alter_architecture: Union[bool, Callable[[int], bool]] = False,
                 edit_fn: Optional[Callable] = None, fail_vision: bool = False):
        self.responses = {"analysis": DEFAULT_FAKE_ANALYSIS, "judge": DEFAULT_FAKE_JUDGE}
        self.responses.update(responses or {})
        self.output_size = output_size
        self.alter_architecture = alter_architecture
        self.edit_fn = edit_fn
        self.fail_vision = fail_vision
        self.calls: List[dict] = []
        self.edit_count = 0

    def generate_json(self, prompt, images, *, task, schema=None):
        self.calls.append({"kind": "json", "task": task, "prompt": prompt, "n_images": len(images)})
        if self.fail_vision:
            raise ProviderError("fake vision failure")
        resp = self.responses.get(task)
        if callable(resp):
            resp = resp(prompt, images, len([c for c in self.calls if c.get("task") == task]))
        if resp is None:
            raise ProviderError(f"no fake response for task '{task}'")
        return json.loads(json.dumps(resp))

    def edit_image(self, prompt, images, *, aspect_ratio=None):
        self.calls.append({"kind": "edit", "prompt": prompt, "n_images": len(images), "aspect_ratio": aspect_ratio})
        idx = self.edit_count
        self.edit_count += 1
        src = images[0] if not isinstance(images[0], str) else Image.open(images[0])
        if self.edit_fn:
            return self.edit_fn(src, prompt, idx)
        out = src.convert("RGB").copy()
        w, h = out.size
        d = ImageDraw.Draw(out)
        if "Remove all movable furniture" not in prompt:
            # "sofa", "coffee table" and "rug" in the lower half
            d.rectangle([w * 0.18, h * 0.62, w * 0.62, h * 0.82], fill=(205, 196, 180))
            d.rectangle([w * 0.25, h * 0.84, w * 0.5, h * 0.9], fill=(150, 120, 90))
            d.rectangle([w * 0.15, h * 0.9, w * 0.7, h * 0.97], fill=(225, 220, 210))
        alter = self.alter_architecture(idx) if callable(self.alter_architecture) else self.alter_architecture
        if alter:
            d.rectangle([0, 0, w, h * 0.5], fill=(70, 110, 160))
        size = self.output_size
        if size is None and aspect_ratio:
            rw, rh = (float(v) for v in aspect_ratio.split(":"))
            size = (1024, round(1024 * rh / rw)) if rw >= rh else (round(1024 * rw / rh), 1024)
        if size:
            out = out.resize(tuple(size), Image.BILINEAR)
        return out


def make_providers(render: str = "gemini", image_model: str = "gemini-flash",
                   vision_model: str = "gemini-2.5-flash"):
    """Build (vision, renderer) providers for the CLI. Vision may be None (judge/analysis skipped)."""
    if render == "fake":
        fake = FakeProvider()
        return fake, fake
    if render == "openai":
        renderer = OpenAIImageProvider()
        try:
            vision = GeminiProvider(image_model=image_model, vision_model=vision_model)
        except ProviderError:
            vision = None
        return vision, renderer
    gem = GeminiProvider(image_model=image_model, vision_model=vision_model)
    return gem, gem
