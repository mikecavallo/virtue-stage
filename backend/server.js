const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');

const app = express();
const PORT = process.env.PORT || 3099;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET && process.env.NODE_ENV !== 'test') {
  console.warn('JWT_SECRET not set: using a random secret, so sessions reset on every restart.');
}
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const ENGINE_DIR = path.join(__dirname, '..', 'engine');
const PYTHON = process.env.PYTHON_BIN || 'python3';

// STAGING_MODE=demo skips the Python/Gemini engine and returns a bundled sample
// image, so the whole app can be run and tested without an API key.
const STAGING_MODE = (process.env.STAGING_MODE || 'gemini').toLowerCase() === 'demo' ? 'demo' : 'gemini';
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-flash';
const MODEL_LABEL = STAGING_MODE === 'demo' ? 'demo-sample' : GEMINI_IMAGE_MODEL;
const DEMO_SAMPLE_DIRS = [
  process.env.DEMO_SAMPLES_DIR,
  path.join(__dirname, 'public', 'images', 'after'),
  path.join(__dirname, '..', 'website', 'public', 'images', 'after'),
].filter(Boolean);
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const RESULTS_DIR = path.join(DATA_DIR, 'results');
const THUMBS_DIR = path.join(DATA_DIR, 'thumbnails');

// Ensure directories
[DATA_DIR, UPLOADS_DIR, RESULTS_DIR, THUMBS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

app.use(cors());
app.use(express.json());

// ─── Database ───
const db = new Database(path.join(DATA_DIR, 'virtuestage.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    credits INTEGER NOT NULL DEFAULT 3,
    plan TEXT NOT NULL DEFAULT 'free',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'processing',
    style TEXT NOT NULL,
    room_type TEXT NOT NULL,
    original_path TEXT,
    result_path TEXT,
    thumbnail_path TEXT,
    original_thumbnail_path TEXT,
    error TEXT,
    generation_time REAL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id);

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT,
    style TEXT NOT NULL,
    room_type TEXT NOT NULL,
    hero_job_id TEXT,
    status TEXT NOT NULL DEFAULT 'staging_hero',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
`);

// Migration: add columns if missing
try { db.exec('ALTER TABLE jobs ADD COLUMN project_id TEXT REFERENCES projects(id)'); } catch {}
try { db.exec('ALTER TABLE jobs ADD COLUMN is_hero INTEGER NOT NULL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE jobs ADD COLUMN auto_detected INTEGER NOT NULL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN credits INTEGER NOT NULL DEFAULT 3'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT \'free\''); } catch {}
try { db.exec('ALTER TABLE jobs ADD COLUMN thumbnail_path TEXT'); } catch {}
try { db.exec('ALTER TABLE jobs ADD COLUMN original_thumbnail_path TEXT'); } catch {}

// ─── Thumbnail helper ───
async function generateThumbnail(inputPath, userId, prefix) {
  const thumbDir = path.join(THUMBS_DIR, userId);
  fs.mkdirSync(thumbDir, { recursive: true });
  const thumbName = `${prefix}_thumb.jpg`;
  const thumbPath = path.join(thumbDir, thumbName);
  try {
    await sharp(inputPath)
      .resize(400, 300, { fit: 'cover' })
      .jpeg({ quality: 75 })
      .toFile(thumbPath);
    return thumbName;
  } catch (e) {
    console.error('Thumbnail generation failed:', e.message);
    return null;
  }
}

// ─── Auth helpers ───
function generateToken(user) {
  return jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    req.user = db.prepare('SELECT id, email, name, credits, plan FROM users WHERE id = ?').get(payload.id);
    if (!req.user) return res.status(401).json({ error: 'User not found' });
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// <img> tags cannot send an Authorization header, so image URLs carry a
// short-lived, image-only token in the query string (?t=...).
function imageToken(userId) {
  return jwt.sign({ id: userId, scope: 'img' }, JWT_SECRET, { expiresIn: '1h' });
}

function imageUrl(kind, userId, filename, token) {
  return `/api/staging/${kind}/${userId}/${encodeURIComponent(filename)}?t=${token}`;
}

function imageAuthMiddleware(req, res, next) {
  if (req.headers.authorization) return authMiddleware(req, res, next);
  try {
    const payload = jwt.verify(String(req.query.t || ''), JWT_SECRET);
    if (payload.scope !== 'img') throw new Error('wrong scope');
    req.user = { id: payload.id };
    next();
  } catch {
    res.status(401).json({ error: 'Not authenticated' });
  }
}

// ─── Rate limiting: max 3 concurrent jobs per user ───
// Credits not already committed to in-flight jobs (credits are deducted on completion)
function availableCredits(user) {
  return user.credits - checkConcurrentJobs(user.id);
}

function checkConcurrentJobs(userId) {
  const count = db.prepare("SELECT COUNT(*) as c FROM jobs WHERE user_id = ? AND status = 'processing'").get(userId);
  return count.c;
}

// ─── Auth routes ───
app.post('/api/auth/signup', (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (!email.includes('@')) return res.status(400).json({ error: 'Invalid email' });

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const id = crypto.randomUUID();
  const password_hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (id, email, name, password_hash, credits) VALUES (?, ?, ?, ?, 3)').run(id, email, name || email.split('@')[0], password_hash);

  fs.mkdirSync(path.join(UPLOADS_DIR, id), { recursive: true });
  fs.mkdirSync(path.join(RESULTS_DIR, id), { recursive: true });

  const user = { id, email, name: name || email.split('@')[0], credits: 3, plan: 'free' };
  res.json({ token: generateToken(user), user });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const user = { id: row.id, email: row.email, name: row.name, credits: row.credits, plan: row.plan };
  res.json({ token: generateToken(user), user });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// ─── Credits ───
app.get('/api/credits', authMiddleware, (req, res) => {
  res.json({ credits: req.user.credits, plan: req.user.plan });
});

// ─── Health ───
app.get('/api/health', (req, res) => res.json({ status: 'ok', stagingMode: STAGING_MODE }));

// ─── Staging prompts (product IP — architecture-first approach) ───

const STYLE_CONFIG = {
  modern: {
    label: 'Modern Organic',
    materials: 'boucle fabric, natural oak wood, marble, brushed brass, linen, concrete, matte ceramic, warm ivory tones',
    seating: {
      'living-room': 'A low-profile, cream boucle sectional sofa as the primary seating element',
      'bedroom': 'A modern platform bed with a clean upholstered headboard in warm gray linen',
      'kitchen': 'Modern bar stools with slim metal legs and neutral cushioned seats at the island or counter',
      'dining-room': 'A sleek rectangular dining table in light oak with modern upholstered dining chairs',
      'bathroom': 'A modern wooden vanity stool or small accent bench',
      'office': 'An ergonomic office chair in mesh and chrome with a minimalist standing desk in white oak',
    },
    accents: {
      'living-room': 'A circular marble coffee table, a large textured area rug in warm ivory, and two accent chairs in cognac leather',
      'bedroom': 'Matching floating nightstands in light walnut, a soft woven bench at the foot of the bed, and a plush wool area rug',
      'kitchen': 'A ceramic fruit bowl on the counter, a simple wooden cutting board propped against the backsplash, and a small herb arrangement',
      'dining-room': 'A statement pendant light over the table, a natural fiber area rug underneath, and a simple sideboard or buffet against the wall',
      'bathroom': 'Neatly rolled white towels, a small tray with curated bottles, and a round mirror if none exists',
      'office': 'A slim bookshelf with curated objects, a desk lamp in brushed brass, and a small area rug under the desk',
    },
    decor: {
      'living-room': 'Minimalist books on any shelves, soft neutral throw pillows, a large statement floor plant like a fiddle leaf fig, and subtle brass accents',
      'bedroom': 'Crisp white bedding with a textured throw blanket, one or two neutral art prints on the wall, soft ambient table lamps, and a potted plant on one nightstand',
      'kitchen': 'A small potted herb garden on the windowsill, minimalist canisters, and a tasteful cookbook or two',
      'dining-room': 'A simple centerpiece arrangement with greenery, linen napkins at each setting, and one piece of abstract wall art',
      'bathroom': 'A small potted succulent, a scented candle in a glass jar, and a neat stack of folded hand towels',
      'office': 'A small desktop plant, a few organized books, and one piece of inspirational wall art',
    },
  },
  traditional: {
    label: 'Transitional Classic',
    materials: 'dark cherry wood, mahogany, silk damask, Persian wool, polished brass, tufted velvet, rich jewel tones, antique gold',
    seating: {
      'living-room': 'A classic rolled-arm sofa in rich navy or charcoal fabric with nailhead trim',
      'bedroom': 'A traditional sleigh bed or four-poster bed in dark cherry wood',
      'kitchen': 'Traditional wooden counter stools with turned legs and upholstered seats',
      'dining-room': 'A formal mahogany dining table with Queen Anne-style upholstered chairs',
      'bathroom': 'An upholstered vanity stool with carved wooden legs',
      'office': 'A traditional leather executive chair with a solid wood pedestal desk',
    },
    accents: {
      'living-room': 'An ornate wooden coffee table, a richly patterned Persian-style area rug, and two wingback accent chairs',
      'bedroom': 'Elegant bedside tables with carved details, a tufted ottoman at the foot of the bed, and a traditional area rug in warm tones',
      'kitchen': 'A decorative fruit bowl, traditional canisters, and a small floral arrangement',
      'dining-room': 'A crystal chandelier over the table, a patterned area rug, and a traditional china cabinet or hutch',
      'bathroom': 'An ornate framed mirror, a small antique-style side table, and a decorative tray with elegant bottles',
      'office': 'A traditional bookcase filled with leather-bound books, a brass desk lamp, and a richly patterned rug',
    },
    decor: {
      'living-room': 'Silk throw pillows with damask patterns, classic table lamps with pleated shades, framed landscape paintings, and a vase of fresh flowers',
      'bedroom': 'Layered bedding with a quilted coverlet and decorative shams, classic wall sconces, framed botanical prints, and heavy drapes framing the windows',
      'kitchen': 'A traditional clock on the wall, potted herbs in ceramic planters, and a small cookbook collection',
      'dining-room': 'Fine china place settings, silver candlesticks as a centerpiece, and traditional landscape paintings',
      'bathroom': 'Monogrammed towels, a small floral arrangement, and classic framed artwork',
      'office': 'A globe on the desk, framed diplomas or maps on the wall, and a traditional desk set',
    },
  },
  minimalist: {
    label: 'Japandi Minimalist',
    materials: 'light ash wood, natural linen, raw concrete, matte black steel, white ceramic, washi paper, stone gray, earth tones',
    seating: {
      'living-room': 'A single low-profile sofa in muted earth tones with clean geometric lines',
      'bedroom': 'A simple low platform bed frame in natural light wood with a thin mattress profile',
      'kitchen': 'One or two simple wooden stools, nothing more',
      'dining-room': 'A simple round dining table with two to four clean-lined wooden chairs',
      'bathroom': 'No seating — keep it completely spare',
      'office': 'A simple wooden chair with a minimal writing desk',
    },
    accents: {
      'living-room': 'One small, low wooden coffee table and a single natural fiber floor rug — nothing else',
      'bedroom': 'One floating nightstand only, with nothing on it except a single lamp',
      'kitchen': 'A single ceramic bowl on the counter — extreme restraint',
      'dining-room': 'One simple pendant light and nothing else — let the room breathe',
      'bathroom': 'A single wooden bath mat and one small tray with essentials',
      'office': 'One small desk organizer — extreme restraint',
    },
    decor: {
      'living-room': 'One single large-scale art piece on the wall and one architectural floor plant. No pillows, no throws, no books. Emptiness is the design.',
      'bedroom': 'Crisp white bedding with zero decorative pillows. One small plant. One piece of wall art. Nothing more.',
      'kitchen': 'One small plant on the windowsill. That is all.',
      'dining-room': 'A single branch or stem in a simple vase as a centerpiece. Nothing more.',
      'bathroom': 'One small plant and perfectly folded single white towel. Nothing more.',
      'office': 'One plant and one pen. That is all.',
    },
  },
  scandinavian: {
    label: 'Scandinavian Hygge',
    materials: 'light birch wood, pale oak, chunky knit wool, sheepskin, white linen, matte white ceramic, soft gray cotton, natural fiber',
    seating: {
      'living-room': 'A light-colored linen sofa in soft white or pale gray with rounded cushions',
      'bedroom': 'A birch wood bed frame with a high headboard upholstered in light oatmeal fabric',
      'kitchen': 'Light wood counter stools with simple spindle backs in white or natural birch',
      'dining-room': 'A round white-top dining table with light wood legs and matching wishbone chairs',
      'bathroom': 'A small white wooden stool',
      'office': 'A light wood desk with tapered legs and a cozy sheepskin-draped chair',
    },
    accents: {
      'living-room': 'A round light wood coffee table, a cozy knit throw blanket draped over the sofa, sheepskin accent on one chair, and a soft shag rug in ivory',
      'bedroom': 'Light wood nightstands, a chunky knit throw at the foot of the bed, a soft sheepskin rug beside the bed, and a woven basket for blankets',
      'kitchen': 'Wooden utensil holders, white ceramic mugs on open shelving, and a small bread basket',
      'dining-room': 'A simple pendant light in white or pale wood, linen table runner, and a small candle arrangement',
      'bathroom': 'A wooden bath tray, woven basket with rolled towels, and natural soap dish',
      'office': 'A woven desk organizer, a small wool rug, and a wooden shelf with curated objects',
    },
    decor: {
      'living-room': 'White candles in simple holders, one or two trailing plants like pothos, simple line-art prints on the wall, and soft ambient lighting',
      'bedroom': 'Soft layered white and cream bedding, battery-powered fairy lights on the nightstand, simple botanical prints, and a trailing plant on the windowsill',
      'kitchen': 'Small potted herbs, a few white canisters, and a simple print or wooden cutting board as wall decor',
      'dining-room': 'A simple candle centerpiece, one piece of minimal wall art, and fresh greenery',
      'bathroom': 'A small eucalyptus bundle, white candles, and one simple piece of wall art',
      'office': 'A few books with minimal covers, a small plant, and a simple clock',
    },
  },
  luxury: {
    label: 'Transitional Luxury',
    materials: 'Italian marble, velvet, polished gold, crystal, lacquered wood, silk, premium leather, onyx, champagne tones, brushed nickel',
    seating: {
      'living-room': 'A large, deep-seated velvet sectional in rich emerald or navy, or a tufted Chesterfield sofa in premium leather',
      'bedroom': 'An oversized upholstered king bed with a tall, deeply tufted velvet headboard in charcoal or champagne',
      'kitchen': 'Premium leather and polished chrome counter stools with waterfall edges',
      'dining-room': 'An extendable marble-top dining table with high-back upholstered chairs in velvet or premium leather',
      'bathroom': 'A plush upholstered vanity bench with chrome or gold legs',
      'office': 'A premium leather executive chair with a large walnut executive desk with gold hardware',
    },
    accents: {
      'living-room': 'A large marble or glass coffee table with decorative art books, elegant side tables with designer lamps in brushed gold, a plush area rug in a rich pattern, and matching ottomans',
      'bedroom': 'Mirrored or lacquered nightstands with gold accents, a plush velvet bench at the foot of the bed, an oversized area rug, and a decorative room screen or mirror',
      'kitchen': 'A marble fruit bowl, premium knife block, designer kettle in brushed gold, and a wine rack or bar cart nearby',
      'dining-room': 'A dramatic crystal or modern sculptural chandelier, a large statement mirror on one wall, and a marble-topped sideboard with gold accents',
      'bathroom': 'A marble tray with designer toiletries, a large framed mirror with gold trim, plush white bathrobes on hooks, and a small crystal vase',
      'office': 'A marble and gold desk organizer, a statement bookshelf with curated objects d\'art, and a premium area rug',
    },
    decor: {
      'living-room': 'Large-scale statement artwork, a curated collection of art books, tall architectural floor lamps, a statement floor plant, and metallic accent pieces in gold or brass',
      'bedroom': 'Layered premium bedding with silk or satin pillows, dramatic table lamps with crystal bases, large-scale wall art, heavy lined drapes, and a statement floral arrangement',
      'kitchen': 'Fresh flowers in a premium vase, a cookbook collection by notable chefs, and artisanal accessories',
      'dining-room': 'Fine china and crystal glassware at each place setting, silver candlesticks, a large floral centerpiece, and statement wall art',
      'bathroom': 'Premium towels perfectly displayed, a large orchid arrangement, designer candles, and a stack of high-end magazines',
      'office': 'A globe or telescope as a statement piece, premium framed photography, a crystal decanter set, and a large floor plant',
    },
  },
  bohemian: {
    label: 'Bohemian Eclectic',
    materials: 'rattan, macrame cotton, reclaimed wood, kilim wool, jute, terracotta ceramic, woven seagrass, aged leather, warm earth tones',
    seating: {
      'living-room': 'A deep, comfortable linen sofa in warm terracotta or sage green, piled with mixed-pattern throw pillows',
      'bedroom': 'A rattan or reclaimed wood bed frame with a woven cane headboard',
      'kitchen': 'Mismatched vintage-style wooden stools or woven rattan counter seats',
      'dining-room': 'A rustic reclaimed wood dining table with mixed seating — a bench on one side, eclectic chairs on the other',
      'bathroom': 'A vintage wooden stool or a small rattan side table',
      'office': 'A vintage rattan peacock chair or a comfortable pouf next to a rustic wooden desk',
    },
    accents: {
      'living-room': 'A vintage wooden coffee table, layered rugs in kilim and jute patterns, a macrame wall hanging, and a collection of floor cushions and poufs',
      'bedroom': 'Mismatched nightstands (one vintage, one woven), a textured throw blanket in warm tones, layered rugs beside the bed, and a hanging planter',
      'kitchen': 'Open shelving with colorful ceramics, a collection of spice jars, and woven baskets for storage',
      'dining-room': 'A rattan pendant light, a patterned table runner, mixed ceramic plates, and wall-mounted woven baskets as art',
      'bathroom': 'Woven baskets for storage, a macrame plant hanger, and patterned towels',
      'office': 'A woven wall hanging, a collection of vintage objects, and layered textiles',
    },
    decor: {
      'living-room': 'An abundance of plants at various heights (hanging, floor, shelf), gallery wall with eclectic mix of art and mirrors, string lights, candles, and stacks of well-loved books',
      'bedroom': 'Lots of plants (hanging and potted), a gallery wall with boho art and tapestries, fairy lights, candles on the nightstand, and a dream catcher or wind chime',
      'kitchen': 'Hanging herb garden, colorful tiles or tapestry as backsplash accent, lots of plants, and vintage kitchen tools on display',
      'dining-room': 'A wildflower centerpiece in a vintage vase, candles at various heights, hanging plants, and eclectic wall art',
      'bathroom': 'Lots of trailing plants, patterned towels, a vintage mirror, and candles',
      'office': 'Trailing plants on shelves, an eclectic gallery wall, candles, and stacked vintage books',
    },
  },
};

function buildStagingPrompt(style, roomType) {
  const config = STYLE_CONFIG[style];
  if (!config) {
    return `Perform a high-end virtual staging on this empty ${roomType.replace(/-/g, ' ')} with ${style} style furniture. Maintain architectural integrity. The result must look like a professional real estate photograph.`;
  }

  const room = roomType || 'living-room';
  const seating = config.seating[room] || config.seating['living-room'];
  const accents = config.accents[room] || config.accents['living-room'];
  const decor = config.decor[room] || config.decor['living-room'];

  const manifest = buildFurnitureManifest(style, roomType);

  return [
    `Perform a high-end virtual staging on the provided image.`,
    `Strictly maintain the original architectural integrity of the room, including the flooring, wall colors, ceiling structure, windows, and light fixtures.`,
    `Do not alter the layout or dimensions of the space.`,
    ``,
    `Task: Fill the empty space with ${config.label} furniture.`,
    `Material Palette: All furniture and decor should use these materials: ${config.materials}.`,
    ``,
    `Specific Elements to Add:`,
    `Primary Seating: ${seating}.`,
    `Accents: ${accents}.`,
    `Decor: ${decor}.`,
    manifest,
    ``,
    `Lighting & Shadows: Ensure all added furniture pieces cast realistic shadows based on the existing light sources in the photo.`,
    `The final result must look like a professional real estate photograph, emphasizing a clean, airy, and high-end aesthetic.`,
  ].filter(Boolean).join('\n');
}

// ─── Furniture DNA Manifest ───
// Rigid item descriptions that force consistency across multiple angles.
// Every prompt for the same project gets the identical manifest appended.

const FURNITURE_DNA = {
  modern: {
    'living-room': {
      'Sofa': '3-seater, cream boucle fabric, low-profile with square cushions, tapered matte black metal legs',
      'Coffee Table': 'Round, white Carrara marble top, brushed brass cross-base, 36-inch diameter',
      'Accent Chair': 'Cognac leather with slim oak arms, mid-century silhouette, angled tapered legs',
      'Area Rug': 'High-pile wool, warm ivory, 8x10 feet, no border or pattern',
      'Floor Lamp': 'Arched brass floor lamp, linen drum shade, matte black marble base',
      'Plant': 'Large fiddle leaf fig in matte white ceramic pot, 5-6 feet tall',
      'Wall Art': 'Single large-scale abstract piece, earth tones, thin natural oak frame',
    },
    'bedroom': {
      'Bed': 'King platform bed, warm gray linen upholstered headboard, low walnut wood frame',
      'Nightstands': 'Pair of floating walnut nightstands, single drawer each, brass pulls',
      'Table Lamps': 'Pair of ceramic cylinder lamps, cream shade, brushed brass base',
      'Bench': 'Upholstered bench in oatmeal linen, walnut tapered legs, at foot of bed',
      'Area Rug': 'Soft woven wool rug, warm ivory, 8x10, placed under bed',
      'Throw': 'Textured cream throw blanket, casually draped on bed corner',
      'Plant': 'Small pothos in terracotta pot on one nightstand',
    },
    'kitchen': {
      'Bar Stools': '2-3 counter stools, slim matte black metal legs, natural linen cushioned seats',
      'Counter Decor': 'Ceramic fruit bowl in matte white, single wooden cutting board propped on counter',
      'Herbs': 'Small herb trio in white ceramic pots on windowsill',
      'Pendant': 'Brushed brass pendant light over island, frosted glass globe',
    },
    'dining-room': {
      'Table': 'Rectangular dining table, light oak top, matte black steel legs, seats 6',
      'Chairs': '6 modern dining chairs, cream boucle upholstered seat, light oak frame',
      'Pendant': 'Linear brass chandelier, 3 frosted glass globes, centered over table',
      'Rug': 'Natural jute area rug, 8x10, under table',
      'Centerpiece': 'Simple clear glass vase with single eucalyptus branch',
    },
    'bathroom': {
      'Towels': 'Neatly rolled white Turkish cotton towels on open shelf',
      'Tray': 'Small marble vanity tray with curated amber glass bottles',
      'Plant': 'Small succulent in white ceramic pot on counter',
      'Stool': 'Minimal teak shower stool, slatted top',
    },
    'office': {
      'Desk': 'Standing desk in white oak, clean lines, cable management tray',
      'Chair': 'Ergonomic mesh chair, chrome base, breathable gray mesh back',
      'Shelf': 'Single floating walnut shelf with 3-5 curated books and one small plant',
      'Lamp': 'Brushed brass desk lamp, adjustable arm, matte black shade',
      'Rug': 'Small natural fiber rug, 5x7, under desk area',
    },
  },
  luxury: {
    'living-room': {
      'Sofa': 'Large deep-seated velvet sectional in emerald green, tufted back, polished gold legs',
      'Coffee Table': 'Large rectangular white Carrara marble top, polished gold geometric base',
      'Side Tables': 'Pair of round mirrored side tables with gold trim, one on each end of sofa',
      'Accent Chairs': 'Two tufted velvet armchairs in champagne, gold capped legs',
      'Area Rug': 'Oversized plush rug in subtle geometric pattern, cream and gold, 10x12 feet',
      'Floor Lamp': 'Tall crystal and gold floor lamp with silk shade, positioned behind accent chair',
      'Art': 'Large-scale statement piece, gold and navy abstract, ornate gold frame',
      'Coffee Table Books': '3-4 oversized art and design books, stacked',
      'Plant': 'Tall bird of paradise in hammered gold planter',
    },
    'bedroom': {
      'Bed': 'Oversized king bed, deeply tufted velvet headboard in champagne, gold nail-head trim',
      'Nightstands': 'Pair of mirrored nightstands with gold hardware, two drawers each',
      'Table Lamps': 'Crystal base table lamps with pleated silk shades, one per nightstand',
      'Bench': 'Tufted velvet bench in navy, polished gold legs, at foot of bed',
      'Area Rug': 'Plush ivory rug with subtle gold thread pattern, extends beyond bed frame',
      'Bedding': 'Layered white and champagne silk bedding, multiple decorative pillows, cashmere throw',
      'Drapes': 'Floor-length lined silk drapes in champagne, gold curtain rod',
      'Art': 'Pair of large framed botanical prints in gold frames, above nightstands',
    },
    'dining-room': {
      'Table': 'Extendable marble-top dining table, polished gold pedestal base, seats 8',
      'Chairs': '8 high-back velvet dining chairs in navy, gold legs with capped feet',
      'Chandelier': 'Dramatic crystal chandelier, multi-tier, gold frame, centered over table',
      'Sideboard': 'Lacquered navy sideboard with gold hardware, decorative objects on top',
      'Mirror': 'Oversized round mirror with gold sunburst frame on main wall',
      'Place Settings': 'Fine bone china, crystal glassware, gold flatware at each setting',
      'Centerpiece': 'Low arrangement of white roses and peonies in gold vessel',
    },
  },
  traditional: {
    'living-room': {
      'Sofa': 'Classic rolled-arm sofa in navy velvet, nailhead trim, turned dark wood legs',
      'Coffee Table': 'Rectangular dark cherry wood coffee table, carved cabriole legs, glass top',
      'Wingback Chairs': 'Two wingback chairs in tufted burgundy leather, matching dark wood legs',
      'Area Rug': 'Large Persian-style wool rug, traditional medallion pattern, reds and navy, 8x10',
      'Table Lamps': 'Pair of brass table lamps with pleated cream shades on cherry side tables',
      'Art': '2-3 framed landscape oil paintings in ornate gold frames',
      'Flowers': 'Large arrangement of fresh roses in a crystal vase on coffee table',
      'Pillows': 'Silk damask throw pillows in burgundy and gold',
    },
    'bedroom': {
      'Bed': 'Four-poster bed in dark cherry wood, queen or king, with carved finials',
      'Nightstands': 'Matching cherry nightstands with carved drawer fronts, brass pulls',
      'Table Lamps': 'Brass candlestick lamps with cream pleated shades',
      'Ottoman': 'Tufted oval ottoman in navy velvet at foot of bed',
      'Area Rug': 'Traditional wool rug in warm burgundy and cream, 8x10',
      'Bedding': 'Quilted ivory coverlet, decorative shams in damask pattern, bed skirt',
      'Drapes': 'Heavy lined drapes in navy, brass curtain rod with finials',
      'Art': 'Pair of framed botanical prints in gold leaf frames',
    },
  },
  minimalist: {
    'living-room': {
      'Sofa': 'Single low-profile sofa in muted taupe, clean geometric lines, light ash wood legs',
      'Coffee Table': 'Small round light ash wood coffee table, 24-inch diameter, no shelf',
      'Rug': 'Flat-weave natural fiber rug in warm sand, 6x8, no pattern',
      'Art': 'One large-scale minimal line drawing, thin black frame, centered on main wall',
      'Plant': 'Single architectural plant (snake plant) in matte gray ceramic pot',
    },
    'bedroom': {
      'Bed': 'Low platform bed in light ash wood, no headboard visible, thin mattress profile',
      'Nightstand': 'One single floating ash nightstand, no hardware',
      'Lamp': 'One paper lantern-style pendant or simple ceramic table lamp',
      'Bedding': 'Crisp white linen duvet, single white linen pillow per side, no decorative pillows',
      'Plant': 'One small green plant in simple clay pot on nightstand',
    },
  },
  scandinavian: {
    'living-room': {
      'Sofa': '3-seater sofa in soft white linen, rounded cushions, birch wood legs',
      'Coffee Table': 'Round coffee table, light birch top, tapered birch legs, 30-inch',
      'Throw': 'Chunky hand-knit wool throw in cream, draped over sofa arm',
      'Sheepskin': 'Single sheepskin draped over one corner of sofa',
      'Rug': 'Soft ivory shag rug, 8x10, high pile',
      'Candles': '3-5 white pillar candles in simple ceramic holders on coffee table',
      'Plant': 'Trailing pothos in white ceramic hanging planter',
      'Art': 'Two simple line-art prints in thin light wood frames',
    },
    'bedroom': {
      'Bed': 'Birch wood bed frame, high headboard in oatmeal linen, clean lines',
      'Nightstands': 'Matching birch nightstands, single drawer, round wood knobs',
      'Throw': 'Chunky knit throw in cream at foot of bed',
      'Sheepskin': 'Sheepskin rug on floor beside bed',
      'Bedding': 'White and cream layered linen bedding, simple, no decorative pillows',
      'Lights': 'Warm string lights draped on headboard or nightstand',
      'Basket': 'Woven seagrass basket with rolled blankets',
      'Plant': 'Trailing plant on windowsill',
    },
  },
  bohemian: {
    'living-room': {
      'Sofa': 'Deep comfortable linen sofa in warm terracotta, loose back cushions',
      'Coffee Table': 'Vintage reclaimed wood coffee table, natural finish, slight patina',
      'Floor Cushions': '2-3 large floor cushions in mixed kilim patterns',
      'Pouf': 'Round leather pouf in warm brown, hand-stitched',
      'Rugs': 'Layered rugs — large jute base layer with smaller kilim pattern on top',
      'Macrame': 'Large macrame wall hanging on main wall, cotton, natural color',
      'Plants': 'Abundance of plants: hanging pothos, large monstera in woven basket, small succulents on shelf',
      'Art': 'Eclectic gallery wall with mixed frames, boho art, small mirrors, and one woven basket',
      'Lights': 'String lights or candles in amber glass holders',
    },
    'bedroom': {
      'Bed': 'Rattan bed frame with woven cane headboard, queen or king',
      'Nightstands': 'Mismatched: one vintage painted wood, one woven rattan side table',
      'Throw': 'Textured throw blanket in warm rust and mustard tones',
      'Rugs': 'Layered rugs beside bed — jute base with small patterned kilim',
      'Hanging Planter': 'Macrame plant hanger with trailing pothos near window',
      'Bedding': 'White base with colorful patterned throw pillows and a quilted coverlet',
      'Dream Catcher': 'Small dream catcher or wind chime near window',
      'Candles': '2-3 candles on nightstand in amber glass',
    },
  },
};

function buildFurnitureManifest(style, roomType) {
  const dna = FURNITURE_DNA[style]?.[roomType] || FURNITURE_DNA[style]?.['living-room'];
  if (!dna) return '';

  const lines = Object.entries(dna).map(([item, desc]) => `- ${item}: ${desc}`);
  return [
    ``,
    `FURNITURE DNA MANIFEST (use these EXACT items in every angle):`,
    ...lines,
  ].join('\n');
}

function buildReferencePrompt(style, roomType) {
  const config = STYLE_CONFIG[style];
  const label = config ? config.label : style;
  const materials = config ? config.materials : '';
  const manifest = buildFurnitureManifest(style, roomType);

  return [
    `Perform a high-end virtual staging on the provided room image.`,
    `Strictly maintain the original architectural integrity of the room, including the flooring, wall colors, ceiling structure, windows, and light fixtures.`,
    `Do not alter the layout or dimensions of the space.`,
    ``,
    `CRITICAL: A reference image of the SAME room staged from a different angle is provided.`,
    `Using the furniture, textures, and color palette established in the reference staged image, stage this new angle.`,
    `Ensure every piece of furniture is the EXACT SAME model and placed in the corresponding spatial positions relative to the room's architectural features (fireplace, windows, walls).`,
    manifest,
    ``,
    `Style: ${label}`,
    materials ? `Material Palette: ${materials}` : '',
    ``,
    `Lighting & Shadows: Ensure all furniture casts realistic shadows matching the existing light sources.`,
    `The final result must look like a professional real estate photograph taken from a different angle of the same staged room.`,
  ].filter(Boolean).join('\n');
}

