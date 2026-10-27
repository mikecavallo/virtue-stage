import { describe, expect, it } from 'vitest'
import { boxBlurChannel, hexToRgb, labToRgb, outsideMaskDifference, recolorPixels, rgbToLab } from './pixels.js'

describe('color conversion', () => {
  it('round-trips sRGB through CIELAB', () => {
    for (const rgb of [[0, 0, 0], [255, 255, 255], [200, 30, 60], [12, 140, 220], [128, 128, 128]]) {
      labToRgb(rgbToLab(rgb)).forEach((v, i) => expect(Math.abs(v - rgb[i])).toBeLessThanOrEqual(1))
    }
  })

  it('maps white to L=100 and black to L=0', () => {
    expect(rgbToLab([255, 255, 255])[0]).toBeCloseTo(100, 1)
    expect(rgbToLab([0, 0, 0])[0]).toBeCloseTo(0, 1)
  })

  it('parses hex colors', () => {
    expect(hexToRgb('#1a2B3c')).toEqual([26, 43, 60])
    expect(() => hexToRgb('nope')).toThrow()
  })
})

describe('boxBlurChannel', () => {
  it('spreads a hard edge into a ramp and keeps flat areas flat', () => {
    const w = 20
    const h = 1
    const src = new Uint8ClampedArray(w).map((_, i) => (i < 10 ? 255 : 0))
    const out = boxBlurChannel(src, w, h, 2)
    expect(out[0]).toBe(255)
    expect(out[19]).toBe(0)
    expect(out[9]).toBeGreaterThan(out[11])
    expect(out[9]).toBeLessThan(255)
  })
})

describe('recolorPixels', () => {
  const px = (r, g, b) => [r, g, b, 255]
  const rgba = Uint8ClampedArray.from([...px(200, 190, 170), ...px(150, 140, 120), ...px(10, 20, 30)])
  const mask = Uint8ClampedArray.from([255, 255, 0])

  it('changes hue inside the mask and leaves the rest untouched', () => {
    const out = recolorPixels(rgba, mask, [30, 60, 160])
    expect(Array.from(out.slice(8, 12))).toEqual([10, 20, 30, 255])
    // blue now dominates where it was beige
    expect(out[2]).toBeGreaterThan(out[0])
    expect(out[6]).toBeGreaterThan(out[4])
  })

  it('preserves relative lightness (texture) inside the region', () => {
    const out = recolorPixels(rgba, mask, [30, 60, 160])
    const L0 = rgbToLab([out[0], out[1], out[2]])[0]
    const L1 = rgbToLab([out[4], out[5], out[6]])[0]
    expect(L0).toBeGreaterThan(L1)
  })
})

describe('outsideMaskDifference', () => {
  it('ignores pixels inside the edit mask', () => {
    const a = Uint8ClampedArray.from([10, 10, 10, 10])
    const b = Uint8ClampedArray.from([10, 10, 250, 250])
    expect(outsideMaskDifference(a, b, Uint8ClampedArray.from([0, 0, 255, 255]))).toBe(0)
    expect(outsideMaskDifference(a, b, null)).toBe(120)
  })
})
