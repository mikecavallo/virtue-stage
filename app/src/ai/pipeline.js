// Orchestration: the "architecture lock" lives here.
//  - Object edits: the model sees the tapped object highlighted, then we paste its
//    output back ONLY inside that object's (dilated, feathered) outline. Every
//    pixel outside the edit is the original pixel, by construction.
//  - Whole-room staging can't be masked, so a vision model checks the result for
//    architectural changes and we regenerate once with the problems spelled out.
import { generateImage, checkStructure } from './tasks.js'
import { buildEditPrompt, buildMatchStagingPrompt, buildPolishPrompt, buildStagingPrompt } from './prompts.js'
import { nearestAspectRatio, protectedOutlines, topLevel, withDescendants, toPixels } from '../lib/geometry.js'
import { hexToRgb } from '../lib/pixels.js'
import {
  base64ToCanvas,
  canvasToBase64,
  cloneCanvas,
  compositeWithMask,
  cropBox,
  driftOutsideMask,
  guideImage,
  guideFromMask,
  loadImage,
  polygonMask,
  recolorCanvas,
  featherMask,
} from '../lib/canvas.js'

const DRIFT_LIMIT = 14 // mean gray difference (0-255) outside the edit before we retry

const diag = (c) => Math.hypot(c.width, c.height)

export function editMask(canvas, polygons, action, subtract = []) {
  const d = diag(canvas)
  const opts = {
    // Removals include the cleanup pass: the mask reaches past the outline to
    // take shadows and smudges with it (untouched neighbours are cut back out).
    remove: { dilate: d * 0.035, feather: d * 0.015 },
    polish: { dilate: d * 0.035, feather: d * 0.015 },
    replace: { dilate: d * 0.03, feather: d * 0.012 },
    restyle: { dilate: d * 0.005, feather: d * 0.004 },
    recolor: { dilate: 1, feather: d * 0.003 },
  }[action]
  const mask = polygonMask(canvas.width, canvas.height, polygons, { dilate: opts.dilate })
  if (subtract.length) {
    // Keep things resting on the object (pillows on a sofa) out of a recolor.
    const ctx = mask.getContext('2d')
    ctx.globalCompositeOperation = 'destination-out'
    ctx.fillStyle = '#000'
    for (const poly of subtract) {
      const pts = toPixels(poly, canvas.width, canvas.height)
      ctx.beginPath()
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
      ctx.closePath()
      ctx.fill()
    }
    ctx.globalCompositeOperation = 'source-over'
  }
  return featherMask(mask, opts.feather)
}

// Generate with the model, keep the attempt that drifted least outside the mask,
// and paste it back inside the mask only.
async function generateMasked({ settings, canvas, prompt, images, mask, firstStatus, pasteStatus, onStatus, signal }) {
  const aspectRatio = nearestAspectRatio(canvas.width, canvas.height)
  let best = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    onStatus(attempt === 1 ? firstStatus : 'The model shifted the photo. Retrying once')
    const out = await generateImage({ apiKey: settings.apiKey, model: settings.imageModel, prompt, images, aspectRatio, imageSize: settings.imageSize, signal })
    const generated = await base64ToCanvas(out, canvas.width, canvas.height)
    const drift = driftOutsideMask(canvas, generated, mask)
    if (!best || drift < best.drift) best = { generated, drift, attempt }
    if (drift <= DRIFT_LIMIT) break
  }
  onStatus(pasteStatus)
  return { canvas: compositeWithMask(canvas, best.generated, mask), drift: best.drift, attempts: best.attempt }
}

// `objectIds` (removal only) removes a whole multi-selection in one model call.
export async function runObjectEdit({ settings, canvas, objects, object, objectIds, action, instruction, onStatus = () => {}, signal }) {
  const picks = action === 'remove' && objectIds?.length ? topLevel(objects, objectIds) : [object.id]
  const pickObjs = picks.map((id) => objects.find((o) => o.id === id)).filter(Boolean)
  const targets = action === 'remove' ? [...new Map(pickObjs.flatMap((o) => withDescendants(objects, o.id)).map((o) => [o.id, o])).values()] : [object]
  const polygons = targets.map((o) => o.mask)
  const labels = pickObjs.map((o) => o.label)
  const childLabels = targets.filter((t) => !picks.includes(t.id)).map((o) => o.label)
  const result = await generateMasked({
    settings,
    canvas,
    prompt: buildEditPrompt({ action, label: object.label, labels, childLabels, instruction }),
    images: [canvasToBase64(canvas), canvasToBase64(guideImage(canvas, polygons))],
    mask: editMask(canvas, polygons, action, action === 'remove' ? protectedOutlines(objects, polygons) : []),
    firstStatus: picks.length > 1 ? `Asking ${settings.imageModel} to remove ${picks.length} items in one pass` : `Asking ${settings.imageModel} to ${action} the ${object.label}`,
    pasteStatus: 'Pasting the edit back inside the outline',
    onStatus,
    signal,
  })
  return { ...result, polygons, removedIds: action === 'remove' ? targets.map((o) => o.id) : [] }
}