app.get('/api/staging/styles', (req, res) => {
  res.json(Object.entries(STYLE_CONFIG).map(([id, c]) => ({ id, label: c.label })));
});

// ─── Serve images ───
app.get('/api/staging/images/:userId/:filename', imageAuthMiddleware, (req, res) => {
  const { userId, filename } = req.params;
  if (userId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  
  const resultPath = path.join(RESULTS_DIR, userId, filename);
  const uploadPath = path.join(UPLOADS_DIR, userId, filename);
  
  if (fs.existsSync(resultPath)) return res.sendFile(filename, { root: path.join(RESULTS_DIR, userId) });
  if (fs.existsSync(uploadPath)) return res.sendFile(filename, { root: path.join(UPLOADS_DIR, userId) });
  res.status(404).json({ error: 'Image not found' });
});

// ─── Serve thumbnails ───
app.get('/api/staging/thumbnails/:userId/:filename', imageAuthMiddleware, (req, res) => {
  const { userId, filename } = req.params;
  if (userId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  
  const thumbPath = path.join(THUMBS_DIR, userId, filename);
  if (fs.existsSync(thumbPath)) return res.sendFile(filename, { root: path.join(THUMBS_DIR, userId) });
  res.status(404).json({ error: 'Thumbnail not found' });
});

// ─── Download endpoint ───
app.get('/api/staging/download/:jobId', authMiddleware, (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ? AND user_id = ?').get(req.params.jobId, req.user.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'complete' || !job.result_path) return res.status(400).json({ error: 'No result available' });

  const filePath = path.join(RESULTS_DIR, req.user.id, job.result_path);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  const ext = path.extname(job.result_path) || '.jpg';
  const downloadName = `virtuestage-${job.style}-${job.room_type}${ext}`;
  res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
  res.sendFile(job.result_path, { root: path.join(RESULTS_DIR, req.user.id) });
});

// ─── Room Detection ───
const detectUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOADS_DIR, req.user.id);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `detect_${crypto.randomUUID()}${ext}`);
    }
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only images allowed'));
  }
});

