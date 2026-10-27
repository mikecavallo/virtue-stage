import { describe, expect, it, vi } from 'vitest'
import { API_BASE, GeminiError, extractImage, extractText, generateContent, isKeyError, listModels, parseJson } from './gemini.js'
import { generateImage, segmentObjects, checkStructure } from './tasks.js'
import { buildEditPrompt, buildPolishPrompt, buildStagingPrompt, STYLE_IDS, ROOM_TYPES } from './prompts.js'

const jsonResponse = (status, body) => ({ ok: status < 400, status, json: async () => body })
const textResp = (text) => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] })

describe('generateContent', () => {
  it('posts to the generateContent endpoint with the key in a header, not the URL', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, textResp('hi')))
    await generateContent({ apiKey: 'k123', model: 'gemini-3.8-flash', parts: [{ text: 'x' }], fetchImpl })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(`${API_BASE}/models/gemini-3.8-flash:generateContent`)
    expect(url).not.toContain('k123')
    expect(init.headers['x-goog-api-key']).toBe('k123')
    expect(JSON.parse(init.body).contents[0].parts).toEqual([{ text: 'x' }])
  })

  it('refuses to call without a key', async () => {
    await expect(generateContent({ model: 'm', parts: [] })).rejects.toMatchObject({ code: 'no_key' })
  })

  it.each([
    [400, { error: { message: 'API key not valid. Please pass a valid API key.' } }, 'bad_key'],
    [404, { error: { message: 'models/x is not found' } }, 'model_not_found'],
    [429, { error: { message: 'Resource exhausted' } }, 'quota'],
    [503, { error: { message: 'overloaded' } }, 'server'],
  ])('maps HTTP %s to a friendly error', async (status, body, code) => {
    const fetchImpl = async () => jsonResponse(status, body)
    await expect(generateContent({ apiKey: 'k', model: 'x', parts: [], fetchImpl })).rejects.toMatchObject({ code })
  })

  it('tells an expired key apart from an invalid one', async () => {
    const expired = async () =>
      jsonResponse(400, { error: { code: 400, message: 'API key expired. Please renew the API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } })
    const err = await generateContent({ apiKey: 'k', model: 'x', parts: [], fetchImpl: expired }).catch((e) => e)
    expect(err.code).toBe('expired_key')
    expect(isKeyError(err)).toBe(true)
    const unauth = async () => jsonResponse(401, { error: { message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } })
    await expect(listModels({ apiKey: 'k', fetchImpl: unauth })).rejects.toMatchObject({ code: 'bad_key' })
  })

  it('only treats key problems as key errors', () => {
    expect(isKeyError(new GeminiError('x', { code: 'quota' }))).toBe(false)
    expect(isKeyError(new GeminiError('x', { code: 'forbidden' }))).toBe(true)
    expect(isKeyError(new TypeError('network'))).toBe(false)
  })

  it('retries without a thinking level the model does not support', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, { error: { code: 400, message: 'Thinking level MINIMAL is not supported for this model.', status: 'INVALID_ARGUMENT' } }))
      .mockResolvedValueOnce(jsonResponse(200, textResp('[]')))
    const cfg = { responseMimeType: 'application/json', thinkingConfig: { thinkingLevel: 'MINIMAL' } }
    await generateContent({ apiKey: 'k', model: 'gemini-3.8-flash', parts: [{ text: 'x' }], generationConfig: cfg, fetchImpl })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const retryBody = JSON.parse(fetchImpl.mock.calls[1][1].body)
    expect(retryBody.generationConfig).toEqual({ responseMimeType: 'application/json' })
    expect(cfg.thinkingConfig).toBeDefined() // caller's config is not mutated
  })

  it('does not loop when a 400 is unrelated to thinking', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(400, { error: { message: 'Invalid JSON payload received.' } }))
    await expect(generateContent({ apiKey: 'k', model: 'm', parts: [], generationConfig: { thinkingConfig: { thinkingLevel: 'LOW' } }, fetchImpl })).rejects.toMatchObject({ code: 'request' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('surfaces safety blocks', async () => {
    const fetchImpl = async () => jsonResponse(200, { promptFeedback: { blockReason: 'SAFETY' }, candidates: [] })
    await expect(generateContent({ apiKey: 'k', model: 'x', parts: [], fetchImpl })).rejects.toMatchObject({ code: 'blocked' })
  })
})

