// Contract test between the backend and the real Python engine (engine/virtual_stager.py),
// using the engine's offline fake provider (VIRTUESTAGE_PROVIDER=fake): no API key, no network.
// Skipped automatically when python3 with Pillow and numpy is not available.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const python = process.env.PYTHON_BIN || 'python3';
const probe = spawnSync(python, ['-c', 'import PIL, numpy'], { encoding: 'utf8' });
const skip = probe.status !== 0 ? `python3 with Pillow + numpy not available (${(probe.stderr || probe.error || '').toString().trim()})` : false;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'virtuestage-engine-test-'));
process.env.DATA_DIR = dataDir;
process.env.STAGING_MODE = 'gemini';
process.env.VIRTUESTAGE_PROVIDER = 'fake';
process.env.STAGING_CANDIDATES = '1';
process.env.JWT_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const sharp = require('sharp');
const app = require('../server');

let roomJpeg;
before(async () => {
  // 3:2 "room": light walls over a darker floor, so the fake renderer's furniture is visible.
  const floor = await sharp({ create: { width: 600, height: 150, channels: 3, background: '#9c7a58' } }).png().toBuffer();
  roomJpeg = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#e2dccf' } })
    .composite([{ input: floor, top: 250, left: 0 }]).jpeg().toBuffer();
});
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

async function signup() {
  const res = await request(app).post('/api/auth/signup')
    .send({ email: `eng${Date.now()}${Math.random()}@example.test`, password: 'secret123', name: 'Engine' });
  return { token: res.body.token, user: res.body.user };
}

async function waitForJob(token, jobId) {
  for (let i = 0; i < 300; i++) {
    const res = await request(app).get(`/api/staging/status/${jobId}`).set('Authorization', `Bearer ${token}`);
    if (res.body.status !== 'processing') return res.body;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('job did not finish');
}

test('engine job: output matches input size and quality metadata is exposed', { skip }, async () => {
  const { token, user } = await signup();
  const res = await request(app).post('/api/staging/upload').set('Authorization', `Bearer ${token}`)
    .field('style', 'coastal').field('room_type', 'living-room')
    .attach('room_0', roomJpeg, { filename: 'room.jpg', contentType: 'image/jpeg' });
  assert.equal(res.status, 200);
  const status = await waitForJob(token, res.body.jobId);
  assert.equal(status.status, 'complete', status.error);

  const results = await request(app).get(`/api/staging/results/${res.body.jobId}`).set('Authorization', `Bearer ${token}`);
  assert.equal(results.body.quality.passed, true);
  assert.ok(results.body.quality.fidelity > 0.5);

  const img = await request(app).get(results.body.results[0].url).buffer(true);
  const meta = await sharp(img.body).metadata();
  assert.deepEqual([meta.width, meta.height], [600, 400]);

  const engineMeta = JSON.parse(fs.readFileSync(path.join(dataDir, 'results', user.id, `${res.body.jobId}_staged.json`), 'utf8'));
  assert.equal(engineMeta.plan.style, 'coastal');
  assert.equal(engineMeta.analysis.room_type, 'living-room');
});

test('multi-angle project: batch jobs get the hero image and the hero plan', { skip }, async () => {
  const { token, user } = await signup();
  const created = await request(app).post('/api/projects').set('Authorization', `Bearer ${token}`)
    .field('style', 'farmhouse').field('room_type', 'bedroom').field('name', 'Primary')
    .attach('hero_image', roomJpeg, { filename: 'hero.jpg', contentType: 'image/jpeg' });
  assert.equal(created.status, 200);
  const hero = await waitForJob(token, created.body.project.heroJobId);
  assert.equal(hero.status, 'complete', hero.error);

  const batch = await request(app).post(`/api/projects/${created.body.project.id}/batch`).set('Authorization', `Bearer ${token}`)
    .attach('images', roomJpeg, { filename: 'angle2.jpg', contentType: 'image/jpeg' });
  assert.equal(batch.status, 200);
  const jobId = batch.body.jobs[0].jobId;
  const st = await waitForJob(token, jobId);
  assert.equal(st.status, 'complete', st.error);

  const dir = path.join(dataDir, 'results', user.id);
  const heroMeta = JSON.parse(fs.readFileSync(path.join(dir, `${created.body.project.heroJobId}_staged.json`), 'utf8'));
  const angleMeta = JSON.parse(fs.readFileSync(path.join(dir, `${jobId}_staged.json`), 'utf8'));
  assert.equal(angleMeta.settings.reference_image, true);
  assert.equal(angleMeta.settings.reference_plan, true);
  assert.deepEqual(angleMeta.plan.pieces.map(p => p.description), heroMeta.plan.pieces.map(p => p.description));
});

test('engine failure surfaces as a job error and costs no credit', { skip }, async () => {
  const { token } = await signup();
  const res = await request(app).post('/api/staging/upload').set('Authorization', `Bearer ${token}`)
    .field('style', 'modern').field('room_type', 'living-room')
    .attach('room_0', Buffer.from('not really a jpeg'), { filename: 'broken.jpg', contentType: 'image/jpeg' });
  assert.equal(res.status, 200);
  const status = await waitForJob(token, res.body.jobId);
  assert.equal(status.status, 'error');
  const credits = await request(app).get('/api/credits').set('Authorization', `Bearer ${token}`);
  assert.equal(credits.body.credits, 3);
});