app.post('/api/staging/detect-room', authMiddleware, detectUpload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  if (STAGING_MODE === 'demo') {
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.json({ room_type: 'living-room', confidence: 0, details: 'Demo mode: room detection is not run.', demo: true });
  }

  const enginePath = path.join(ENGINE_DIR, 'detect_room.py');
  const proc = spawn(PYTHON, [enginePath, req.file.path], { env: engineEnv() });

  let stdout = '', stderr = '';
  proc.stdout.on('data', d => { stdout += d; });
  proc.stderr.on('data', d => { stderr += d; });

  proc.on('close', code => {
    // Clean up detect file — the real upload happens in /upload
    try { fs.unlinkSync(req.file.path); } catch {}

    if (code !== 0) {
      console.error(`[detect] Failed: ${stderr}`);
      return res.status(500).json({ error: 'Room detection failed' });
    }
    try {
      const result = JSON.parse(stdout.trim());
      res.json(result);
    } catch {
      res.status(500).json({ error: 'Invalid detection response' });
    }
  });
});

// ─── Upload & stage ───
const uploadMiddleware = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOADS_DIR, req.user.id);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `${crypto.randomUUID()}${ext}`);
    }
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only images allowed'));
  }
});

function engineEnv() {
  return { ...process.env, GOOGLE_API_KEY: process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '' };
}

