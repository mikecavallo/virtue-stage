// Backend API tests. Run with `npm test`.
// Uses a throwaway data directory and STAGING_MODE=demo, so no Python engine
// or Gemini API key is involved.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'virtuestage-test-'));
process.env.DATA_DIR = dataDir;
process.env.STAGING_MODE = 'demo';
process.env.DEMO_DELAY_MS = '0';
process.env.JWT_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const sharp = require('sharp');
const app = require('../server');

let roomJpeg;

before(async () => {
  roomJpeg = await sharp({ create: { width: 320, height: 240, channels: 3, background: '#d9d4cc' } }).jpeg().toBuffer();
});

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let counter = 0;
async function signup(overrides = {}) {
  counter += 1;
  const body = { email: `user${counter}@example.test`, password: 'secret123', name: `User ${counter}`, ...overrides };
  const res = await request(app).post('/api/auth/signup').send(body);
  return { res, token: res.body.token, user: res.body.user, body };
}

function upload(token, fields = {}) {
  const req = request(app).post('/api/staging/upload').set('Authorization', `Bearer ${token}`);
  for (const [k, v] of Object.entries({ style: 'modern', room_type: 'living-room', ...fields })) req.field(k, v);
  return req.attach('room_0', roomJpeg, { filename: 'room.jpg', contentType: 'image/jpeg' });
}

