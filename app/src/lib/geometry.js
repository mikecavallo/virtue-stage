// Geometry helpers for Gemini-style detections.
// Gemini returns boxes as [ymin, xmin, ymax, xmax] and polygons as [[x, y], ...],
// both normalized to 0-1000. Everything in the app keeps that format so demo
// data (precomputed offline) and live data (from Gemini) are interchangeable.

export const NORM = 1000

const clampNorm = (v) => Math.min(NORM, Math.max(0, Math.round(Number(v) || 0)))

export function toPixels(points, width, height) {
  return points.map(([x, y]) => [(x / NORM) * width, (y / NORM) * height])
}

export function boxToPixels([ymin, xmin, ymax, xmax], width, height) {
  return {
    x: (xmin / NORM) * width,
    y: (ymin / NORM) * height,
    w: ((xmax - xmin) / NORM) * width,
    h: ((ymax - ymin) / NORM) * height,
  }
}

export function boxToPolygon([ymin, xmin, ymax, xmax]) {
  return [[xmin, ymin], [xmax, ymin], [xmax, ymax], [xmin, ymax]]
}

export function polygonBox(polygon) {
  const xs = polygon.map((p) => p[0])
  const ys = polygon.map((p) => p[1])
  return [Math.min(...ys), Math.min(...xs), Math.max(...ys), Math.max(...xs)]
}

// Ray casting. Works for any simple polygon.
export function pointInPolygon([px, py], polygon) {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]
    const [xj, yj] = polygon[j]
    const crosses = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi
    if (crosses) inside = !inside
  }
  return inside
}

export function polygonArea(polygon) {
  let sum = 0
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    sum += (polygon[j][0] + polygon[i][0]) * (polygon[j][1] - polygon[i][1])
  }
  return Math.abs(sum / 2)
}

export function boxArea([ymin, xmin, ymax, xmax]) {
  return Math.max(0, ymax - ymin) * Math.max(0, xmax - xmin)
}

// Share of `inner` that lies inside `outer` (0..1).
export function boxOverlapRatio(inner, outer) {
  const ymin = Math.max(inner[0], outer[0])
  const xmin = Math.max(inner[1], outer[1])
  const ymax = Math.min(inner[2], outer[2])
  const xmax = Math.min(inner[3], outer[3])
  const area = boxArea(inner)
  if (!area) return 0
  return boxArea([ymin, xmin, ymax, xmax]) / area
}

export function slugify(label) {
  return String(label || 'object')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'object'
}

// Things that sit on other things. Removing the parent removes these too.
const CHILD_RE = /pillow|cushion|throw|blanket|vase|book|plant|flower|lamp|decor|bowl|tray|candle|clock|sculpture|basket|towel|bottle|cup|mug|plate|fruit|frame|ornament/
const PARENT_RE = /sofa|couch|sectional|loveseat|armchair|chair|bed|table|desk|dresser|nightstand|bench|ottoman|console|sideboard|buffet|shelf|bookcase|stool|cabinet|credenza|vanity|counter/

export function computeChildren(objects) {
  const withArea = objects.map((o) => ({ ...o, _area: boxArea(o.box_2d), children: [] }))
  for (const child of withArea) {
    let best = null
    for (const parent of withArea) {
      if (parent === child) continue
      if (!PARENT_RE.test(parent.label)) continue
      if (parent._area <= child._area) continue
      const smallish = CHILD_RE.test(child.label) || child._area < parent._area * 0.35
      if (!smallish) continue
      if (boxOverlapRatio(child.box_2d, parent.box_2d) < 0.6) continue
      if (!best || parent._area < best._area) best = parent
    }
    if (best) best.children.push(child.id)
  }
  return withArea.map((o) => {
    const copy = { ...o }
    delete copy._area
    return copy
  })
}