// Room-type detection via the Python engine. Resolves to a room type string,
// falling back to living-room on any failure (and always in demo mode).
function detectRoomType(imagePath) {
  if (STAGING_MODE === 'demo') return Promise.resolve('living-room');
  return new Promise(resolve => {
    const proc = spawn(PYTHON, [path.join(ENGINE_DIR, 'detect_room.py'), imagePath], { env: engineEnv() });
    let stdout = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.on('error', () => resolve('living-room'));
    proc.on('close', code => {
      try { if (code === 0) return resolve(JSON.parse(stdout.trim()).room_type || 'living-room'); } catch {}
      resolve('living-room');
    });
  });
}

function findDemoSample(roomType) {
  for (const dir of DEMO_SAMPLE_DIRS) {
    for (const name of [`${roomType}.jpg`, 'living-room.jpg']) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

// Demo "engine": a bundled sample staged photo (or, if none is available, the
// uploaded photo itself) with a visible DEMO banner. No AI call is made.
async function renderDemoResult(uploadPath, roomType, outPath) {
  const source = findDemoSample(roomType) || uploadPath;
  // Match the upload's aspect ratio so before/after line up in the compare slider
  const meta = await sharp(uploadPath).rotate().metadata();
  const scale = Math.min(1, 1280 / Math.max(meta.width || 1280, meta.height || 960));
  const width = Math.round((meta.width || 1280) * scale);
  const height = Math.round((meta.height || 960) * scale);
  const base = sharp(source).rotate().resize({ width, height, fit: 'cover' });
  const { data, info } = await base.jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true });
  // Two-line label in the upper right, where the "after" half of the compare
  // slider shows by default, inset so it survives cover-cropping in the UI.
  const labelW = Math.round(info.width * 0.36);
  const fontSize = Math.max(10, Math.round(labelW / 19));
  const labelH = Math.round(fontSize * 3.3);
  const banner = Buffer.from(
    `<svg width="${labelW}" height="${labelH}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" rx="${Math.round(fontSize * 0.6)}" fill="#0f172a" fill-opacity="0.85"/>
      <text x="50%" y="38%" dominant-baseline="central" text-anchor="middle" font-family="sans-serif"
        font-size="${fontSize}" font-weight="700" fill="#f59e0b">DEMO MODE SAMPLE</text>
      <text x="50%" y="70%" dominant-baseline="central" text-anchor="middle" font-family="sans-serif"
        font-size="${Math.round(fontSize * 0.72)}" fill="#e2e8f0">not generated from your photo</text>
    </svg>`
  );
  const top = Math.round(info.height * 0.1);
  const left = Math.round(info.width * 0.58);
  await sharp(data).composite([{ input: banner, top, left }]).jpeg({ quality: 85 }).toFile(outPath);
}

