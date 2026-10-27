// Minimal Gemini REST client (generateContent). Works in the browser and in Node 18+.
// Uses the stable generateContent API rather than the beta Interactions API.
// The API key is the visitor's own; requests go straight from their browser to Google.

export const API_BASE = 'https://generativelanguage.googleapis.com/v1beta'

export const MODELS = {
  image: 'gemini-nano-banana-2.1',
  vision: 'gemini-3.8-flash',
}

export const IMAGE_MODEL_OPTIONS = [
  { id: 'gemini-nano-banana-2.1', label: 'Nano Banana 2.1 (recommended)' },
  { id: 'gemini-3.1-flash-image', label: 'Nano Banana 2' },
  { id: 'gemini-3-pro-image', label: 'Nano Banana Pro' },
]

export const VISION_MODEL_OPTIONS = [
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash (recommended)' },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite (cheaper)' },
]

export class GeminiError extends Error {
  constructor(message, { status, code, reason, raw } = {}) {
    super(message)
    this.name = 'GeminiError'
    this.status = status
    this.code = code
    this.reason = reason
    this.raw = raw
  }
}

export const textPart = (text) => ({ text })
export const imagePart = (data, mimeType = 'image/jpeg') => ({ inlineData: { mimeType, data } })

// Errors the user fixes by entering a different key. The studio reacts to these
// by opening the key prompt and retrying the action once a new key is saved.
export const KEY_ERROR_CODES = new Set(['no_key', 'bad_key', 'expired_key', 'forbidden'])
export const isKeyError = (e) => KEY_ERROR_CODES.has(e?.code)

function friendlyError(status, body, model) {
  const err = body?.error || {}
  const msg = err.message || `Request failed with status ${status}`
  const reason = err.details?.find?.((d) => d.reason)?.reason || err.status
  const keyProblem = status === 401 || /API[ _]key|API_KEY/i.test(`${msg} ${reason || ''}`)
  if ((status === 400 || status === 401) && keyProblem) {
    if (/expired/i.test(`${msg} ${reason || ''}`)) {
      return new GeminiError('Your Gemini API key has expired. Paste a new one to keep going.', { status, code: 'expired_key', reason, raw: body })
    }
    return new GeminiError('Google rejected this Gemini API key. Paste a valid one to keep going.', { status, code: 'bad_key', reason, raw: body })
  }
  if (status === 403) return new GeminiError('This key does not have access to that model. Image models need a key with billing enabled.', { status, code: 'forbidden', reason, raw: body })
  if (status === 404) return new GeminiError(`Model "${model}" is not available to this key. Pick another model in Settings.`, { status, code: 'model_not_found', reason, raw: body })
  if (status === 429) return new GeminiError('Rate limit or quota reached. Image models are not on the free tier, so this usually means the key needs billing enabled.', { status, code: 'quota', reason, raw: body })
  if (status >= 500) return new GeminiError('Google returned a server error. Try again in a moment.', { status, code: 'server', reason, raw: body })
  return new GeminiError(msg, { status, code: 'request', reason, raw: body })
}

export async function generateContent({ apiKey, model, parts, generationConfig, systemInstruction, signal, fetchImpl }) {
  if (!apiKey) throw new GeminiError('Add a Gemini API key in Settings to use live AI.', { code: 'no_key' })
  const doFetch = fetchImpl || globalThis.fetch
  const body = { contents: [{ role: 'user', parts }] }
  if (generationConfig) body.generationConfig = generationConfig
  if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] }
  let res
  try {
    res = await doFetch(`${API_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal,
    })
  } catch (e) {
    if (e?.name === 'AbortError') throw e
    throw new GeminiError('Could not reach Google. Check your connection.', { code: 'network', raw: String(e) })
  }
  let json = null
  try {
    json = await res.json()
  } catch {
    json = null
  }
  if (!res.ok) {
    // Thinking levels differ per model (gemini-3.8-flash has no MINIMAL, image
    // models have their own sets). If ours is rejected, retry once with the
    // model's default instead of failing the whole edit.
    const msg = json?.error?.message || ''
    if (res.status === 400 && generationConfig?.thinkingConfig && /thinking|\blevel\b.*not supported/i.test(msg)) {
      const fallback = { ...generationConfig }
      delete fallback.thinkingConfig
      return generateContent({ apiKey, model, parts, generationConfig: fallback, systemInstruction, signal, fetchImpl })
    }
    throw friendlyError(res.status, json, model)
  }
  const blocked = blockReason(json)
  if (blocked) {
    throw new GeminiError(`The model declined this request (${blocked}). Try different wording or another photo.`, { status: res.status, code: 'blocked', reason: blocked, raw: json })
  }
  return json
}

function partsOf(resp) {
  return resp?.candidates?.[0]?.content?.parts || []
}

export function blockReason(resp) {
  const pf = resp?.promptFeedback?.blockReason
  if (pf) return pf
  const finish = resp?.candidates?.[0]?.finishReason
  if (finish && /SAFETY|PROHIBITED|BLOCKLIST|SPII|RECITATION/.test(finish)) return finish
  if (resp && Array.isArray(resp.candidates) && resp.candidates.length === 0) return 'NO_CANDIDATES'
  return null
}

// Final answer only: skip "thought" parts (Gemini 3 image models emit interim thought images).
export function extractImage(resp) {
  const images = partsOf(resp)
    .filter((p) => !p.thought)
    .map((p) => p.inlineData || p.inline_data)
    .filter((d) => d && d.data)
  const last = images[images.length - 1]
  if (!last) return null
  return { data: last.data, mimeType: last.mimeType || last.mime_type || 'image/png' }
}

export function extractText(resp) {
  return partsOf(resp)
    .filter((p) => !p.thought && typeof p.text === 'string')
    .map((p) => p.text)
    .join('')
    .trim()
}

// Models sometimes wrap JSON in code fences even in JSON mode. Be forgiving.
export function parseJson(text) {
  if (!text) throw new GeminiError('The model returned an empty response.', { code: 'empty' })
  let t = text.trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t)
  if (fence) t = fence[1]
  try {
    return JSON.parse(t)
  } catch {
    const start = t.search(/[[{]/)
    const end = Math.max(t.lastIndexOf(']'), t.lastIndexOf('}'))
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(t.slice(start, end + 1))
      } catch {
        // fall through
      }
    }
    throw new GeminiError('The model returned malformed JSON.', { code: 'bad_json', raw: text })
  }
}

export async function listModels({ apiKey, fetchImpl, signal }) {
  const doFetch = fetchImpl || globalThis.fetch
  const res = await doFetch(`${API_BASE}/models?pageSize=200`, {
    headers: { 'x-goog-api-key': apiKey },
    signal,
  })
  let json = null
  try {
    json = await res.json()
  } catch {
    json = null
  }
  if (!res.ok) throw friendlyError(res.status, json, 'models')
  return (json?.models || []).map((m) => String(m.name || '').replace(/^models\//, ''))
}
