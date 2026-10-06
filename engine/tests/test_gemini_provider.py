"""GeminiProvider request shape, checked against the real google-genai types with a stubbed client (no network)."""

import io
from types import SimpleNamespace

import pytest
from PIL import Image

genai = pytest.importorskip("google.genai")

from staging.analysis import ANALYSIS_SCHEMA  # noqa: E402
from staging.providers import GeminiProvider, ProviderError  # noqa: E402


class StubModels:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def generate_content(self, **kwargs):
        self.calls.append(kwargs)
        return self.response


def png_bytes(size=(300, 200)):
    buf = io.BytesIO()
    Image.new("RGB", size, "white").save(buf, format="PNG")
    return buf.getvalue()


def provider_with(response):
    p = GeminiProvider(image_model="gemini-flash", api_key="test-key", retries=0)
    p.client = SimpleNamespace(models=StubModels(response))
    return p


def test_edit_requests_aspect_ratio_and_labels_reference_images():
    part = SimpleNamespace(inline_data=SimpleNamespace(data=png_bytes()))
    resp = SimpleNamespace(candidates=[SimpleNamespace(content=SimpleNamespace(parts=[part]))], text=None)
    p = provider_with(resp)
    img = Image.new("RGB", (60, 40))
    out = p.edit_image("stage it", [img, img], aspect_ratio="3:2")
    assert out.size == (300, 200)
    call = p.client.models.calls[0]
    assert call["model"] == "gemini-2.5-flash-image"
    assert call["config"].image_config.aspect_ratio == "3:2"
    assert "IMAGE" in call["config"].response_modalities
    contents = call["contents"]
    assert contents[0] == "stage it" and contents[1].startswith("IMAGE 1") and contents[3].startswith("IMAGE 2")


def test_edit_without_image_raises():
    resp = SimpleNamespace(candidates=[SimpleNamespace(content=SimpleNamespace(parts=[SimpleNamespace(inline_data=None)]))],
                           text="I cannot do that")
    with pytest.raises(ProviderError, match="no image"):
        provider_with(resp).edit_image("x", [Image.new("RGB", (10, 10))])


def test_generate_json_requests_json_with_schema_and_parses_fenced_output():
    p = provider_with(SimpleNamespace(text='```json\n{"room_type": "bedroom"}\n```'))
    out = p.generate_json("analyze", [Image.new("RGB", (10, 10))], task="analysis", schema=ANALYSIS_SCHEMA)
    assert out == {"room_type": "bedroom"}
    cfg = p.client.models.calls[0]["config"]
    assert cfg.response_mime_type == "application/json"
    assert cfg.response_json_schema == ANALYSIS_SCHEMA
    assert p.client.models.calls[0]["model"] == "gemini-2.5-flash"