async function waitForJob(token, jobId) {
  for (let i = 0; i < 100; i++) {
    const res = await request(app).get(`/api/staging/status/${jobId}`).set('Authorization', `Bearer ${token}`);
    if (res.body.status !== 'processing') return res.body;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('job did not finish');
}

test('health reports demo staging mode', async () => {
  const res = await request(app).get('/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'ok', stagingMode: 'demo' });
});

test('signup returns a token and 3 free credits', async () => {
  const { res, user } = await signup();
  assert.equal(res.status, 200);
  assert.ok(res.body.token);
  assert.equal(user.credits, 3);
  assert.equal(user.plan, 'free');
});

test('signup validates input and rejects duplicates', async () => {
  assert.equal((await request(app).post('/api/auth/signup').send({ email: 'a@b.test' })).status, 400);
  assert.equal((await request(app).post('/api/auth/signup').send({ email: 'a@b.test', password: '123' })).status, 400);
  assert.equal((await request(app).post('/api/auth/signup').send({ email: 'not-an-email', password: 'secret123' })).status, 400);
  const { body } = await signup();
  const dup = await request(app).post('/api/auth/signup').send(body);
  assert.equal(dup.status, 409);
});

test('login succeeds with the right password and fails otherwise', async () => {
  const { body } = await signup();
  const ok = await request(app).post('/api/auth/login').send({ email: body.email, password: body.password });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
  const bad = await request(app).post('/api/auth/login').send({ email: body.email, password: 'wrong-password' });
  assert.equal(bad.status, 401);
});

test('protected routes require a valid token', async () => {
  assert.equal((await request(app).get('/api/auth/me')).status, 401);
  assert.equal((await request(app).get('/api/auth/me').set('Authorization', 'Bearer nope')).status, 401);
  const { token, user } = await signup();
  const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, user.email);
  assert.equal(me.body.user.password_hash, undefined);
});

test('upload rejects missing files, bad styles and non-images', async () => {
  const { token } = await signup();
  const noFile = await request(app).post('/api/staging/upload').set('Authorization', `Bearer ${token}`).field('style', 'modern');
  assert.equal(noFile.status, 400);
  assert.equal((await upload(token, { style: 'neon-cyberpunk' })).status, 400);
  const notImage = await request(app).post('/api/staging/upload').set('Authorization', `Bearer ${token}`)
    .attach('room_0', Buffer.from('hello'), { filename: 'notes.txt', contentType: 'text/plain' });
  assert.equal(notImage.status, 400);
});

test('upload -> demo staging -> result, thumbnail and download; one credit deducted', async () => {
  const { token, user } = await signup();
  const res = await upload(token, { style: 'scandinavian', room_type: 'bedroom' });
  assert.equal(res.status, 200);
  assert.ok(res.body.jobId);

  const status = await waitForJob(token, res.body.jobId);
  assert.equal(status.status, 'complete', status.error);

  const results = await request(app).get(`/api/staging/results/${res.body.jobId}`).set('Authorization', `Bearer ${token}`);
  assert.equal(results.body.style, 'scandinavian');
  assert.equal(results.body.roomType, 'bedroom');
  assert.equal(results.body.results[0].model, 'demo-sample');

  // Image URLs carry a short-lived token so plain <img> tags can load them
  const img = await request(app).get(results.body.results[0].url);
  assert.equal(img.status, 200);
  assert.match(img.headers['content-type'], /image\/jpeg/);
  const bare = results.body.results[0].url.split('?')[0];
  assert.equal((await request(app).get(bare)).status, 401);
  assert.equal((await request(app).get(`${bare}?t=${token}`)).status, 401, 'session token is not an image token');

  const dl = await request(app).get(`/api/staging/download/${res.body.jobId}`).set('Authorization', `Bearer ${token}`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers['content-disposition'], /virtuestage-scandinavian-bedroom\.jpg/);

  const jobs = await request(app).get('/api/staging/jobs').set('Authorization', `Bearer ${token}`);
  assert.equal(jobs.body.jobs.length, 1);
  assert.ok(jobs.body.jobs[0].thumbnailUrl);

  const credits = await request(app).get('/api/credits').set('Authorization', `Bearer ${token}`);
  assert.equal(credits.body.credits, user.credits - 1);
});

test('auto room type falls back to living-room in demo mode', async () => {
  const { token } = await signup();
  const res = await upload(token, { room_type: 'auto' });
  assert.equal(res.status, 200);
  assert.equal(res.body.roomType, 'living-room');
  assert.equal(res.body.autoDetected, true);
  await waitForJob(token, res.body.jobId);
});

test('restage uses the original upload and costs a credit', async () => {
  const { token } = await signup();
  const first = await upload(token);
  await waitForJob(token, first.body.jobId);
  const re = await request(app).post(`/api/staging/restage/${first.body.jobId}`).set('Authorization', `Bearer ${token}`).send({ style: 'luxury' });
  assert.equal(re.status, 200);
  assert.equal((await waitForJob(token, re.body.jobId)).status, 'complete');
  const credits = await request(app).get('/api/credits').set('Authorization', `Bearer ${token}`);
  assert.equal(credits.body.credits, 1);
});

test('free users are blocked with 402 once credits run out', async () => {
  const { token } = await signup();
  for (let i = 0; i < 3; i++) {
    const res = await upload(token);
    assert.equal(res.status, 200);
    await waitForJob(token, res.body.jobId);
  }
  const res = await upload(token);
  assert.equal(res.status, 402);
  const credits = await request(app).get('/api/credits').set('Authorization', `Bearer ${token}`);
  assert.equal(credits.body.credits, 0);
});

test('in-flight jobs count against available credits', async () => {
  const { token } = await signup();
  // Spend two credits, leaving one.
  for (let i = 0; i < 2; i++) await waitForJob(token, (await upload(token)).body.jobId);
  process.env.DEMO_DELAY_MS = '500';
  try {
    const a = await upload(token);
    assert.equal(a.status, 200);
    // Job "a" is still processing and has the last credit reserved.
    const b = await upload(token);
    assert.equal(b.status, 402);
    await waitForJob(token, a.body.jobId);
  } finally {
    process.env.DEMO_DELAY_MS = '0';
  }
});

test('users cannot read each other\'s jobs or images', async () => {
  const owner = await signup();
  const other = await signup();
  const res = await upload(owner.token);
  await waitForJob(owner.token, res.body.jobId);
  const results = await request(app).get(`/api/staging/results/${res.body.jobId}`).set('Authorization', `Bearer ${owner.token}`);

  assert.equal((await request(app).get(`/api/staging/results/${res.body.jobId}`).set('Authorization', `Bearer ${other.token}`)).status, 404);
  assert.equal((await request(app).get(`/api/staging/download/${res.body.jobId}`).set('Authorization', `Bearer ${other.token}`)).status, 404);
  const bare = results.body.results[0].url.split('?')[0];
  assert.equal((await request(app).get(bare).set('Authorization', `Bearer ${other.token}`)).status, 403);
  const otherJobs = await request(app).get('/api/staging/jobs').set('Authorization', `Bearer ${other.token}`);
  assert.equal(otherJobs.body.jobs.length, 0);
});
