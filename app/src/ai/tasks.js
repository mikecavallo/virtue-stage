// One function per AI task. Inputs and outputs are plain data (base64 images,
// JSON), so these run the same in the browser and in Node scripts/tests.
import { generateContent, extractImage, extractText, parseJson, imagePart, textPart, GeminiError } from './gemini.js'
import {
  ROOM_DETECT_PROMPT,
  ROOM_DETECT_SCHEMA,
  ROOM_TYPES,
  SEGMENT_PROMPT,
  SEGMENT_SCHEMA,
  STRUCTURE_CHECK_PROMPT,
  STRUCTURE_CHECK_SCHEMA,
} from './prompts.js'
import { normalizeObjects } from '../lib/geometry.js'

const jsonConfig = (schema, thinkingLevel = 'LOW') => ({
  responseMimeType: 'application/json',
  responseSchema: schema,
  thinkingConfig: { thinkingLevel },
})

export async function detectRoom({ apiKey, model, image, signal, fetchImpl }) {
  const resp = await generateContent({
    apiKey,
    model,
    signal,
    fetchImpl,
    parts: [imagePart(image.data, image.mimeType), textPart(ROOM_DETECT_PROMPT)],
    generationConfig: jsonConfig(ROOM_DETECT_SCHEMA),
  })
  const raw = parseJson(extractText(resp))
  const roomType = ROOM_TYPES.some((r) => r.id === raw.roomType) ? raw.roomType : 'living-room'
  return {
    roomType,
    isEmpty: Boolean(raw.isEmpty),
    confidence: Math.min(1, Math.max(0, Number(raw.confidence) || 0)),
    summary: String(raw.summary || ''),
  }
}

export async function segmentObjects({ apiKey, model, image, signal, fetchImpl }) {
  const resp = await generateContent({
    apiKey,
    model,
    signal,
    fetchImpl,
    parts: [imagePart(image.data, image.mimeType), textPart(SEGMENT_PROMPT)],
    // Lowest level gemini-3.8-flash accepts (it has no MINIMAL). Other models
    // that reject it fall back to their default inside generateContent.
    generationConfig: jsonConfig(SEGMENT_SCHEMA, 'LOW'),
  })
  let raw = parseJson(extractText(resp))
  if (raw && !Array.isArray(raw) && Array.isArray(raw.items)) raw = raw.items
  return normalizeObjects(raw, { maxObjects: 15 })
}

export async function checkStructure({ apiKey, model, original, edited, signal, fetchImpl }) {
  const resp = await generateContent({
    apiKey,
    model,
    signal,
    fetchImpl,
    parts: [
      textPart('Image A:'),
      imagePart(original.data, original.mimeType),
      textPart('Image B:'),
      imagePart(edited.data, edited.mimeType),
      textPart(STRUCTURE_CHECK_PROMPT),
    ],
    generationConfig: jsonConfig(STRUCTURE_CHECK_SCHEMA),
  })
  const raw = parseJson(extractText(resp))
  const issues = Array.isArray(raw.issues) ? raw.issues.map(String).filter(Boolean) : []
  return { preserved: Boolean(raw.preserved) && issues.length === 0, issues }
}

// images: [{ data, mimeType }]. Returns { data, mimeType, text }.
export async function generateImage({ apiKey, model, prompt, images = [], aspectRatio, imageSize = '2K', signal, fetchImpl }) {
  const parts = [textPart(prompt), ...images.map((im) => imagePart(im.data, im.mimeType))]
  const imageConfig = { imageSize }
  if (aspectRatio) imageConfig.aspectRatio = aspectRatio
  const resp = await generateContent({
    apiKey,
    model,
    signal,
    fetchImpl,
    parts,
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig },
  })
  const img = extractImage(resp)
  const text = extractText(resp)
  if (!img) {
    throw new GeminiError(
      text ? `The model answered with text instead of an image: "${text.slice(0, 160)}"` : 'The model did not return an image. Try again.',
      { code: 'no_image', raw: resp },
    )
  }
  return { ...img, text }
}
