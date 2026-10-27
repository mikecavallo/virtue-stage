import { describeItems } from '../lib/geometry.js'

// Prompt library. Staging styles are ported from the original VirtueStage backend
// ("architecture-first" prompts): name exact pieces and materials per room, and
// spend most of the words on what must NOT change.

export const ROOM_TYPES = [
  { id: 'living-room', label: 'Living room' },
  { id: 'bedroom', label: 'Bedroom' },
  { id: 'kitchen', label: 'Kitchen' },
  { id: 'dining-room', label: 'Dining room' },
  { id: 'bathroom', label: 'Bathroom' },
  { id: 'office', label: 'Home office' },
]

export const STYLES = {
  modern: {
    label: 'Modern Organic',
    swatch: ['#efe6d8', '#c8a97e', '#3b3b3b'],
    materials: 'boucle fabric, natural oak, marble, brushed brass, linen, matte ceramic, warm ivory tones',
    seating: {
      'living-room': 'a low-profile cream boucle sectional sofa',
      bedroom: 'a modern platform bed with a warm gray linen upholstered headboard',
      kitchen: 'bar stools with slim metal legs and neutral cushioned seats at the island or counter',
      'dining-room': 'a rectangular light oak dining table with upholstered dining chairs',
      bathroom: 'a small wooden vanity stool',
      office: 'a white oak standing desk with an ergonomic mesh chair',
    },
    accents: {
      'living-room': 'a round marble coffee table, a large textured ivory area rug, and two cognac leather accent chairs',
      bedroom: 'floating walnut nightstands, a woven bench at the foot of the bed, and a plush wool rug',
      kitchen: 'a ceramic fruit bowl and a wooden cutting board on the counter',
      'dining-room': 'a statement pendant light over the table, a natural fiber rug, and a low sideboard',
      bathroom: 'neatly rolled white towels and a small tray with amber glass bottles',
      office: 'a slim bookshelf with curated objects and a brushed brass desk lamp',
    },
    decor: {
      'living-room': 'neutral throw pillows, a fiddle leaf fig in a white pot, and one large abstract artwork',
      bedroom: 'crisp white bedding with a textured throw, two ceramic table lamps, and neutral art prints',
      kitchen: 'a small herb trio on the windowsill and minimalist canisters',
      'dining-room': 'a simple greenery centerpiece and one piece of abstract wall art',
      bathroom: 'a small succulent and a candle in a glass jar',
      office: 'a desktop plant and one framed print',
    },
  },
  scandinavian: {
    label: 'Scandinavian',
    swatch: ['#f4f1ea', '#d9c4a3', '#9aa5a0'],
    materials: 'light birch, pale oak, chunky knit wool, sheepskin, white linen, soft gray cotton',
    seating: {
      'living-room': 'a light linen sofa in soft white or pale gray with rounded cushions',
      bedroom: 'a birch bed frame with an oatmeal upholstered headboard',
      kitchen: 'light wood spindle-back counter stools',
      'dining-room': 'a round white dining table with light wood wishbone chairs',
      bathroom: 'a small white wooden stool',
      office: 'a light wood desk with tapered legs and a chair draped with sheepskin',
    },
    accents: {
      'living-room': 'a round light wood coffee table, a knit throw on the sofa, and an ivory shag rug',
      bedroom: 'light wood nightstands, a chunky knit throw, and a sheepskin rug beside the bed',
      kitchen: 'white ceramic mugs and a wooden utensil holder',
      'dining-room': 'a pale wood pendant light and a linen table runner',
      bathroom: 'a wooden bath tray and a woven basket with rolled towels',
      office: 'a woven desk organizer and a small wool rug',
    },
    decor: {
      'living-room': 'white candles, a trailing pothos, and simple line-art prints',
      bedroom: 'layered white and cream bedding and simple botanical prints',
      kitchen: 'small potted herbs and white canisters',
      'dining-room': 'a candle centerpiece and fresh greenery',
      bathroom: 'a eucalyptus bundle and white candles',
      office: 'a few books and a small plant',
    },
  },
  minimalist: {
    label: 'Japandi Minimal',
    swatch: ['#e8e2d6', '#a39382', '#2f2f2f'],
    materials: 'light ash wood, natural linen, matte black steel, white ceramic, stone gray and earth tones',
    seating: {
      'living-room': 'one low-profile sofa in a muted earth tone with clean geometric lines',
      bedroom: 'a low natural wood platform bed',
      kitchen: 'two simple wooden stools',
      'dining-room': 'a simple round table with four clean-lined wooden chairs',
      bathroom: 'no seating',
      office: 'a minimal writing desk and a simple wooden chair',
    },
    accents: {
      'living-room': 'one low wooden coffee table and a single natural fiber rug',
      bedroom: 'one floating nightstand with a single lamp',
      kitchen: 'a single ceramic bowl on the counter',
      'dining-room': 'one simple pendant light',
      bathroom: 'a wooden bath mat',
      office: 'one small desk organizer',
    },
    decor: {
      'living-room': 'one large artwork and one architectural floor plant. No pillows or clutter.',
      bedroom: 'white bedding with no decorative pillows and one small plant',
      kitchen: 'one small plant on the windowsill',
      'dining-room': 'a single branch in a simple vase',
      bathroom: 'one plant and one folded white towel',
      office: 'one plant',
    },
  },
  traditional: {
    label: 'Transitional Classic',
    swatch: ['#e9dfcf', '#7a4b33', '#1f2a44'],
    materials: 'dark cherry and walnut wood, tufted velvet, Persian-style wool, polished brass, rich jewel tones',
    seating: {
      'living-room': 'a rolled-arm sofa in navy fabric with nailhead trim',
      bedroom: 'a dark cherry sleigh bed',
      kitchen: 'wooden counter stools with turned legs and upholstered seats',
      'dining-room': 'a mahogany dining table with upholstered chairs',
      bathroom: 'an upholstered vanity stool with carved legs',
      office: 'a leather executive chair and a solid wood pedestal desk',
    },
    accents: {
      'living-room': 'a carved wooden coffee table, a Persian-style rug, and two wingback chairs',
      bedroom: 'carved bedside tables, a tufted ottoman, and a warm-toned traditional rug',
      kitchen: 'a decorative fruit bowl and a small floral arrangement',
      'dining-room': 'a crystal chandelier, a patterned rug, and a china cabinet',
      bathroom: 'an ornate framed mirror and a decorative tray',
      office: 'a bookcase with leather-bound books and a brass desk lamp',
    },
    decor: {
      'living-room': 'damask throw pillows, pleated-shade table lamps, framed landscape paintings, and fresh flowers',
      bedroom: 'layered bedding with a quilted coverlet, framed botanical prints, and lined drapes',
      kitchen: 'potted herbs in ceramic planters',
      'dining-room': 'silver candlesticks and landscape paintings',
      bathroom: 'monogrammed towels and a small floral arrangement',
      office: 'a globe and framed maps',
    },
  },
  luxury: {
    label: 'Modern Luxury',
    swatch: ['#f2ead8', '#c9a227', '#14213d'],
    materials: 'marble, velvet, polished brass, smoked glass, lacquered wood, champagne tones',
    seating: {
      'living-room': 'a deep velvet sectional in emerald or navy',
      bedroom: 'an upholstered king bed with a tall tufted velvet headboard',
      kitchen: 'leather and polished chrome counter stools',
      'dining-room': 'a marble-top dining table with high-back velvet chairs',
      bathroom: 'a plush vanity bench with brass legs',
      office: 'a leather executive chair and a walnut desk with brass hardware',
    },
    accents: {
      'living-room': 'a marble coffee table with art books, brass side tables with designer lamps, and a plush patterned rug',
      bedroom: 'lacquered nightstands with brass accents, a velvet bench, and an oversized rug',
      kitchen: 'a marble fruit bowl and a brass kettle',
      'dining-room': 'a sculptural chandelier and a marble-topped sideboard',
      bathroom: 'a marble tray with designer toiletries and a brass-framed mirror',
      office: 'a statement bookshelf with curated objects and a premium rug',
    },
    decor: {
      'living-room': 'large statement artwork, an architectural floor lamp, a tall plant, and brass accents',
      bedroom: 'layered silk and linen bedding, crystal-base lamps, and large-scale art',
      kitchen: 'fresh flowers in a premium vase',
      'dining-room': 'a large floral centerpiece and statement wall art',
      bathroom: 'an orchid and neatly displayed towels',
      office: 'framed photography and a large floor plant',
    },
  },
  bohemian: {
    label: 'Boho Eclectic',
    swatch: ['#e8d3b9', '#b5653d', '#6b7d4f'],
    materials: 'rattan, macrame cotton, reclaimed wood, kilim wool, jute, terracotta, warm earth tones',
    seating: {
      'living-room': 'a deep linen sofa in terracotta or sage piled with mixed-pattern pillows',
      bedroom: 'a rattan bed frame with a woven cane headboard',
      kitchen: 'woven rattan counter stools',
      'dining-room': 'a reclaimed wood table with a bench on one side and eclectic chairs on the other',
      bathroom: 'a small rattan side table',
      office: 'a rattan chair beside a rustic wooden desk',
    },
    accents: {
      'living-room': 'a vintage wooden coffee table, layered kilim and jute rugs, and floor poufs',
      bedroom: 'mismatched nightstands, a warm textured throw, and layered rugs',
      kitchen: 'colorful ceramics and woven baskets',
      'dining-room': 'a rattan pendant light and a patterned table runner',
      bathroom: 'woven storage baskets and patterned towels',
      office: 'a woven wall hanging and layered textiles',
    },
    decor: {
      'living-room': 'plants at several heights, a macrame wall hanging, and an eclectic gallery wall',
      bedroom: 'hanging and potted plants and boho art',
      kitchen: 'a hanging herb garden',
      'dining-room': 'a wildflower centerpiece and candles',
      bathroom: 'trailing plants and a vintage mirror',
      office: 'trailing plants on shelves',
    },
  },
}

