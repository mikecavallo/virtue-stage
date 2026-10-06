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
try { db.exec("ALTER TABLE jobs ADD COLUMN mode TEXT NOT NULL DEFAULT 'stage'"); } catch {}

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

// ─── Styles ───
// Style presets (palette, materials, furniture per category, things to avoid) live in
// engine/staging/styles.json and are shared with the Python engine, which builds the
// actual prompts from them. The backend only needs ids and labels for validation and the UI.
const STYLES_PATH = path.join(ENGINE_DIR, 'staging', 'styles.json');
const STYLE_CONFIG = JSON.parse(fs.readFileSync(STYLES_PATH, 'utf8'));
const STAGING_MODES = ['stage', 'declutter_stage', 'declutter'];

app.get('/api/staging/styles', (req, res) => {
  res.json(Object.entries(STYLE_CONFIG).map(([id, c]) => ({ id, label: c.label, tagline: c.tagline })));
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
// Downloads carry a "Virtually Staged" disclosure label by default, since many MLSs (and NAR
// guidance) require virtually staged photos to be disclosed. DISCLOSURE_WATERMARK=off changes the
// default; ?disclosure=0 or ?disclosure=1 overrides it per download.
const DISCLOSURE_DEFAULT = !['off', '0', 'false', 'no'].includes(String(process.env.DISCLOSURE_WATERMARK || 'on').toLowerCase());

function wantsDisclosure(query) {
  if (query.disclosure === undefined) return DISCLOSURE_DEFAULT;
  return !['0', 'false', 'off', 'no'].includes(String(query.disclosure).toLowerCase());
}

async function addDisclosureLabel(filePath, text = 'Virtually Staged') {
  const img = sharp(filePath).rotate();
  const { width, height, format } = await img.metadata();
  const short = Math.min(width, height);
  const fontSize = Math.max(12, Math.round(short * 0.04));
  const pad = Math.round(fontSize / 2);
  const labelW = Math.round(text.length * fontSize * 0.6) + pad * 2;
  const labelH = Math.round(fontSize * 1.25) + pad * 2;
  const margin = Math.max(6, Math.round(short * 0.02));
  const svg = Buffer.from(
    `<svg width="${labelW}" height="${labelH}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" rx="${pad}" fill="#0f172a" fill-opacity="0.72"/>
      <text x="50%" y="52%" dominant-baseline="central" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif"
        font-size="${fontSize}" font-weight="700" fill="#ffffff">${text}</text>
    </svg>`
  );
  const out = img.composite([{ input: svg, left: margin, top: height - margin - labelH }]);
  if (format === 'png') return out.png().toBuffer();
  if (format === 'webp') return out.webp({ quality: 92 }).toBuffer();
  return out.jpeg({ quality: 92 }).toBuffer();
}

app.get('/api/staging/download/:jobId', authMiddleware, async (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ? AND user_id = ?').get(req.params.jobId, req.user.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'complete' || !job.result_path) return res.status(400).json({ error: 'No result available' });

  const filePath = path.join(RESULTS_DIR, req.user.id, job.result_path);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  const ext = path.extname(job.result_path) || '.jpg';
  const disclose = wantsDisclosure(req.query);
  const downloadName = `virtuestage-${job.style}-${job.room_type}${disclose ? '-virtually-staged' : ''}${ext}`;
  res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
  res.setHeader('X-Disclosure-Label', disclose ? 'on' : 'off');
  if (!disclose) return res.sendFile(job.result_path, { root: path.join(RESULTS_DIR, req.user.id) });
  try {
    const buf = await addDisclosureLabel(filePath);
    res.type(ext).send(buf);
  } catch (e) {
    console.error(`[${job.id}] Disclosure label failed:`, e.message);
    res.status(500).json({ error: 'Could not prepare download' });
  }
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

// Engine contract (engine/virtual_stager.py): writes <stem>_staged_<style>_<provider><ext> at the
// input's exact size, plus a .json metadata file (analysis, plan, candidate scores) beside it.
function runStagingJob(jobId, userId, style, roomType, uploadPath, originalFilename,
  { referenceImage, referencePlan, mode = 'stage' } = {}) {
  if (STAGING_MODE === 'demo') return runDemoJob(jobId, userId, roomType, uploadPath);

  const enginePath = path.join(ENGINE_DIR, 'virtual_stager.py');
  const userResultsDir = path.join(RESULTS_DIR, userId);
  fs.mkdirSync(userResultsDir, { recursive: true });

  const args = [enginePath, uploadPath, '--style', style, '--mode', mode,
    '--gemini-model', GEMINI_IMAGE_MODEL];
  if (roomType && roomType !== 'auto') args.push('--room-type', roomType);
  if (referenceImage) args.push('--reference-image', referenceImage);
  if (referencePlan && fs.existsSync(referencePlan)) args.push('--reference-plan', referencePlan);
  console.log(`[${jobId}] Spawning engine for user ${userId} (style=${style}, mode=${mode})`);

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
      db.prepare('UPDATE jobs SET status = ?, error = ? WHERE id = ?').run('error', (stderr || 'Engine failed').slice(-2000), jobId);
      return;
    }

    const ext = path.extname(originalFilename);
    const stem = path.basename(originalFilename, ext);
    const possibleNames = ['gemini', 'openai', 'fake'].map(p => `${stem}_staged_${style}_${p}${ext}`);

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
      const metaSrc = foundPath.slice(0, -ext.length) + '.json';
      if (fs.existsSync(metaSrc)) fs.renameSync(metaSrc, path.join(userResultsDir, metadataFilename(resultFilename)));
      await completeJob(jobId, userId, uploadPath, resultFilename, genTime);
    } else {
      db.prepare('UPDATE jobs SET status = ?, error = ? WHERE id = ?')
        .run('error', 'Staged image not found. Output: ' + stdout.slice(-2000), jobId);
    }
  });
}

