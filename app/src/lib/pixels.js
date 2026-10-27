// Pure pixel math. No DOM, so it's unit-testable and reusable in workers.

// Separable box blur on a single 8-bit channel. Three passes approximate a Gaussian.
export function boxBlurChannel(src, width, height, radius, passes = 3) {
  if (radius < 1) return Uint8ClampedArray.from(src)
  let a = Float32Array.from(src)
  let b = new Float32Array(a.length)
  const r = Math.round(radius)
  const win = r * 2 + 1
  for (let pass = 0; pass < passes; pass++) {
    // horizontal
    for (let y = 0; y < height; y++) {
      const row = y * width
      let acc = 0
      for (let x = -r; x <= r; x++) acc += a[row + Math.min(width - 1, Math.max(0, x))]
      for (let x = 0; x < width; x++) {
        b[row + x] = acc / win
        const add = a[row + Math.min(width - 1, x + r + 1)]
        const sub = a[row + Math.max(0, x - r)]
        acc += add - sub
      }
    }
    ;[a, b] = [b, a]
    // vertical
    for (let x = 0; x < width; x++) {
      let acc = 0
      for (let y = -r; y <= r; y++) acc += a[Math.min(height - 1, Math.max(0, y)) * width + x]
      for (let y = 0; y < height; y++) {
        b[y * width + x] = acc / win
        const add = a[Math.min(height - 1, y + r + 1) * width + x]
        const sub = a[Math.max(0, y - r) * width + x]
        acc += add - sub
      }
    }
    ;[a, b] = [b, a]
  }
  return Uint8ClampedArray.from(a, (v) => Math.round(v))
}

// ── Color space (sRGB D65 <-> CIELAB) ──
const srgbToLinear = (c) => {
  c /= 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
const linearToSrgb = (c) => {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055
  return Math.round(Math.min(1, Math.max(0, v)) * 255)
}
const XN = 0.95047
const YN = 1
const ZN = 1.08883
const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116)
const finv = (t) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27))

export function rgbToLab([r, g, b]) {
  const lr = srgbToLinear(r)
  const lg = srgbToLinear(g)
  const lb = srgbToLinear(b)
  const x = (lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375) / XN
  const y = (lr * 0.2126729 + lg * 0.7151522 + lb * 0.072175) / YN
  const z = (lr * 0.0193339 + lg * 0.119192 + lb * 0.9503041) / ZN
  const fx = f(x)
  const fy = f(y)
  const fz = f(z)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

export function labToRgb([L, A, B]) {
  const fy = (L + 16) / 116
  const fx = fy + A / 500
  const fz = fy - B / 200
  const x = finv(fx) * XN
  const y = finv(fy) * YN
  const z = finv(fz) * ZN
  const lr = x * 3.2404542 + y * -1.5371385 + z * -0.4985314
  const lg = x * -0.969266 + y * 1.8760108 + z * 0.041556
  const lb = x * 0.0556434 + y * -0.2040259 + z * 1.0572252
  return [linearToSrgb(lr), linearToSrgb(lg), linearToSrgb(lb)]
}

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim())
  if (!m) throw new Error(`Bad hex color: ${hex}`)
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

// Recolor the masked region of an RGBA buffer toward `targetRgb`.
// Keeps the original lightness variation (texture, folds, shadows) and swaps
// the chroma, so fabric still looks like fabric. Mask is 0-255 per pixel.
export function recolorPixels(rgba, mask, targetRgb, { strength = 1, lightness = 0.65 } = {}) {
  const out = Uint8ClampedArray.from(rgba)
  const [Lt, At, Bt] = rgbToLab(targetRgb)
  // Mean lightness of the region, weighted by mask.
  let sumL = 0
  let sumW = 0
  for (let i = 0, p = 0; p < mask.length; p++, i += 4) {
    const w = mask[p] / 255
    if (w <= 0) continue
    sumL += rgbToLab([rgba[i], rgba[i + 1], rgba[i + 2]])[0] * w
    sumW += w
  }
  if (!sumW) return out
  const meanL = sumL / sumW
  const shift = (Lt - meanL) * lightness
  for (let i = 0, p = 0; p < mask.length; p++, i += 4) {
    const w = (mask[p] / 255) * strength
    if (w <= 0) continue
    const [L] = rgbToLab([rgba[i], rgba[i + 1], rgba[i + 2]])
    const nL = Math.min(100, Math.max(0, L + shift))
    const [r, g, b] = labToRgb([nL, At, Bt])
    out[i] = Math.round(rgba[i] * (1 - w) + r * w)
    out[i + 1] = Math.round(rgba[i + 1] * (1 - w) + g * w)
    out[i + 2] = Math.round(rgba[i + 2] * (1 - w) + b * w)
  }
  return out
}

// Mean absolute difference (0-255) between two same-size grayscale buffers,
// counting only pixels where `weight` is 0 (outside the edit). Used to catch
// generations where the model shifted, zoomed, or recomposed the photo.
export function outsideMaskDifference(grayA, grayB, weight) {
  let sum = 0
  let n = 0
  for (let i = 0; i < grayA.length; i++) {
    if (weight && weight[i] > 8) continue
    sum += Math.abs(grayA[i] - grayB[i])
    n++
  }
  return n ? sum / n : 0
}

export function rgbaToGray(rgba) {
  const out = new Uint8ClampedArray(rgba.length / 4)
  for (let i = 0, p = 0; p < out.length; p++, i += 4) {
    out[p] = Math.round(rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114)
  }
  return out
}
