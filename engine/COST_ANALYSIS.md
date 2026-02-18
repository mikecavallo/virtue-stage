# AI Model Cost Analysis for Virtual Staging

*Per Mike's request - 2026-02-07*

## Per-Image Generation Costs

| Model | Resolution | Cost/Image | Notes |
|-------|-----------|------------|-------|
| **OpenAI GPT-4V + DALL-E 3** | 1024x1024 | ~$0.04 | Best quality, architectural understanding |
| **OpenAI DALL-E 3 HD** | 1024x1792 | ~$0.08 | Higher resolution option |
| **fal.ai SDXL Inpainting** | 1024x1024 | ~$0.01 | Budget option, fast |
| **Replicate (avg)** | 1024x1024 | ~$0.02 | Good balance |

## Monthly Cost Projections

### Tier 1: 100 images/month (Starter)
| Model | Monthly Cost | Margin @ $15/image |
|-------|-------------|-------------------|
| OpenAI | $4.00 | $1,496 (99.7%) |
| fal.ai | $1.00 | $1,499 (99.9%) |
| Replicate | $2.00 | $1,498 (99.9%) |

### Tier 2: 1,000 images/month (Growth)
| Model | Monthly Cost | Margin @ $15/image |
|-------|-------------|-------------------|
| OpenAI | $40.00 | $14,960 (99.7%) |
| fal.ai | $10.00 | $14,990 (99.9%) |
| Replicate | $20.00 | $14,980 (99.9%) |

### Tier 3: 10,000 images/month (Scale)
| Model | Monthly Cost | Margin @ $15/image |
|-------|-------------|-------------------|
| OpenAI | $400.00 | $149,600 (99.7%) |
| fal.ai | $100.00 | $149,900 (99.9%) |
| Replicate | $200.00 | $149,800 (99.9%) |

## Competitor Comparison

| Competitor | Their Price | Our Target | Undercut |
|------------|-------------|------------|----------|
| Virtual Staging Solutions | $75 | $15 | 80% less |
| BoxBrownie | $24 | $15 | 37.5% less |
| PhotoUp | $20-32 | $15 | 25-53% less |

## Recommended Pricing Strategy

### Consumer Tiers
- **Starter:** $15/image (up to 3 rooms)
- **Professional:** $12/image (4-10 rooms) 
- **Enterprise:** $10/image (10+ rooms, custom quote)

### Cost Model Selection
1. **Premium Quality:** Use OpenAI ($0.04/image) - 96%+ margin
2. **Volume/Budget:** Use fal.ai ($0.01/image) - 99%+ margin
3. **A/B Testing:** Replicate ($0.02/image) - test new models

## Break-Even Analysis

At $15/image with OpenAI ($0.04 cost):
- **Break-even:** 1 image covers cost of 375 generations
- **Monthly fixed costs (est.):** ~$200 (hosting, domains, etc.)
- **Break-even volume:** ~14 images/month

## Conclusion

AI staging provides **99%+ gross margins** at all volume tiers, allowing aggressive price undercutting while maintaining profitability. The primary constraint is not cost but quality - recommend starting with OpenAI for best results, then optimizing with cheaper models once quality benchmarks are established.