export const STYLE_IDS = Object.keys(STYLES)

const PRESERVE = [
  'Strictly preserve the property itself: walls and wall color, windows (count, size, position), doors, ceiling, light fixtures, built-in cabinets and counters, flooring, and the view outside the windows.',
  'Keep the exact same camera position, framing, perspective, lens, and image boundaries. Do not crop, zoom, rotate, or extend the photo.',
  'Every added piece must sit on the floor at a realistic scale for this room, respect walkways and door swings, and cast soft shadows consistent with the existing light.',
  'The result must look like an unedited professional real estate photograph, not a 3D render.',
].join('\n')

export function buildStagingPrompt({ style, roomType, isEmpty = true, issues = [] }) {
  const s = STYLES[style] || STYLES.modern
  const room = roomType && s.seating[roomType] ? roomType : 'living-room'
  const roomLabel = (ROOM_TYPES.find((r) => r.id === room)?.label || 'room').toLowerCase()
  const task = isEmpty
    ? `Virtually stage this empty ${roomLabel} in a ${s.label} style.`
    : `Restage this ${roomLabel} in a ${s.label} style: replace the existing furniture and decor with the pieces below.`
  const lines = [
    task,
    '',
    PRESERVE,
    '',
    `Material palette: ${s.materials}.`,
    `Main piece: ${s.seating[room]}.`,
    `Accents: ${s.accents[room]}.`,
    `Decor: ${s.decor[room]}.`,
  ]
  if (issues.length) {
    lines.push('', 'A previous attempt changed the architecture. Fix these problems this time:')
    for (const issue of issues.slice(0, 6)) lines.push(`- ${issue}`)
  }
  return lines.join('\n')
}

