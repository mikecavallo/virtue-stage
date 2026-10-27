import { normalizeObjects } from './geometry.js'

export const BASE = import.meta.env.BASE_URL

export const SAMPLES = [
  { id: 'living-room', title: 'Living room', roomType: 'living-room' },
  { id: 'bedroom', title: 'Bedroom', roomType: 'bedroom' },
  { id: 'open-plan', title: 'Open-plan', roomType: 'living-room' },
  { id: 'bathroom', title: 'Bathroom', roomType: 'bathroom' },
  { id: 'kitchen', title: 'Kitchen', roomType: 'kitchen' },
]

export const sampleBase = (id) => `${BASE}samples/${id}/`
export const sampleImage = (id) => `${sampleBase(id)}original.jpg`

const cache = new Map()

// Precomputed inventory (see scripts/demo-assets). Missing file = no objects.
export function loadInventory(id) {
  if (!cache.has(id)) {
    cache.set(
      id,
      fetch(`${sampleBase(id)}inventory.json`)
        .then((r) => (r.ok ? r.json() : null))
        .then((inv) => (inv ? { ...inv, objects: normalizeObjects(inv.objects, { maxObjects: 40, keepChildren: true }) } : null))
        .catch(() => null),
    )
  }
  return cache.get(id)
}