// Validate and tidy raw detections (from Gemini or demo JSON).
export function normalizeObjects(raw, { maxObjects = 20, keepChildren = false } = {}) {
  if (!Array.isArray(raw)) return []
  const counts = {}
  const cleaned = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const label = String(item.label || 'object').trim().toLowerCase().slice(0, 40) || 'object'
    let box = Array.isArray(item.box_2d) && item.box_2d.length === 4 ? item.box_2d.map(clampNorm) : null
    let mask = Array.isArray(item.mask)
      ? item.mask
          .filter((p) => Array.isArray(p) && p.length >= 2)
          .map(([x, y]) => [clampNorm(x), clampNorm(y)])
      : []
    if (mask.length < 3 || polygonArea(mask) < 1) mask = null
    if (!box && mask) box = polygonBox(mask)
    if (!box) continue
    if (box[0] > box[2]) box = [box[2], box[1], box[0], box[3]]
    if (box[1] > box[3]) box = [box[0], box[3], box[2], box[1]]
    if (boxArea(box) < 4) continue
    if (!mask) mask = boxToPolygon(box)
    const slug = slugify(label)
    counts[slug] = (counts[slug] || 0) + 1
    const out = {
      id: item.id ? String(item.id) : `${slug}-${counts[slug]}`,
      label,
      box_2d: box,
      mask,
    }
    if (keepChildren && Array.isArray(item.children)) out.children = item.children.map(String)
    if (item.removal) out.removal = item.removal
    cleaned.push(out)
    if (cleaned.length >= maxObjects) break
  }
  return keepChildren ? cleaned.map((o) => ({ children: [], ...o })) : computeChildren(cleaned)
}

// Smallest object under the point wins, so a pillow beats the sofa it sits on.
export function hitTest(objects, point) {
  let best = null
  let bestArea = Infinity
  for (const o of objects) {
    if (!pointInPolygon(point, o.mask)) continue
    const area = polygonArea(o.mask)
    if (area < bestArea) {
      best = o
      bestArea = area
    }
  }
  return best
}

// Object plus everything resting on it (recursively).
export function withDescendants(objects, id) {
  const byId = new Map(objects.map((o) => [o.id, o]))
  const out = []
  const seen = new Set()
  const visit = (oid) => {
    if (seen.has(oid) || !byId.has(oid)) return
    seen.add(oid)
    const o = byId.get(oid)
    out.push(o)
    for (const c of o.children || []) visit(c)
  }
  visit(id)
  return out
}

// Drop picks that rest on other picks (pillow + the sofa it sits on -> sofa).
export function topLevel(objects, ids) {
  const covered = new Set()
  for (const id of ids) for (const d of withDescendants(objects, id).slice(1)) covered.add(d.id)
  return [...new Set(ids)].filter((id) => !covered.has(id))
}

// "a", "a and b", "a, b, and c"
export function listJoin(items) {
  if (items.length <= 1) return items.join('')
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

// Outlines of untouched objects that an edit's mask must not cover (wall art,
// a chair next to the removed bed). Floor coverings stay editable, because
// removed furniture leaves its shadow on the rug.
const FLOOR_COVERING_RE = /rug|carpet|runner|\bmat\b/
export function protectedOutlines(objects, editedPolygons) {
  const edited = new Set(editedPolygons.map((p) => JSON.stringify(p)))
  return objects.filter((o) => !edited.has(JSON.stringify(o.mask)) && !FLOOR_COVERING_RE.test(o.label)).map((o) => o.mask)
}

const plural = (w) => (/(s|x|z|ch|sh)$/.test(w) ? `${w}es` : /[^aeiou]y$/.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`)

// ['armchair', 'armchair', 'side table'] -> "2 armchairs and side table"
export function describeItems(labels) {
  const counts = new Map()
  for (const l of labels) counts.set(l, (counts.get(l) || 0) + 1)
  return listJoin([...counts].map(([l, n]) => (n > 1 ? `${n} ${plural(l)}` : l)))
}

export const SUPPORTED_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']

export function nearestAspectRatio(width, height, options = SUPPORTED_ASPECT_RATIOS) {
  const target = Math.log(width / height)
  let best = options[0]
  let bestDiff = Infinity
  for (const r of options) {
    const [a, b] = r.split(':').map(Number)
    const diff = Math.abs(Math.log(a / b) - target)
    if (diff < bestDiff) {
      best = r
      bestDiff = diff
    }
  }
  return best
}

export function fitWithin(width, height, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(width, height))
  return { width: Math.round(width * scale), height: Math.round(height * scale), scale }
}
