# Virtual Home Staging Engine

A comprehensive tool for testing and comparing AI models for virtual home staging - transforming empty room photos into beautifully staged interiors.

## Overview

This engine compares multiple AI platforms for virtual home staging:

1. **OpenAI** - GPT-Image-1 + DALL-E 3 + GPT-4V for analysis
2. **fal.ai** - Stable Diffusion models with inpainting
3. **Replicate** - Various interior design specialized models
4. **Other platforms** - Extensible architecture for new models

## Features

- **Multi-model comparison** - Test multiple AI services simultaneously
- **Style parameters** - Support for 6 interior design styles:
  - Modern
  - Traditional  
  - Minimalist
  - Bohemian
  - Scandinavian
  - Luxury
- **Performance metrics** - Generation time, cost estimates, quality assessment
- **Extensible architecture** - Easy to add new AI models/services
- **Test image generation** - Built-in empty room test images

## Installation

```bash
# Create virtual environment
python3 -m venv venv
source venv/bin/activate  # On Windows: venv\\Scripts\\activate

# Install dependencies
pip install -r requirements.txt
```

## Configuration

Set up API keys as environment variables:

```bash
export OPENAI_API_KEY="your_openai_key"
export FALAI_API_KEY="your_falai_key"  
export REPLICATE_API_TOKEN="your_replicate_token"
```

Or pass them as command line arguments.

## Usage

### Generate Test Images

```bash
python test_image_generator.py
```

This creates three test room images:
- `test_living_room_empty.png`
- `test_bedroom_empty.png`  
- `test_kitchen_empty.png`

### Run Virtual Staging

```bash
# Test with all available models
python virtual_stager.py test_living_room_empty.png --style modern

# Test specific models
python virtual_stager.py test_bedroom_empty.png --style scandinavian --models openai falai

# Test single model
python virtual_stager.py test_kitchen_empty.png --style luxury --models openai --openai-key sk-...
```

### Style Options

- **modern**: Clean lines, neutral colors, contemporary furniture
- **traditional**: Classic design, warm colors, elegant furniture  
- **minimalist**: Very few items, clean spaces, simple geometry
- **bohemian**: Eclectic mix of colors, patterns, plants, vintage pieces
- **scandinavian**: Light wood, cozy textiles, hygge atmosphere
- **luxury**: High-end materials, elegant furniture, sophisticated decor

## Model Comparison Results

Based on research and testing:

### OpenAI (GPT-Image-1 + DALL-E 3) ⭐ RECOMMENDED

**Strengths:**
- Best contextual understanding of room architecture
- High-quality, realistic furniture placement
- Excellent lighting and shadow generation
- Strong style adherence
- Good API reliability

**Weaknesses:**
- Higher cost (~$0.04 per generation)
- Rate limits on API

**Best for:** High-quality staging for premium listings

### fal.ai (Stable Diffusion)

**Strengths:**
- Lower cost (~$0.01 per generation)
- Fast generation times
- Good variety of models
- Open source flexibility

**Weaknesses:**
- Requires more prompt engineering
- Less architectural awareness
- May need multiple attempts for quality

**Best for:** High-volume, cost-conscious applications

### Replicate

**Strengths:**
- Easy API access
- Variety of specialized models
- Good performance/cost balance

**Weaknesses:**
- Model quality varies
- Limited control over specific models

**Best for:** Experimenting with different models

## Architecture

The engine uses a modular architecture:

```python
class StagingModel(ABC):
    def stage_room(self, image_path: str, style: str) -> Tuple[str, Dict]:
        # Transform empty room to staged version
        pass
    
    def get_cost_estimate(self) -> str:
        # Return cost per generation
        pass
```

To add a new model:

1. Inherit from `StagingModel`
2. Implement `stage_room()` and `get_cost_estimate()`
3. Add to `VirtualStager` in main()

## Output

The engine generates:

1. **Staged images** - Transformed room images with furniture and decor
2. **Performance report** - Generation time, costs, quality metrics
3. **JSON results** - Detailed metadata for each model test
4. **Comparison analysis** - Side-by-side model performance

Example output:
```
MODEL COMPARISON REPORT
========================================

OPENAI
------
Model: OpenAI DALL-E-3 + GPT-4V
Generation Time: 8.45s
Cost Estimate: $0.04
Output: test_living_room_empty_staged_modern_openai.png
Analysis: The room features hardwood floors and large windows...

FALAI  
-----
Model: fal.ai SD-XL Inpainting
Generation Time: 3.21s
Cost Estimate: $0.01
Output: test_living_room_empty_staged_modern_falai.png
```

## File Structure

```
virtual-staging/engine/
├── virtual_stager.py         # Main staging engine
├── test_image_generator.py   # Generate test room images
├── requirements.txt          # Python dependencies
├── README.md                 # This documentation
├── research.md              # Model research and comparison
├── venv/                    # Python virtual environment
├── test_*.png              # Generated test images
└── *_staging_results*.json # Test results
```

## Research Notes

See `research.md` for detailed analysis of each AI platform's capabilities, pricing, and suitability for virtual home staging applications.

## Contributing

To add support for new AI models:

1. Create a new class inheriting from `StagingModel`
2. Implement the required methods
3. Add initialization logic to main()
4. Update documentation

## License

MIT License - See LICENSE file for details