// Live smoke test against the real Gemini API, using the same task functions
// the browser uses. Costs a few cents.
//
//   GEMINI_API_KEY=... npm run smoke:live            # detect + segment only
//   GEMINI_API_KEY=... npm run smoke:live -- --edit  # also one image edit (~$0.05)
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { detectRoom, segmentObjects, generateImage } from '../src/ai/tasks.js'
import { buildEditPrompt } from '../src/ai/prompts.js'
import { MODELS } from '../src/ai/gemini.js'

const apiKey = process.env.GEMINI_API_KEY
if (!apiKey) {
  console.error('Set GEMINI_API_KEY first.')
  process.exit(1)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const samplePath = path.join(here, '..', 'public', 'samples', process.argv.find((a) => a.startsWith('--sample='))?.slice(9) || 'living-room', 'original.jpg')
const image = { data: (await readFile(samplePath)).toString('base64'), mimeType: 'image/jpeg' }

const time = async (label, fn) => {
  const t = Date.now()
  const out = await fn()
  console.log(`✓ ${label} (${((Date.now() - t) / 1000).toFixed(1)}s)`)
  return out
}

const room = await time(`detectRoom with ${MODELS.vision}`, () => detectRoom({ apiKey, model: MODELS.vision, image }))
console.log('  ', room)

const objects = await time(`segmentObjects with ${MODELS.vision}`, () => segmentObjects({ apiKey, model: MODELS.vision, image }))
for (const o of objects) console.log(`   ${o.id.padEnd(20)} ${o.mask.length} pts  children: ${o.children.join(', ') || '-'}`)

if (process.argv.includes('--edit') && objects.length) {
  const target = objects[0]
  const out = await time(`generateImage (remove ${target.label}) with ${MODELS.image}`, () =>
    generateImage({ apiKey, model: MODELS.image, prompt: buildEditPrompt({ action: 'remove', label: target.label }), images: [image], aspectRatio: '3:2', imageSize: '1K' }),
  )
  const file = path.join(process.env.TMPDIR || '/tmp', `virtuestage-smoke.${out.mimeType.split('/')[1] || 'png'}`)
  await writeFile(file, Buffer.from(out.data, 'base64'))
  console.log(`   wrote ${file}`)
}