describe('response parsing', () => {
  it('takes the final image and skips interim thought images', () => {
    const resp = {
      candidates: [
        {
          content: {
            parts: [
              { thought: true, inlineData: { mimeType: 'image/png', data: 'THOUGHT' } },
              { text: 'Here you go' },
              { inlineData: { mimeType: 'image/jpeg', data: 'FINAL' } },
            ],
          },
        },
      ],
    }
    expect(extractImage(resp)).toEqual({ data: 'FINAL', mimeType: 'image/jpeg' })
    expect(extractText(resp)).toBe('Here you go')
  })

  it('accepts snake_case inline_data too', () => {
    const resp = { candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/png', data: 'X' } }] } }] }
    expect(extractImage(resp)).toEqual({ data: 'X', mimeType: 'image/png' })
  })

  it('parses JSON even when wrapped in code fences or prose', () => {
    expect(parseJson('```json\n[{"a":1}]\n```')).toEqual([{ a: 1 }])
    expect(parseJson('Sure! {"preserved": true, "issues": []} Hope that helps')).toEqual({ preserved: true, issues: [] })
    expect(() => parseJson('nope')).toThrow(GeminiError)
  })
})

describe('tasks', () => {
  const image = { data: 'AAAA', mimeType: 'image/jpeg' }

  it('generateImage requests image output at the right size and aspect ratio', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'IMG' } }] } }] }),
    )
    const out = await generateImage({ apiKey: 'k', model: 'gemini-nano-banana-2.1', prompt: 'p', images: [image, image], aspectRatio: '3:2', imageSize: '2K', fetchImpl })
    expect(out.data).toBe('IMG')
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(body.generationConfig.imageConfig).toEqual({ imageSize: '2K', aspectRatio: '3:2' })
    expect(body.generationConfig.responseModalities).toEqual(['TEXT', 'IMAGE'])
    expect(body.contents[0].parts).toHaveLength(3)
  })

  it('generateImage explains text-only answers', async () => {
    const fetchImpl = async () => jsonResponse(200, textResp('I cannot edit this photo.'))
    await expect(generateImage({ apiKey: 'k', model: 'm', prompt: 'p', fetchImpl })).rejects.toMatchObject({ code: 'no_image' })
  })

  it('segmentObjects normalizes Gemini polygons and links children', async () => {
    const raw = [
      { label: 'Sofa', box_2d: [400, 100, 800, 700], mask: [[100, 400], [700, 400], [700, 800], [100, 800]] },
      { label: 'throw pillow', box_2d: [450, 150, 550, 250], mask: [[150, 450], [250, 450], [250, 550], [150, 550]] },
    ]
    const fetchImpl = vi.fn(async () => jsonResponse(200, textResp(JSON.stringify(raw))))
    const objs = await segmentObjects({ apiKey: 'k', model: 'gemini-3.8-flash', image, fetchImpl })
    expect(objs.map((o) => o.id)).toEqual(['sofa-1', 'throw-pillow-1'])
    expect(objs[0].children).toEqual(['throw-pillow-1'])
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(body.generationConfig.responseMimeType).toBe('application/json')
    expect(body.generationConfig.thinkingConfig.thinkingLevel).toBe('LOW')
  })

  it('checkStructure treats any listed issue as a failure', async () => {
    const fetchImpl = async () => jsonResponse(200, textResp('{"preserved": true, "issues": ["window moved"]}'))
    const qa = await checkStructure({ apiKey: 'k', model: 'm', original: image, edited: image, fetchImpl })
    expect(qa).toEqual({ preserved: false, issues: ['window moved'] })
  })
})

describe('prompts', () => {
  it('builds a staging prompt for every style and room', () => {
    for (const style of STYLE_IDS) {
      for (const room of ROOM_TYPES) {
        const p = buildStagingPrompt({ style, roomType: room.id })
        expect(p).toContain('Strictly preserve the property')
        expect(p).not.toContain('undefined')
      }
    }
  })

  it('feeds QA issues back into the retry prompt', () => {
    expect(buildStagingPrompt({ style: 'modern', roomType: 'bedroom', issues: ['added a window'] })).toContain('- added a window')
  })

  it('polish asks for cleanup only, with no new objects', () => {
    const p = buildPolishPrompt()
    expect(p).toContain('ghost shadows')
    expect(p).toContain('Do not add any objects')
    expect(p).toContain('Do not change anything outside the highlighted areas')
  })

  it('mentions children when removing a parent object', () => {
    const p = buildEditPrompt({ action: 'remove', label: 'sofa', childLabels: ['throw pillow'] })
    expect(p).toContain('the highlighted sofa and the throw pillow resting on it')
    expect(() => buildEditPrompt({ action: 'explode', label: 'x' })).toThrow()
  })
})