async function completeJob(jobId, userId, uploadPath, resultFilename, genTime) {
  const resultPath = path.join(RESULTS_DIR, userId, resultFilename);
  const resultThumb = await generateThumbnail(resultPath, userId, `${jobId}_result`);
  const origThumb = await generateThumbnail(uploadPath, userId, `${jobId}_original`);
  db.prepare('UPDATE jobs SET status = ?, result_path = ?, generation_time = ?, thumbnail_path = ?, original_thumbnail_path = ? WHERE id = ?')
    .run('complete', resultFilename, genTime, resultThumb, origThumb, jobId);
  // Credits are only deducted for successful jobs
  db.prepare('UPDATE users SET credits = MAX(credits - 1, 0) WHERE id = ?').run(userId);
  console.log(`[${jobId}] Complete. Credit deducted for user ${userId}`);
}

function runDemoJob(jobId, userId, roomType, uploadPath) {
  const userResultsDir = path.join(RESULTS_DIR, userId);
  fs.mkdirSync(userResultsDir, { recursive: true });
  const resultFilename = `${jobId}_staged.jpg`;
  const startTime = Date.now();
  setTimeout(async () => {
    try {
      await renderDemoResult(uploadPath, roomType, path.join(userResultsDir, resultFilename));
      await completeJob(jobId, userId, uploadPath, resultFilename, (Date.now() - startTime) / 1000);
    } catch (e) {
      console.error(`[${jobId}] Demo render failed:`, e.message);
      db.prepare('UPDATE jobs SET status = ?, error = ? WHERE id = ?').run('error', 'Demo render failed', jobId);
    }
  }, Number(process.env.DEMO_DELAY_MS ?? 1500)); // simulated processing time
}