// Cleanup pass over every area edited so far (see editedRegions in history.js).
// `protect` are outlines of untouched objects near the edits (wall art, a chair)
// that are cut out of the mask so the cleanup can't alter them.
export async function runPolish({ settings, canvas, polygons, protect = [], onStatus = () => {}, signal }) {
  const mask = editMask(canvas, polygons, 'polish', protect)
  return generateMasked({
    settings,
    canvas,
    prompt: buildPolishPrompt(),
    images: [canvasToBase64(canvas), canvasToBase64(guideFromMask(canvas, mask))],
    mask,
    firstStatus: `Polishing the edited areas with ${settings.imageModel}`,
    pasteStatus: 'Pasting the cleanup back inside the edited areas',
    onStatus,
    signal,
  })
}

// `keep`: objects to stage around ("match existing furniture"). They go in as
// reference crops and their pixels are pasted back over the result.
export async function runStaging({ settings, canvas, roomType, style, isEmpty, keep = [], onStatus = () => {}, signal }) {
  const input = canvasToBase64(canvas)
  const refs = keep.map((o) => canvasToBase64(cropBox(canvas, o.box_2d), { maxSide: 768 }))
  const keepMask = keep.length ? editMask(canvas, keep.map((o) => o.mask), 'restyle') : null
  const aspectRatio = nearestAspectRatio(canvas.width, canvas.height)
  let issues = []
  let last = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    onStatus(attempt === 1 ? `Staging with ${settings.imageModel}` : 'Architecture changed. Regenerating with fixes')
    const out = await generateImage({
      apiKey: settings.apiKey,
      model: settings.imageModel,
      prompt: keep.length
        ? buildMatchStagingPrompt({ roomType, keepLabels: keep.map((o) => o.label), issues })
        : buildStagingPrompt({ style, roomType, isEmpty, issues }),
      images: [input, ...refs],
      aspectRatio,
      imageSize: settings.imageSize,
      signal,
    })
    let staged = await base64ToCanvas(out, canvas.width, canvas.height)
    if (keepMask) staged = compositeWithMask(staged, canvas, keepMask)
    onStatus(`Checking architecture with ${settings.visionModel}`)
    let qa
    try {
      qa = await checkStructure({
        apiKey: settings.apiKey,
        model: settings.visionModel,
        original: canvasToBase64(canvas, { maxSide: 1024 }),
        edited: canvasToBase64(staged, { maxSide: 1024 }),
        signal,
      })
    } catch (e) {
      if (e?.name === 'AbortError') throw e
      qa = { preserved: null, issues: [], error: e.message }
    }
    last = { canvas: staged, qa: { ...qa, attempts: attempt } }
    if (qa.preserved !== false) break
    issues = qa.issues
  }
  return last
}

// Demo mode: removal results were precomputed offline (see scripts/demo-assets).
export async function applyPrecomputedRemoval({ canvas, object, baseUrl, sourceWidth, sourceHeight }) {
  const { patch, x, y, w, h } = object.removal
  const img = await loadImage(`${baseUrl}${patch}`)
  const sx = canvas.width / sourceWidth
  const sy = canvas.height / sourceHeight
  const out = cloneCanvas(canvas)
  out.getContext('2d').drawImage(img, x * sx, y * sy, w * sx, h * sy)
  return out
}

export function applyRecolor({ canvas, objects, object, hex }) {
  const children = (object.children || [])
    .map((id) => objects.find((o) => o.id === id))
    .filter(Boolean)
    .map((o) => o.mask)
  const mask = editMask(canvas, [object.mask], 'recolor', children)
  return recolorCanvas(canvas, mask, hexToRgb(hex))
}
