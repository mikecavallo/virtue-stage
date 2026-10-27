// Canvas helpers: loading, masking, compositing, encoding.
import { toPixels, fitWithin } from './geometry.js'
import { boxBlurChannel, recolorPixels, outsideMaskDifference, rgbaToGray } from './pixels.js'

export function createCanvas(width, height) {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(width))
  c.height = Math.max(1, Math.round(height))
  return c
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.decoding = 'async'
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`Could not load image: ${String(src).slice(0, 80)}`))
    img.src = src
  })
}

export function imageToCanvas(img, width = img.naturalWidth || img.width, height = img.naturalHeight || img.height) {
  const c = createCanvas(width, height)
  const ctx = c.getContext('2d')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0, c.width, c.height)
  return c
}

export function cloneCanvas(src) {
  const c = createCanvas(src.width, src.height)
  c.getContext('2d').drawImage(src, 0, 0)
  return c
}

// Downscale (never upscale) and encode as base64 for the API.
export function canvasToBase64(canvas, { maxSide = 1536, mimeType = 'image/jpeg', quality = 0.9 } = {}) {
  const { width, height } = fitWithin(canvas.width, canvas.height, maxSide)
  const c = width === canvas.width && height === canvas.height ? canvas : imageToCanvas(canvas, width, height)
  const url = c.toDataURL(mimeType, quality)
  return { data: url.slice(url.indexOf(',') + 1), mimeType, width, height }
}

export async function base64ToCanvas({ data, mimeType }, width, height) {
  const img = await loadImage(`data:${mimeType};base64,${data}`)
  return imageToCanvas(img, width, height)
}

export function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.92) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), type, quality)
  })
}

// Fill normalized polygons into an alpha mask. `dilate` grows the outline by
// that many pixels (stroke with round joins = Minkowski sum with a disk).
export function polygonMask(width, height, polygons, { dilate = 0, feather = 0 } = {}) {
  const c = createCanvas(width, height)
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.strokeStyle = '#fff'
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.lineWidth = Math.max(0, dilate * 2)
  for (const poly of polygons) {
    const pts = toPixels(poly, width, height)
    ctx.beginPath()
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
    ctx.closePath()
    ctx.fill()
    if (dilate > 0) ctx.stroke()
  }
  if (feather > 0) featherMask(c, feather)
  return c
}

export function rectMask(width, height, { x, y, w, h }, { feather = 0 } = {}) {
  const c = createCanvas(width, height)
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(x, y, w, h)
  if (feather > 0) featherMask(c, feather)
  return c
}

// Blur the alpha channel in place (portable; ctx.filter isn't everywhere).
export function featherMask(maskCanvas, radius) {
  const ctx = maskCanvas.getContext('2d')
  const { width, height } = maskCanvas
  const img = ctx.getImageData(0, 0, width, height)
  const alpha = new Uint8ClampedArray(width * height)
  for (let i = 0; i < alpha.length; i++) alpha[i] = img.data[i * 4 + 3]
  const blurred = boxBlurChannel(alpha, width, height, Math.max(1, Math.round(radius / 2)))
  for (let i = 0; i < alpha.length; i++) {
    img.data[i * 4] = 255
    img.data[i * 4 + 1] = 255
    img.data[i * 4 + 2] = 255
    img.data[i * 4 + 3] = blurred[i]
  }
  ctx.putImageData(img, 0, 0)
  return maskCanvas
}

export function maskAlpha(maskCanvas) {
  const { width, height } = maskCanvas
  const data = maskCanvas.getContext('2d').getImageData(0, 0, width, height).data
  const out = new Uint8ClampedArray(width * height)
  for (let i = 0; i < out.length; i++) out[i] = data[i * 4 + 3]
  return out
}

// base outside the mask, overlay inside it. All three must be the same size.
export function compositeWithMask(base, overlay, mask) {
  const layer = createCanvas(base.width, base.height)
  const lctx = layer.getContext('2d')
  lctx.drawImage(overlay, 0, 0, base.width, base.height)
  lctx.globalCompositeOperation = 'destination-in'
  lctx.drawImage(mask, 0, 0)
  const out = cloneCanvas(base)
  out.getContext('2d').drawImage(layer, 0, 0)
  return out
}

// The magenta "guide" image sent alongside the clean photo, so the model knows
// exactly which object the user tapped.
export function guideImage(base, polygons) {
  const out = cloneCanvas(base)
  const ctx = out.getContext('2d')
  const lw = Math.max(3, Math.round(Math.max(base.width, base.height) / 300))
  for (const poly of polygons) {
    const pts = toPixels(poly, base.width, base.height)
    ctx.beginPath()
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
    ctx.closePath()
    ctx.fillStyle = 'rgba(255, 0, 200, 0.38)'
    ctx.fill()
    ctx.lineWidth = lw
    ctx.strokeStyle = 'rgb(255, 0, 200)'
    ctx.stroke()
  }
  return out
}

export function recolorCanvas(base, mask, targetRgb, options) {
  const out = cloneCanvas(base)
  const ctx = out.getContext('2d')
  const img = ctx.getImageData(0, 0, out.width, out.height)
  const next = recolorPixels(img.data, maskAlpha(mask), targetRgb, options)
  img.data.set(next)
  ctx.putImageData(img, 0, 0)
  return out
}

// How far the generated image drifted from the original outside the edit,
// measured on small grayscale thumbnails (0 = identical, 255 = opposite).
export function driftOutsideMask(a, b, mask, size = 96) {
  const { width, height } = fitWithin(a.width, a.height, size)
  const gray = (c) => rgbaToGray(imageToCanvas(c, width, height).getContext('2d').getImageData(0, 0, width, height).data)
  const m = maskAlpha(imageToCanvas(mask, width, height))
  return outsideMaskDifference(gray(a), gray(b), m)
}

// Burn a disclosure label into the exported photo (California AB 723 style).
export function stampDisclosure(canvas, text) {
  const out = cloneCanvas(canvas)
  const ctx = out.getContext('2d')
  const size = Math.max(14, Math.round(out.width / 55))
  ctx.font = `600 ${size}px "Plus Jakarta Sans", system-ui, sans-serif`
  const padX = size * 0.8
  const padY = size * 0.5
  const w = ctx.measureText(text).width + padX * 2
  const h = size + padY * 2
  const x = size
  const y = out.height - h - size
  ctx.fillStyle = 'rgba(15, 23, 42, 0.78)'
  const r = h / 2
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x + padX, y + h / 2)
  return out
}