// Stage the room around furniture the seller keeps. The kept pieces are sent
// as reference crops and pasted back afterwards, so they stay pixel-identical.
export function buildMatchStagingPrompt({ roomType, keepLabels, issues = [] }) {
  const roomLabel = (ROOM_TYPES.find((r) => r.id === roomType)?.label || 'room').toLowerCase()
  const keep = describeItems(keepLabels)
  const many = keepLabels.length > 1
  const lines = [
    `Virtually stage this ${roomLabel} around the furniture already in it: the ${keep}. ${many ? 'They are' : 'It is'} also shown on ${many ? 'their own' : 'its own'} in the reference image${many ? 's' : ''} after the room photo.`,
    `Keep the ${keep} exactly as photographed, in the same position, fully visible and not blocked by anything new.`,
    `Add the rest of the furniture and decor this room needs, chosen to match the ${keep}: same design style and era, compatible materials and finishes, and a color palette built around ${many ? 'them' : 'it'}, so the room looks designed around ${many ? 'these pieces' : 'this piece'}.`,
    '',
    PRESERVE,
  ]
  if (issues.length) {
    lines.push('', 'A previous attempt changed the architecture. Fix these problems this time:')
    for (const issue of issues.slice(0, 6)) lines.push(`- ${issue}`)
  }
  return lines.join('\n')
}

const EDIT_RULES =
  'Keep every other pixel identical: same framing, camera angle, perspective, lighting, and colors. Do not add, move, or remove anything else. Return only the edited Image 1, with no magenta highlight.'

