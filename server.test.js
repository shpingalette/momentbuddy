'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createApp, SFX } = require('../server.js');

const SECRET = 'sk_test_SECRET_VALUE_123';
function mockFetch(log, status = 200) {
  return async (url, init) => {
    log.push({ url: String(url), init });
    if (String(url).includes('/v2/voices')) return new Response(JSON.stringify({ voices: [{ voice_id: 'voice123', name: 'V' }] }), { status: 200 });
    if (String(url).includes('speech-to-text')) return new Response(JSON.stringify({ text: ' hello there ', language_code: 'eng' }), { status });
    if (status !== 200) return new Response(JSON.stringify({ detail: { message: 'upstream detail with ' + SECRET } }), { status });
    return new Response(Buffer.from('MP3DATA'), { status: 200 });
  };
}
async function start(env = {}, fetchImpl) {
  const log = [];
  const { server } = createApp({ env: Object.assign({ ELEVENLABS_API_KEY: SECRET, RATE_LIMIT_PER_MIN: '1000' }, env), fetch: fetchImpl || mockFetch(log), publicDir: path.join(__dirname, '..', 'public') });
  await new Promise(r => server.listen(0, r));
  const base = 'http://127.0.0.1:' + server.address().port;
  return { base, log, close: () => new Promise(r => server.close(r)) };
}
const post = (base, p, body, headers = { 'Content-Type': 'application/json' }) =>
  fetch(base + p, { method: 'POST', headers, body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body) });

test('health reflects whether a key is configured', async () => {
  const a = await start(); const b = await start({ ELEVENLABS_API_KEY: '' });
  assert.equal((await (await fetch(a.base + '/api/health')).json()).tts, true);
  assert.equal((await (await fetch(b.base + '/api/health')).json()).tts, false);
  await a.close(); await b.close();
});

test('tts: calls ElevenLabs with the server key and returns audio, key never in response', async () => {
  const s = await start();
  const r = await post(s.base, '/api/tts', { text: 'Hello   world' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'audio/mpeg');
  assert.equal(Buffer.from(await r.arrayBuffer()).toString(), 'MP3DATA');
  const call = s.log.find(c => c.url.includes('/text-to-speech/voice123'));
  assert.ok(call, 'used the voice from /v2/voices');
  assert.equal(call.init.headers['xi-api-key'], SECRET);
  const sent = JSON.parse(call.init.body);
  assert.equal(sent.model_id, 'eleven_multilingual_v2');
  assert.equal(sent.text, 'Hello world');
  await s.close();
});

test('tts: validates input', async () => {
  const s = await start();
  assert.equal((await post(s.base, '/api/tts', { text: '' })).status, 400);
  assert.equal((await post(s.base, '/api/tts', { text: 'x'.repeat(1501) })).status, 413);
  assert.equal((await post(s.base, '/api/tts', '{bad json')).status, 400);
  assert.equal((await fetch(s.base + '/api/tts')).status, 405);
  await s.close();
});

test('upstream errors are mapped to clear messages and never leak the key or upstream body', async () => {
  const log = [];
  const s = await start({}, mockFetch(log, 401));
  const r = await post(s.base, '/api/tts', { text: 'Hi' });
  const body = await r.text();
  assert.equal(r.status, 502);
  assert.ok(!body.includes(SECRET) && !body.includes('upstream detail'));
  assert.match(JSON.parse(body).error, /API key/);
  await s.close();
});

test('no key: voice endpoints answer 503 with a readable message', async () => {
  const s = await start({ ELEVENLABS_API_KEY: '' });
  const r = await post(s.base, '/api/tts', { text: 'Hi' });
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /not configured/);
  await s.close();
});

test('rate limit per IP', async () => {
  const s = await start({ RATE_LIMIT_PER_MIN: '2' });
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await post(s.base, '/api/tts', { text: 'Hi' })).status);
  assert.deepEqual(codes, [200, 200, 429, 429]);
  await s.close();
});

test('daily character cap', async () => {
  const s = await start({ DAILY_TTS_CHARS: '10' });
  assert.equal((await post(s.base, '/api/tts', { text: '12345678' })).status, 200);
  assert.equal((await post(s.base, '/api/tts', { text: '12345678' })).status, 429);
  await s.close();
});

test('sfx: only fixed kinds, prompts stay on the server, results are cached', async () => {
  const s = await start();
  assert.equal((await post(s.base, '/api/sfx', { kind: 'rm -rf' })).status, 400);
  assert.equal((await post(s.base, '/api/sfx', { kind: '__proto__' })).status, 400);
  assert.equal((await post(s.base, '/api/sfx', { kind: 'ball' })).status, 200);
  assert.equal((await post(s.base, '/api/sfx', { kind: 'ball' })).status, 200);
  const calls = s.log.filter(c => c.url.includes('/sound-generation'));
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].init.body).text, SFX.ball);
  await s.close();
});

test('stt: accepts audio, forwards to Scribe v2, rejects other types', async () => {
  const s = await start();
  const audio = new Uint8Array(500).fill(1);
  const r = await post(s.base, '/api/stt', audio, { 'Content-Type': 'audio/webm;codecs=opus' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { text: 'hello there', language: 'eng' });
  const call = s.log.find(c => c.url.endsWith('/v1/speech-to-text'));
  assert.equal(call.init.headers['xi-api-key'], SECRET);
  assert.equal(call.init.body.get('model_id'), 'scribe_v2');
  assert.equal((await post(s.base, '/api/stt', audio, { 'Content-Type': 'text/html' })).status, 415);
  assert.equal((await post(s.base, '/api/stt', new Uint8Array(10), { 'Content-Type': 'audio/webm' })).status, 400);
  await s.close();
});

test('stt: oversized upload is rejected', async () => {
  const s = await start();
  const r = await post(s.base, '/api/stt', new Uint8Array(8 * 1024 * 1024 + 10), { 'Content-Type': 'audio/webm' }).catch(e => e);
  assert.ok(r instanceof Error || r.status === 413);
  await s.close();
});

test('static: serves the app, blocks path traversal, no key in served files', async () => {
  const s = await start();
  const html = await (await fetch(s.base + '/')).text();
  assert.match(html, /Momentbuddy/);
  assert.ok(!html.includes(SECRET));
  assert.ok(!/sk_[a-z]+_[A-Za-z0-9]{10,}|sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}/.test(html), 'no key-like strings in client code');
  const t = await fetch(s.base + '/..%2fserver.js');
  assert.notEqual(t.status, 200);
  assert.equal((await fetch(s.base + '/nope.txt')).status, 404);
  await s.close();
});
