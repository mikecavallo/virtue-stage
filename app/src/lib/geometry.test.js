import { describe, expect, it } from 'vitest'
import {
  boxOverlapRatio,
  boxToPixels,
  computeChildren,
  hitTest,
  nearestAspectRatio,
  normalizeObjects,
  pointInPolygon,
  polygonArea,
  withDescendants,
  fitWithin,
} from './geometry.js'

const square = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]

describe('polygon math', () => {
  it('finds points inside a polygon', () => {
    const poly = square(100, 100, 300, 300)
    expect(pointInPolygon([200, 200], poly)).toBe(true)
    expect(pointInPolygon([50, 200], poly)).toBe(false)
  })

  it('handles concave polygons', () => {
    const L = [[0, 0], [400, 0], [400, 100], [100, 100], [100, 400], [0, 400]]
    expect(pointInPolygon([50, 300], L)).toBe(true)
    expect(pointInPolygon([300, 300], L)).toBe(false)
  })

  it('computes area', () => {
    expect(polygonArea(square(0, 0, 10, 20))).toBe(200)
  })

  it('converts Gemini boxes ([ymin, xmin, ymax, xmax] in 0-1000) to pixels', () => {
    expect(boxToPixels([100, 200, 600, 700], 1200, 800)).toEqual({ x: 240, y: 80, w: 600, h: 400 })
  })

  it('measures how much of one box sits inside another', () => {
    expect(boxOverlapRatio([0, 0, 100, 100], [0, 0, 1000, 1000])).toBe(1)
    expect(boxOverlapRatio([0, 0, 100, 100], [50, 0, 1000, 1000])).toBeCloseTo(0.5)
  })
})

describe('normalizeObjects', () => {
  it('clamps, validates, and assigns stable ids', () => {
    const out = normalizeObjects([
      { label: 'Throw Pillow', box_2d: [10, 10, 50, 50], mask: square(10, 10, 50, 50) },
      { label: 'throw pillow', box_2d: [60, 60, -5, 2000], mask: [] },
      { label: 'junk' },
      null,
    ])
    expect(out.map((o) => o.id)).toEqual(['throw-pillow-1', 'throw-pillow-2'])
    // swapped/clamped box and a box-shaped fallback polygon
    expect(out[1].box_2d).toEqual([0, 60, 60, 1000])
    expect(out[1].mask).toHaveLength(4)
  })

  it('caps the number of objects', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ label: 'chair', box_2d: [0, i * 10, 50, i * 10 + 9] }))
    expect(normalizeObjects(many, { maxObjects: 15 })).toHaveLength(15)
  })
})

describe('children and hit testing', () => {
  const objects = computeChildren([
    { id: 'sofa-1', label: 'sofa', box_2d: [400, 100, 800, 700], mask: square(100, 400, 700, 800) },
    { id: 'throw-pillow-1', label: 'throw pillow', box_2d: [450, 150, 550, 250], mask: square(150, 450, 250, 550) },
    { id: 'area-rug-1', label: 'area rug', box_2d: [600, 0, 1000, 1000], mask: square(0, 600, 1000, 1000) },
    { id: 'floor-lamp-1', label: 'floor lamp', box_2d: [100, 800, 800, 900], mask: square(800, 100, 900, 800) },
  ])

  it('links items resting on furniture, but not furniture on a rug', () => {
    const sofa = objects.find((o) => o.id === 'sofa-1')
    const rug = objects.find((o) => o.id === 'area-rug-1')
    expect(sofa.children).toEqual(['throw-pillow-1'])
    expect(rug.children).toEqual([])
  })

  it('removing the sofa also removes the pillow', () => {
    expect(withDescendants(objects, 'sofa-1').map((o) => o.id)).toEqual(['sofa-1', 'throw-pillow-1'])
  })

  it('a tap picks the smallest object under the finger', () => {
    expect(hitTest(objects, [200, 500]).id).toBe('throw-pillow-1')
    expect(hitTest(objects, [600, 500]).id).toBe('sofa-1')
    expect(hitTest(objects, [50, 50])).toBeNull()
  })
})

describe('sizing', () => {
  it('maps photo sizes to the closest supported aspect ratio', () => {
    expect(nearestAspectRatio(1200, 800)).toBe('3:2')
    expect(nearestAspectRatio(1200, 1799)).toBe('2:3')
    expect(nearestAspectRatio(4032, 3024)).toBe('4:3')
    expect(nearestAspectRatio(1920, 1080)).toBe('16:9')
  })

  it('fits without upscaling', () => {
    expect(fitWithin(3000, 2000, 1500)).toMatchObject({ width: 1500, height: 1000 })
    expect(fitWithin(800, 600, 1500)).toMatchObject({ width: 800, height: 600, scale: 1 })
  })
})