function runStagingJob(jobId, userId, style, roomType, uploadPath, originalFilename, { referenceImage } = {}) {
  if (STAGING_MODE === 'demo') return runDemoJob(jobId, userId, roomType, uploadPath);

  const prompt = referenceImage
    ? buildReferencePrompt(style, roomType)
    : buildStagingPrompt(style, roomType);
  const enginePath = path.join(ENGINE_DIR, 'virtual_stager.py');
  const userResultsDir = path.join(RESULTS_DIR, userId);
  fs.mkdirSync(userResultsDir, { recursive: true });

  const args = [enginePath, uploadPath, '--style', style, '--models', 'gemini', '--gemini-model', GEMINI_IMAGE_MODEL, '--prompt', prompt];
  if (referenceImage) args.push('--reference-image', referenceImage);
  console.log(`[${jobId}] Spawning engine for user ${userId}`);

  const proc = spawn(PYTHON, args, { cwd: userResultsDir, env: engineEnv() });
  proc.on('error', (e) => {
    db.prepare('UPDATE jobs SET status = ?, error = ? WHERE id = ?').run('error', `Could not start engine: ${e.message}`, jobId);
  });

  let stdout = '', stderr = '';
  const startTime = Date.now();
  proc.stdout.on('data', d => { stdout += d; });
  proc.stderr.on('data', d => { stderr += d; console.error(`[${jobId}] ${d}`); });

  proc.on('close', async (code) => {
    const genTime = (Date.now() - startTime) / 1000;
    console.log(`[${jobId}] Engine exited code=${code} in ${genTime.toFixed(1)}s`);

    if (code !== 0) {
      db.prepare('UPDATE jobs SET status = ?, error = ? WHERE id = ?').run('error', stderr || 'Engine failed', jobId);
      return;
    }

    const ext = path.extname(originalFilename);
    const stem = path.basename(originalFilename, ext);
    const possibleNames = [
      `${stem}_staged_${style}_gemini${ext}`,
      `${stem}_staged_${style}_openai${ext}`,
    ];

    let foundPath = null;
    for (const name of possibleNames) {
      for (const dir of [path.dirname(uploadPath), userResultsDir]) {
        const p = path.join(dir, name);
        if (fs.existsSync(p)) { foundPath = p; break; }
      }
      if (foundPath) break;
    }

    if (foundPath) {
      const resultFilename = `${jobId}_staged${ext}`;
      fs.renameSync(foundPath, path.join(userResultsDir, resultFilename));
      await completeJob(jobId, userId, uploadPath, resultFilename, genTime);
    } else {
      db.prepare('UPDATE jobs SET status = ?, error = ? WHERE id = ?')
        .run('error', 'Staged image not found. Output: ' + stdout, jobId);
    }
  });
}

