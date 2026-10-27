// Orchestration: the "architecture lock" lives here.
//  - Object edits: the model sees the tapped object highlighted, then we paste its
//    output back ONLY inside that object's (dilated, feathered) outline. Every
//    pixel outside the edit is the original pixel, by construction.
//  - Whole-room staging can't be masked, so a vision model checks the result for
//    architectural changes and we regenerate once with the problems spelled out.
import { generateImage, checkStructure } from './tasks.js'
import { buildEditPrompt, buildStagingPrompt } from './prompts.js'
import { nearestAspectRatio, withDescendants, toPixels } from '../lib/geometry.js'
import { hexToRgb } from '../lib/pixels.js'
import {
  base64ToCanvas,
  canvasToBase64,
  cloneCanvas,
  compositeWithMask,
  driftOutsideMask,
  guideImage,
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
    remove: { dilate: d * 0.012, feather: d * 0.008 },
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

export async function runObjectEdit({ settings, canvas, objects, object, action, instruction, onStatus = () => {}, signal }) {
  const targets = action === 'remove' ? withDescendants(objects, object.id) : [object]
  const polygons = targets.map((o) => o.mask)
  const childLabels = targets.slice(1).map((o) => o.label)
  const input = canvasToBase64(canvas)
  const guide = canvasToBase64(guideImage(canvas, polygons))
  const prompt = buildEditPrompt({ action, label: object.label, childLabels, instruction })
  const mask = editMask(canvas, polygons, action)
  const aspectRatio = nearestAspectRatio(canvas.width, canvas.height)

  let best = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    onStatus(attempt === 1 ? `Asking ${settings.imageModel} to ${action} the ${object.label}` : 'The model shifted the photo. Retrying once')
    const out = await generateImage({
      apiKey: settings.apiKey,
      model: settings.imageModel,
      prompt,
      images: [input, guide],
      aspectRatio,
      imageSize: settings.imageSize,
      signal,
    })
    const generated = await base64ToCanvas(out, canvas.width, canvas.height)
    const drift = driftOutsideMask(canvas, generated, mask)
    if (!best || drift < best.drift) best = { generated, drift, attempt }
    if (drift <= DRIFT_LIMIT) break
  }
  onStatus('Pasting the edit back inside the outline')
  return {
    canvas: compositeWithMask(canvas, best.generated, mask),
    removedIds: action === 'remove' ? targets.map((o) => o.id) : [],
    drift: best.drift,
    attempts: best.attempt,
  }
}

export async function runStaging({ settings, canvas, roomType, style, isEmpty, onStatus = () => {}, signal }) {
  const input = canvasToBase64(canvas)
  const aspectRatio = nearestAspectRatio(canvas.width, canvas.height)
  let issues = []
  let last = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    onStatus(attempt === 1 ? `Staging with ${settings.imageModel}` : 'Architecture changed. Regenerating with fixes')
    const out = await generateImage({
      apiKey: settings.apiKey,
      model: settings.imageModel,
      prompt: buildStagingPrompt({ style, roomType, isEmpty, issues }),
      images: [input],
      aspectRatio,
      imageSize: settings.imageSize,
      signal,
    })
    const staged = await base64ToCanvas(out, canvas.width, canvas.height)
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