// `labels` lets one call remove several objects (multi-select).
export function buildEditPrompt({ action, label, labels, childLabels = [], instruction = '' }) {
  const names = labels?.length ? labels : [label]
  const many = names.length > 1
  const what = `the highlighted ${describeItems(names)}`
  const target = childLabels.length ? `${what} and the ${describeItems(childLabels)} resting on ${many ? 'them' : 'it'}` : what
  const preamble = `You are a professional real estate photo retoucher. Image 1 is the photo to edit. Image 2 is the same photo with ${many ? 'the objects to remove' : 'one object'} highlighted in magenta.`
  let task
  if (action === 'remove') {
    task = `Remove ${target} from Image 1. Fill the space with what would naturally be behind ${many ? 'them' : 'it'}, continuing the existing floor, walls, baseboards, and light. Remove ${many ? 'their shadows and reflections' : 'its shadow and any reflection'} too. Do not put anything new in ${many ? 'their' : 'its'} place. Leave no trace: no ghost shadows, dark smudges, faint outlines, seams, or blurry patches; match the surrounding grain, sharpness, and exposure so the area looks professionally photographed.`
  } else if (action === 'replace') {
    task = `Replace ${target} with ${instruction || 'a modern alternative'}. Match the room's perspective, scale, lighting, and shadows so it looks photographed in place. Keep it in the same position and roughly the same footprint.`
  } else if (action === 'restyle') {
    task = `Change only the material, color, or finish of the highlighted ${label}: ${instruction || 'make it look new'}. Keep its exact shape, size, and position.`
  } else {
    throw new Error(`Unknown edit action: ${action}`)
  }
  return `${preamble}\n\n${task}\n\n${EDIT_RULES}`
}

// Cleanup pass after removals/replacements. Paired with a mask, so the model's
// output is only used in (and just around) the areas that were edited.
export function buildPolishPrompt() {
  return [
    'You are a professional real estate photo retoucher. Image 1 is the photo to fix. Image 2 is the same photo with the retouched areas highlighted in magenta.',
    '',
    'Furniture was digitally removed or changed in the highlighted areas, and the edit left defects: leftover or ghost shadows, dark smudges and blotches, faint outlines of the old objects, blurry or smeared patches, repeated textures, and visible seams.',
    'Clean up those areas so the photo looks untouched and professionally shot: continue the surrounding floor, rug, walls, baseboards, outlets, and light naturally, matching the existing grain, sharpness, and exposure.',
    '',
    'Do not add any objects or furniture. Do not change anything outside the highlighted areas: same framing, perspective, colors, and lighting. Return only the cleaned Image 1, with no magenta.',
  ].join('\n')
}

export const ROOM_DETECT_PROMPT = `Classify this real estate photo.
Return JSON with:
- roomType: one of ${ROOM_TYPES.map((r) => r.id).join(', ')} (pick the closest)
- isEmpty: true if the room has no movable furniture
- confidence: 0 to 1
- summary: one short sentence describing the room's architecture (flooring, windows, notable features)`

export const ROOM_DETECT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    roomType: { type: 'STRING', enum: ROOM_TYPES.map((r) => r.id) },
    isEmpty: { type: 'BOOLEAN' },
    confidence: { type: 'NUMBER' },
    summary: { type: 'STRING' },
  },
  required: ['roomType', 'isEmpty', 'confidence', 'summary'],
}

export const SEGMENT_PROMPT = `Segment the movable furniture and decor in this real estate photo: sofas, chairs, tables, beds, nightstands, dressers, desks, stools, benches, rugs, lamps, plants, throw pillows, wall art, mirrors, vases, towels, and small decor.
Do NOT include architecture or fixtures: walls, windows, doors, ceiling lights, fireplaces, cabinets, countertops, kitchen islands, appliances, sinks, toilets, tubs, built-in shelving, railings, flooring, or anything seen through a window.
Output a JSON list (at most 15 items). Each entry has "box_2d" as [ymin, xmin, ymax, xmax] normalized to 0-1000, "mask" as a polygon of [x, y] points normalized to 0-1000 that traces the object's outline, and "label" as a short lowercase name like "armchair" or "throw pillow".`

export const SEGMENT_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      box_2d: { type: 'ARRAY', items: { type: 'INTEGER' } },
      mask: { type: 'ARRAY', items: { type: 'ARRAY', items: { type: 'INTEGER' } } },
      label: { type: 'STRING' },
    },
    required: ['box_2d', 'mask', 'label'],
  },
}

export const STRUCTURE_CHECK_PROMPT = `Image A is an original real estate photo. Image B is an AI-staged version of it.
Listing rules forbid changing the property itself. Compare ONLY the permanent architecture: walls and wall color, windows (count, size, position), doors, ceiling, built-in fixtures and cabinets, flooring material, room shape, camera framing, and the view outside.
Ignore furniture, rugs, decor, and lamps that were added, removed, or changed.
Return JSON: {"preserved": true|false, "issues": ["short description of each architectural change"]}. Use an empty list when nothing changed.`

export const STRUCTURE_CHECK_SCHEMA = {
  type: 'OBJECT',
  properties: {
    preserved: { type: 'BOOLEAN' },
    issues: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['preserved', 'issues'],
}