app.post('/api/staging/upload', authMiddleware, uploadMiddleware.single('room_0'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const userId = req.user.id;
  const style = req.body.style || 'modern';
  const roomType = req.body.room_type || 'living-room';

  // Validate style
  if (!STYLE_CONFIG[style]) return res.status(400).json({ error: 'Invalid style' });

  // Check credits
  if (availableCredits(req.user) <= 0 && req.user.plan === 'free') {
    return res.status(402).json({ error: 'No credits remaining. Paid plans are not available yet.' });
  }

  // Rate limit: max 3 concurrent
  if (checkConcurrentJobs(userId) >= 3) {
    return res.status(429).json({ error: 'Too many concurrent jobs. Please wait for current jobs to finish.' });
  }

  const jobId = crypto.randomUUID();
  const originalFilename = req.file.filename;
  const uploadPath = req.file.path;

  function startJob(detectedRoomType) {
    const finalRoomType = detectedRoomType || roomType;
    const isAuto = roomType === 'auto' ? 1 : 0;
    db.prepare(`
      INSERT INTO jobs (id, user_id, status, style, room_type, original_path, auto_detected)
      VALUES (?, ?, 'processing', ?, ?, ?, ?)
    `).run(jobId, userId, style, finalRoomType, originalFilename, isAuto);

    runStagingJob(jobId, userId, style, finalRoomType, uploadPath, originalFilename);
    res.json({ jobId, roomType: finalRoomType, autoDetected: !!isAuto });
  }

  // Auto-detect room type if requested
  if (roomType === 'auto') {
    detectRoomType(uploadPath).then(detected => {
      console.log(`[${jobId}] Auto-detected room: ${detected}`);
      startJob(detected);
    });
  } else {
    startJob(null);
  }
});

// ─── Re-stage endpoint ───
app.post('/api/staging/restage/:jobId', authMiddleware, (req, res) => {
  const originalJob = db.prepare('SELECT * FROM jobs WHERE id = ? AND user_id = ?').get(req.params.jobId, req.user.id);
  if (!originalJob) return res.status(404).json({ error: 'Job not found' });
  if (!originalJob.original_path) return res.status(400).json({ error: 'Original image not found' });

  const newStyle = req.body.style;
  if (!newStyle || !STYLE_CONFIG[newStyle]) return res.status(400).json({ error: 'Invalid style' });

  if (availableCredits(req.user) <= 0 && req.user.plan === 'free') {
    return res.status(402).json({ error: 'No credits remaining.' });
  }

  if (checkConcurrentJobs(req.user.id) >= 3) {
    return res.status(429).json({ error: 'Too many concurrent jobs.' });
  }

  const jobId = crypto.randomUUID();
  const userId = req.user.id;
  const uploadPath = path.join(UPLOADS_DIR, userId, originalJob.original_path);

  if (!fs.existsSync(uploadPath)) return res.status(400).json({ error: 'Original image file missing' });

  db.prepare(`
    INSERT INTO jobs (id, user_id, status, style, room_type, original_path)
    VALUES (?, ?, 'processing', ?, ?, ?)
  `).run(jobId, userId, newStyle, originalJob.room_type, originalJob.original_path);

  runStagingJob(jobId, userId, newStyle, originalJob.room_type, uploadPath, originalJob.original_path);
  res.json({ jobId });
});

// ─── Project endpoints (multi-angle staging) ───

// Create project + upload hero shot
app.post('/api/projects', authMiddleware, uploadMiddleware.single('hero_image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Hero image required' });

  const userId = req.user.id;
  const style = req.body.style || 'modern';
  const roomType = req.body.room_type || 'auto';
  const name = req.body.name || 'Untitled Room';

  if (!STYLE_CONFIG[style]) return res.status(400).json({ error: 'Invalid style' });
  if (availableCredits(req.user) <= 0 && req.user.plan === 'free') {
    return res.status(402).json({ error: 'No credits remaining.' });
  }

  const projectId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const originalFilename = req.file.filename;
  const uploadPath = req.file.path;

  function createProject(finalRoomType) {
    db.prepare(`INSERT INTO projects (id, user_id, name, style, room_type, hero_job_id, status) VALUES (?, ?, ?, ?, ?, ?, 'staging_hero')`)
      .run(projectId, userId, name, style, finalRoomType, jobId);

    db.prepare(`INSERT INTO jobs (id, user_id, status, style, room_type, original_path, project_id, is_hero) VALUES (?, ?, 'processing', ?, ?, ?, ?, 1)`)
      .run(jobId, userId, style, finalRoomType, originalFilename, projectId);

    runStagingJob(jobId, userId, style, finalRoomType, uploadPath, originalFilename);
    res.json({ project: { id: projectId, heroJobId: jobId, name: name, style, roomType: finalRoomType, autoDetected: req.body.room_type === 'auto' || !req.body.room_type } });
  }

  if (roomType === 'auto') {
    detectRoomType(uploadPath).then(createProject);
  } else {
    createProject(roomType);
  }
});

