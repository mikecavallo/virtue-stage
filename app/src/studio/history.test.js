import { describe, expect, it } from 'vitest'
import { changeLog, disclosureText, editedRegions, polishProtect, initialState, reducer, replayBaseIndex, withoutRemoved } from './history.js'

const step = (id, op, extra = {}) => ({ id, url: `${id}.jpg`, label: id, objects: [], op, ...extra })

describe('history reducer', () => {
  const loaded = reducer(initialState, { type: 'load', photo: { name: 'Living room' }, step: step('s0', { type: 'original' }) })

  it('pushing after an undo drops the redo branch', () => {
    let s = reducer(loaded, { type: 'push', step: step('s1', { type: 'recolor' }) })
    s = reducer(s, { type: 'push', step: step('s2', { type: 'recolor' }) })
    s = reducer(s, { type: 'goto', index: 1 })
    s = reducer(s, { type: 'push', step: step('s3', { type: 'remove' }) })
    expect(s.steps.map((x) => x.id)).toEqual(['s0', 's1', 's3'])
    expect(s.cursor).toBe(2)
  })

  it('ignores out-of-range undo/redo', () => {
    expect(reducer(loaded, { type: 'goto', index: -1 })).toBe(loaded)
    expect(reducer(loaded, { type: 'goto', index: 5 })).toBe(loaded)
  })

  it('keeps the selection only if the object still exists', () => {
    const obj = { id: 'sofa-1', label: 'sofa', children: [] }
    let s = reducer(loaded, { type: 'select', id: 'sofa-1' })
    s = reducer(s, { type: 'push', step: step('s1', { type: 'recolor' }, { objects: [obj] }) })
    expect(s.selectedId).toBe('sofa-1')
    s = reducer(s, { type: 'push', step: step('s2', { type: 'demo-remove' }, { objects: [] }) })
    expect(s.selectedId).toBeNull()
  })

  it('a rescan turns a replayable step into a new replay base', () => {
    let s = reducer(loaded, { type: 'push', step: step('s1', { type: 'recolor' }) })
    s = reducer(s, { type: 'set-objects', objects: [{ id: 'chair-1' }] })
    expect(s.steps[1].op.type).toBe('rescan')
    expect(replayBaseIndex(s.steps, 1)).toBe(1)
  })
})

describe('replay helpers', () => {
  it('finds the last baked step', () => {
    const steps = [step('o', { type: 'original' }), step('a', { type: 'recolor' }), step('b', { type: 'remove' }), step('c', { type: 'demo-remove' }), step('d', { type: 'recolor' })]
    expect(replayBaseIndex(steps, 4)).toBe(2)
    expect(replayBaseIndex(steps, 1)).toBe(0)
  })

  it('drops removed objects and dangling child links', () => {
    const objs = [
      { id: 'sofa-1', children: ['pillow-1'] },
      { id: 'pillow-1', children: [] },
      { id: 'rug-1', children: [] },
    ]
    expect(withoutRemoved(objs, ['pillow-1'])).toEqual([
      { id: 'sofa-1', children: [] },
      { id: 'rug-1', children: [] },
    ])
  })
})

describe('disclosure', () => {
  const steps = [step('o', { type: 'original' }), step('Recolored sofa navy', { type: 'recolor' }, { engine: 'in-browser recolor' }), step('Staged: Scandinavian', { type: 'stage' }, { note: 'architecture check passed' })]

  it('labels staged photos and plain edits differently', () => {
    expect(disclosureText(steps, 0)).toBe('')
    expect(disclosureText(steps, 1)).toBe('Digitally altered')
    expect(disclosureText(steps, 2)).toBe('Virtually staged')
  })

  it('writes a readable change log up to the current step', () => {
    const log = changeLog({ name: 'Living room' }, steps, 2)
    expect(log).toContain('1. Recolored sofa navy [in-browser recolor]')
    expect(log).toContain('2. Staged: Scandinavian (architecture check passed)')
  })
})

describe('editedRegions (what Polish cleans up)', () => {
  const A = [[0, 0], [10, 0], [10, 10]]
  const B = [[20, 20], [30, 20], [30, 30]]
  const C = [[40, 40], [50, 40], [50, 50]]

  it('collects edited polygons since the last whole-photo change, skipping recolors', () => {
    const steps = [
      step('o', { type: 'original' }),
      step('r', { type: 'remove', polygons: [A] }),
      step('s', { type: 'stage' }),
      step('d', { type: 'demo-remove', objectId: 'x', polygons: [B] }),
      step('c', { type: 'recolor', objectId: 'y', hex: '#000000' }),
      step('p', { type: 'polish' }),
      step('q', { type: 'rescan', after: { type: 'replace', polygons: [C] } }),
    ]
    expect(editedRegions(steps, 6)).toEqual([C, B])
    expect(editedRegions(steps, 1)).toEqual([A])
    expect(editedRegions(steps, 2)).toEqual([])
    expect(editedRegions(steps, 0)).toEqual([])
  })
})

describe('polishProtect', () => {
  it('protects untouched objects but not rugs or the edited object itself', () => {
    const sofa = [[1, 1], [2, 1], [2, 2]]
    const art = [[5, 5], [6, 5], [6, 6]]
    const rug = [[0, 9], [9, 9], [9, 0]]
    const objects = [
      { id: 'sofa-1', label: 'mid-century sofa', mask: sofa },
      { id: 'wall-art-1', label: 'wall art', mask: art },
      { id: 'area-rug-1', label: 'area rug', mask: rug },
    ]
    expect(polishProtect(objects, [JSON.parse(JSON.stringify(sofa))])).toEqual([art])
  })
})
