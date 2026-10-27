// Edit history. Each step is a full image (kept as a canvas outside React state)
// plus the object inventory valid for that image and the operation that made it.
//
// Cheap, deterministic ops (demo removals from precomputed patches, recolors) are
// "replayable": instead of stacking them on the previous bitmap, we re-render
// from the last baked image. That keeps them consistent with each other, e.g.
// recolor the sofa, then remove a pillow, and the fabric under the pillow is
// recolored too. Generative ops (Gemini) are baked and become the new base.
import { cloneCanvas, loadImage, recolorCanvas } from '../lib/canvas.js'
import { withDescendants } from '../lib/geometry.js'
import { hexToRgb } from '../lib/pixels.js'
import { editMask } from '../ai/pipeline.js'

export const REPLAYABLE = new Set(['demo-remove', 'recolor'])

export const initialState = {
  photo: null,
  steps: [],
  cursor: -1,
  selectedId: null,
  busy: null,
  error: null,
  notice: null,
}

export function reducer(state, action) {
  switch (action.type) {
    case 'busy':
      return { ...state, busy: action.label, error: null }
    case 'idle':
      return { ...state, busy: null }
    case 'load':
      return { ...initialState, photo: action.photo, steps: [action.step], cursor: 0 }
    case 'photo-meta':
      return state.photo ? { ...state, photo: { ...state.photo, ...action.patch } } : state
    case 'set-objects': {
      // A rescanned step becomes a new replay base: its objects no longer match the older inventory.
      const steps = state.steps.map((s, i) =>
        i === state.cursor
          ? { ...s, objects: action.objects, scanned: true, op: REPLAYABLE.has(s.op?.type) ? { type: 'rescan', after: s.op } : s.op }
          : s,
      )
      return { ...state, steps, selectedId: null }
    }
    case 'push': {
      const steps = [...state.steps.slice(0, state.cursor + 1), action.step]
      const keep = action.step.objects.some((o) => o.id === state.selectedId)
      return { ...state, steps, cursor: steps.length - 1, busy: null, selectedId: keep ? state.selectedId : null }
    }
    case 'goto':
      if (action.index < 0 || action.index >= state.steps.length) return state
      return { ...state, cursor: action.index, selectedId: null }
    case 'select':
      return { ...state, selectedId: action.id }
    case 'error':
      return { ...state, busy: null, error: action.message }
    case 'notice':
      return { ...state, notice: action.message }
    case 'dismiss':
      return { ...state, error: null, notice: null }
    default:
      return state
  }
}

// Index of the step that replayable ops should be rendered on top of.
export function replayBaseIndex(steps, cursor) {
  let i = cursor
  while (i > 0 && REPLAYABLE.has(steps[i].op?.type)) i--
  return i
}

const patchCache = new Map()
function loadPatch(url) {
  if (!patchCache.has(url)) patchCache.set(url, loadImage(url))
  return patchCache.get(url)
}

// Render `ops` on top of `base`. `objects` is the inventory of the base image.
export async function renderOps({ base, objects, ops, patchBaseUrl, sourceWidth, sourceHeight }) {
  let canvas = cloneCanvas(base)
  const byId = new Map(objects.map((o) => [o.id, o]))
  const removed = new Set()
  const ctx = canvas.getContext('2d')
  for (const op of ops) {
    if (op.type !== 'demo-remove') continue
    for (const o of withDescendants(objects, op.objectId)) removed.add(o.id)
    const obj = byId.get(op.objectId)
    if (!obj?.removal) continue
    const { patch, x, y, w, h } = obj.removal
    const img = await loadPatch(`${patchBaseUrl}${patch}`)
    const sx = canvas.width / (sourceWidth || canvas.width)
    const sy = canvas.height / (sourceHeight || canvas.height)
    ctx.drawImage(img, x * sx, y * sy, w * sx, h * sy)
  }
  // Last recolor per object wins.
  const colors = new Map()
  for (const op of ops) if (op.type === 'recolor') colors.set(op.objectId, op.hex)
  for (const [id, hex] of colors) {
    const obj = byId.get(id)
    if (!obj || removed.has(id)) continue
    const keepOut = (obj.children || [])
      .filter((c) => !removed.has(c) && byId.has(c))
      .map((c) => byId.get(c).mask)
    canvas = recolorCanvas(canvas, editMask(canvas, [obj.mask], 'recolor', keepOut), hexToRgb(hex))
  }
  return { canvas, removed }
}

const REGION_OPS = new Set(['remove', 'demo-remove', 'replace', 'restyle'])

// Polygons of every object edit since the last whole-photo change (original
// photo or staging). These are the areas "Polish" cleans up.
export function editedRegions(steps, cursor) {
  const polygons = []
  for (let i = cursor; i > 0; i--) {
    const raw = steps[i]?.op || {}
    if (raw.type === 'stage' || raw.type === 'original') break
    const op = raw.type === 'rescan' ? raw.after || {} : raw
    if (REGION_OPS.has(op.type) && Array.isArray(op.polygons)) polygons.push(...op.polygons)
  }
  return polygons
}

// Untouched objects whose pixels Polish must not change. Floor coverings stay
// cleanable, because removed furniture leaves its shadow on the rug.
const FLOOR_COVERING_RE = /rug|carpet|runner|\bmat\b/
export function polishProtect(objects, regions) {
  const edited = new Set(regions.map((p) => JSON.stringify(p)))
  return objects.filter((o) => !edited.has(JSON.stringify(o.mask)) && !FLOOR_COVERING_RE.test(o.label)).map((o) => o.mask)
}

export function withoutRemoved(objects, removedIds) {
  const gone = new Set(removedIds)
  return objects
    .filter((o) => !gone.has(o.id))
    .map((o) => ({ ...o, children: (o.children || []).filter((c) => !gone.has(c)) }))
}

export function disclosureText(steps, cursor) {
  const active = steps.slice(1, cursor + 1)
  if (active.some((s) => s.op?.type === 'stage')) return 'Virtually staged'
  return active.length ? 'Digitally altered' : ''
}

export function changeLog(photo, steps, cursor) {
  const lines = [`VirtueStage change log for "${photo?.name || 'photo'}"`, '']
  steps.slice(1, cursor + 1).forEach((s, i) => {
    lines.push(`${i + 1}. ${s.label}${s.engine ? ` [${s.engine}]` : ''}${s.note ? ` (${s.note})` : ''}`)
  })
  if (lines.length === 2) lines.push('No changes.')
  lines.push('', 'Pixels outside each object edit are copied from the original photo.')
  return lines.join('\n')
}