// Add batch images to a project (after hero is staged)
app.post('/api/projects/:projectId/batch', authMiddleware, uploadMiddleware.array('images', 10), (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(req.params.projectId, req.user.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  // Get the hero job's result to use as reference
  const heroJob = db.prepare('SELECT * FROM jobs WHERE id = ? AND status = ?').get(project.hero_job_id, 'complete');
  if (!heroJob || !heroJob.result_path) {
    return res.status(400).json({ error: 'Hero image must be staged first. Wait for processing to complete.' });
  }

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No images uploaded' });
  }

  const userId = req.user.id;
  const creditsNeeded = req.files.length;
  if (availableCredits(req.user) < creditsNeeded && req.user.plan === 'free') {
    return res.status(402).json({ error: `Need ${creditsNeeded} credits, you have ${req.user.credits}.` });
  }

  if (checkConcurrentJobs(userId) + req.files.length > 5) {
    return res.status(429).json({ error: 'Too many concurrent jobs. Upload fewer images or wait.' });
  }

  const referenceImage = path.join(RESULTS_DIR, userId, heroJob.result_path);
  const jobs = [];

  for (const file of req.files) {
    const jobId = crypto.randomUUID();
    db.prepare(`INSERT INTO jobs (id, user_id, status, style, room_type, original_path, project_id, is_hero) VALUES (?, ?, 'processing', ?, ?, ?, ?, 0)`)
      .run(jobId, userId, project.style, project.room_type, file.filename, req.params.projectId);

    runStagingJob(jobId, userId, project.style, project.room_type, file.path, file.filename, { referenceImage });
    jobs.push({ jobId, filename: file.originalname });
  }

  db.prepare("UPDATE projects SET status = 'staging_batch' WHERE id = ?").run(req.params.projectId);
  res.json({ projectId: req.params.projectId, jobs });
});

// Get project with all jobs
app.get('/api/projects/:projectId', authMiddleware, (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(req.params.projectId, req.user.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const userId = req.user.id;
  const imgTok = imageToken(userId);
  const projectJobs = db.prepare('SELECT * FROM jobs WHERE project_id = ? ORDER BY is_hero DESC, created_at ASC').all(project.id);

  const allComplete = projectJobs.every(j => j.status === 'complete' || j.status === 'error');
  if (allComplete && project.status !== 'complete') {
    db.prepare("UPDATE projects SET status = 'complete' WHERE id = ?").run(project.id);
    project.status = 'complete';
  }

  res.json({
    ...project,
    jobs: projectJobs.map(j => ({
      jobId: j.id,
      status: j.status,
      style: j.style,
      room_type: j.room_type,
      is_hero: !!j.is_hero,
      originalUrl: j.original_path ? imageUrl('images', userId, j.original_path, imgTok) : null,
      results: j.result_path ? [{
        url: imageUrl('images', userId, j.result_path, imgTok),
        model: MODEL_LABEL,
        metadata: { generation_time: j.generation_time }
      }] : [],
      error: j.error,
      created_at: j.created_at,
    }))
  });
});

// List user's projects (with jobs for dashboard thumbnails)
app.get('/api/projects', authMiddleware, (req, res) => {
  const userId = req.user.id;
  const imgTok = imageToken(userId);
  const projects = db.prepare('SELECT * FROM projects WHERE user_id = ? ORDER BY created_at DESC').all(userId);
  const result = projects.map(p => {
    const projectJobs = db.prepare('SELECT * FROM jobs WHERE project_id = ? ORDER BY is_hero DESC, created_at ASC').all(p.id);
    return {
      ...p,
      jobs: projectJobs.map(j => ({
        jobId: j.id,
        status: j.status,
        style: j.style,
        room_type: j.room_type,
        is_hero: !!j.is_hero,
        originalUrl: j.original_path ? imageUrl('images', userId, j.original_path, imgTok) : null,
        thumbnailUrl: j.result_path ? imageUrl('thumbnails', userId, `${j.id}_result_thumb.jpg`, imgTok) : null,
        results: j.result_path ? [{
          url: imageUrl('images', userId, j.result_path, imgTok),
        }] : [],
      })),
    };
  });
  res.json({ projects: result });
});

// ─── Job endpoints ───
app.get('/api/staging/status/:jobId', authMiddleware, (req, res) => {
  const job = db.prepare('SELECT status, error, room_type, auto_detected FROM jobs WHERE id = ? AND user_id = ?').get(req.params.jobId, req.user.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ status: job.status, error: job.error, roomType: job.room_type, autoDetected: !!job.auto_detected });
});

app.get('/api/staging/results/:jobId', authMiddleware, (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ? AND user_id = ?').get(req.params.jobId, req.user.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const userId = req.user.id;
  const imgTok = imageToken(userId);
  res.json({
    jobId: job.id,
    status: job.status,
    style: job.style,
    roomType: job.room_type,
    room_type: job.room_type,
    autoDetected: !!job.auto_detected,
    originalUrl: job.original_path ? imageUrl('images', userId, job.original_path, imgTok) : null,
    results: job.result_path ? [{
      url: imageUrl('images', userId, job.result_path, imgTok),
      model: MODEL_LABEL,
      metadata: { generation_time: job.generation_time }
    }] : [],
    error: job.error,
    created_at: job.created_at,
  });
});

app.get('/api/staging/jobs', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  const userId = req.user.id;
  const imgTok = imageToken(userId);
  const jobs = rows.map(job => ({
    jobId: job.id,
    status: job.status,
    style: job.style,
    room_type: job.room_type,
    originalUrl: job.original_path ? imageUrl('images', userId, job.original_path, imgTok) : null,
    thumbnailUrl: job.thumbnail_path ? imageUrl('thumbnails', userId, job.thumbnail_path, imgTok) : null,
    originalThumbnailUrl: job.original_thumbnail_path ? imageUrl('thumbnails', userId, job.original_thumbnail_path, imgTok) : null,
    results: job.result_path ? [{
      url: imageUrl('images', userId, job.result_path, imgTok),
      model: MODEL_LABEL,
      metadata: { generation_time: job.generation_time }
    }] : [],
    error: job.error,
    created_at: job.created_at,
  }));
  res.json({ jobs });
});

// ─── Production static file serving ───
const publicDir = path.join(__dirname, 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  // SPA fallback — serve index.html for all non-API routes
  app.get('/{*splat}', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile('index.html', { root: publicDir });
  });
  console.log('Serving static frontend from', publicDir);
}

// ─── Error handling middleware ───
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large. Max 20MB.' });
    return res.status(400).json({ error: err.message });
  }
  if (err.message === 'Only images allowed') return res.status(400).json({ error: err.message });
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`VirtueStage backend running on http://localhost:${PORT} (staging mode: ${STAGING_MODE})`);
  });
}

module.exports = app;