function metadataFilename(resultFilename) {
  return resultFilename.slice(0, -path.extname(resultFilename).length) + '.json';
}

// Summary of the engine's quality checks for a finished job (null in demo mode or for old jobs).
function readQuality(userId, resultFilename) {
  if (!resultFilename) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, userId, metadataFilename(resultFilename)), 'utf8'));
    const q = meta.quality || {};
    return {
      passed: !!q.passed,
      fidelity: q.fidelity ?? null,
      judgeOverall: q.judge_overall ?? null,
      renders: q.renders ?? null,
      roomTypeDetected: meta.analysis?.room_type ?? null,
      warnings: meta.warnings || [],
    };
  } catch {
    return null;
  }
}

function parseMode(value) {
  const mode = value || 'stage';
  return STAGING_MODES.includes(mode) ? mode : null;
}

app.post('/api/staging/upload', authMiddleware, uploadMiddleware.single('room_0'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const userId = req.user.id;
  const style = req.body.style || 'modern';
  const roomType = req.body.room_type || 'living-room';
  const mode = parseMode(req.body.mode);

  // Validate style and mode
  if (!STYLE_CONFIG[style]) return res.status(400).json({ error: 'Invalid style' });
  if (!mode) return res.status(400).json({ error: `Invalid mode. Use one of: ${STAGING_MODES.join(', ')}` });

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
      INSERT INTO jobs (id, user_id, status, style, room_type, original_path, auto_detected, mode)
      VALUES (?, ?, 'processing', ?, ?, ?, ?, ?)
    `).run(jobId, userId, style, finalRoomType, originalFilename, isAuto, mode);

    runStagingJob(jobId, userId, style, finalRoomType, uploadPath, originalFilename, { mode });
    res.json({ jobId, roomType: finalRoomType, autoDetected: !!isAuto, mode });
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
  const mode = parseMode(req.body.mode || originalJob.mode);
  if (!mode) return res.status(400).json({ error: 'Invalid mode' });

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
    INSERT INTO jobs (id, user_id, status, style, room_type, original_path, mode)
    VALUES (?, ?, 'processing', ?, ?, ?, ?)
  `).run(jobId, userId, newStyle, originalJob.room_type, originalJob.original_path, mode);

  runStagingJob(jobId, userId, newStyle, originalJob.room_type, uploadPath, originalJob.original_path, { mode });
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
  const mode = parseMode(req.body.mode);

  if (!STYLE_CONFIG[style]) return res.status(400).json({ error: 'Invalid style' });
  if (!mode || mode === 'declutter') return res.status(400).json({ error: 'Invalid mode for a project' });
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

    db.prepare(`INSERT INTO jobs (id, user_id, status, style, room_type, original_path, project_id, is_hero, mode) VALUES (?, ?, 'processing', ?, ?, ?, ?, 1, ?)`)
      .run(jobId, userId, style, finalRoomType, originalFilename, projectId, mode);

    runStagingJob(jobId, userId, style, finalRoomType, uploadPath, originalFilename, { mode });
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

  // Other angles are staged with the hero result as a reference image and the hero's saved
  // plan (furniture list), so the same pieces appear in every angle.
  const referenceImage = path.join(RESULTS_DIR, userId, heroJob.result_path);
  const referencePlan = path.join(RESULTS_DIR, userId, metadataFilename(heroJob.result_path));
  const mode = heroJob.mode === 'declutter_stage' ? 'declutter_stage' : 'stage';
  const jobs = [];

  for (const file of req.files) {
    const jobId = crypto.randomUUID();
    db.prepare(`INSERT INTO jobs (id, user_id, status, style, room_type, original_path, project_id, is_hero, mode) VALUES (?, ?, 'processing', ?, ?, ?, ?, 0, ?)`)
      .run(jobId, userId, project.style, project.room_type, file.filename, req.params.projectId, mode);

    runStagingJob(jobId, userId, project.style, project.room_type, file.path, file.filename, { referenceImage, referencePlan, mode });
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
      quality: readQuality(userId, j.result_path),
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
    mode: job.mode,
    originalUrl: job.original_path ? imageUrl('images', userId, job.original_path, imgTok) : null,
    results: job.result_path ? [{
      url: imageUrl('images', userId, job.result_path, imgTok),
      model: MODEL_LABEL,
      metadata: { generation_time: job.generation_time }
    }] : [],
    // Engine quality checks (structural fidelity + judge); null in demo mode.
    quality: readQuality(userId, job.result_path),
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
