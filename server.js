'use strict';
/**
 * Momentbuddy server: serves the static app and proxies ElevenLabs so the API key
 * never reaches the browser. Zero npm dependencies (Node 20+).
 *   POST /api/tts   {text}                -> audio/mpeg   (ElevenLabs text-to-speech)
 *   POST /api/sfx   {kind}                -> audio/mpeg   (ElevenLabs sound effects)
 *   POST /api/stt   raw audio body        -> {text}       (ElevenLabs Scribe speech-to-text)
 *   GET  /api/health                      -> {tts,sfx,stt,voice}
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const EL = 'https://api.elevenlabs.io';
const TTS_MODEL = 'eleven_multilingual_v2';
const STT_MODEL = 'scribe_v2';
const MAX_TTS_CHARS = 1500;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

/* Sound-effect prompts live on the server: the client only sends a fixed kind. */
const SFX = {
  ball: 'A tennis ball bouncing and a racket hitting it, short, dry, close up',
  cheer: 'A small crowd cheering and clapping warmly, short celebration',
  page: 'Book pages turning softly',
  film: 'An old film projector whirring softly with soft clicks',
  music: 'A soft acoustic guitar strum, warm and short',
  waves: 'Gentle sea waves washing on a beach',
  clink: 'Two glasses clinking, then a soft table sound',
  chime: 'A soft bright chime, three rising notes'
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };

function createApp(opts = {}) {
  const env = opts.env || process.env;
  const doFetch = opts.fetch || globalThis.fetch;
  const key = (env.ELEVENLABS_API_KEY || '').trim();
  const publicDir = opts.publicDir || path.join(__dirname, 'public');
  const perMinute = Number(env.RATE_LIMIT_PER_MIN || 20);
  const dailyChars = Number(env.DAILY_TTS_CHARS || 60000);
  const dailySfx = Number(env.DAILY_SFX_CALLS || 200);
  const dailyStt = Number(env.DAILY_STT_CALLS || 100);
  const trustProxy = env.TRUST_PROXY === '1';
  const hits = new Map();
  const day = { d: '', chars: 0, sfx: 0, stt: 0 };
  let voiceId = (env.ELEVENLABS_VOICE_ID || '').trim();
  const sfxCache = new Map();

  function today() { return new Date().toISOString().slice(0, 10); }
  function roll() { if (day.d !== today()) { day.d = today(); day.chars = 0; day.sfx = 0; day.stt = 0; } }
  function ipOf(req) {
    if (trustProxy && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
    return req.socket.remoteAddress || 'unknown';
  }
  function limited(req) {
    const now = Date.now(), ip = ipOf(req);
    const arr = (hits.get(ip) || []).filter(t => now - t < 60000);
    if (arr.length >= perMinute) { hits.set(ip, arr); return true; }
    arr.push(now); hits.set(ip, arr);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > 60000) hits.delete(k);
    return false;
  }
  function send(res, code, body, headers = {}) {
    const isBuf = Buffer.isBuffer(body);
    const out = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(code, Object.assign({
      'Content-Type': isBuf ? 'application/octet-stream' : (typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8'),
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store'
    }, headers));
    res.end(out);
  }
  function fail(res, code, msg) { send(res, code, { error: msg }); }
  function readBody(req, max) {
    return new Promise((resolve, reject) => {
      const chunks = []; let n = 0;
      req.on('data', c => { n += c.length; if (n > max) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); return; } chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }
  /* Map upstream failures to short, user-readable messages. Never echo upstream bodies or the key. */
  function upstreamMsg(status) {
    if (status === 401 || status === 403) return 'The voice service rejected the server key. The owner needs to check the ElevenLabs API key.';
    if (status === 402 || status === 429) return 'The voice service is out of credits or busy. Try again later.';
    if (status === 422 || status === 400) return 'The voice service could not process this request.';
    return 'The voice service is not available right now.';
  }
  async function getVoice() {
    if (voiceId) return voiceId;
    const r = await doFetch(EL + '/v2/voices?category=premade&page_size=10', { headers: { 'xi-api-key': key } });
    if (!r.ok) throw Object.assign(new Error('voices'), { upstream: r.status });
    const j = await r.json();
    const v = (j.voices || [])[0];
    if (!v) throw Object.assign(new Error('no voice'), { upstream: 404 });
    voiceId = v.voice_id; return voiceId;
  }

  async function handleApi(req, res, url) {
    if (url.pathname === '/api/health' && req.method === 'GET') {
      return send(res, 200, { tts: !!key, sfx: !!key, stt: !!key, kinds: Object.keys(SFX) });
    }
    if (!key) return fail(res, 503, 'Voice is not configured on this server (no ElevenLabs key). The app falls back to the browser voice.');
    if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
    if (limited(req)) return fail(res, 429, 'Too many requests. Wait a minute and try again.');
    roll();
    try {
      if (url.pathname === '/api/tts') {
        const body = JSON.parse((await readBody(req, 20000)).toString('utf8') || '{}');
        const text = typeof body.text === 'string' ? body.text.replace(/\s+/g, ' ').trim() : '';
        if (!text) return fail(res, 400, 'Text is required.');
        if (text.length > MAX_TTS_CHARS) return fail(res, 413, 'Text is too long (max ' + MAX_TTS_CHARS + ' characters).');
        if (day.chars + text.length > dailyChars) return fail(res, 429, 'Daily voice limit reached for this demo. Try again tomorrow.');
        const vid = await getVoice();
        const r = await doFetch(EL + '/v1/text-to-speech/' + encodeURIComponent(vid) + '?output_format=mp3_44100_64', {
          method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
          body: JSON.stringify({ text, model_id: TTS_MODEL, voice_settings: { stability: 0.5, similarity_boost: 0.75 } })
        });
        if (!r.ok) return fail(res, r.status === 429 || r.status === 402 ? 429 : 502, upstreamMsg(r.status));
        day.chars += text.length;
        return send(res, 200, Buffer.from(await r.arrayBuffer()), { 'Content-Type': 'audio/mpeg' });
      }
      if (url.pathname === '/api/sfx') {
        const body = JSON.parse((await readBody(req, 2000)).toString('utf8') || '{}');
        const kind = body.kind;
        if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(SFX, kind)) return fail(res, 400, 'Unknown sound kind.');
        if (sfxCache.has(kind)) return send(res, 200, sfxCache.get(kind), { 'Content-Type': 'audio/mpeg' });
        if (day.sfx >= dailySfx) return fail(res, 429, 'Daily sound-effect limit reached for this demo.');
        const r = await doFetch(EL + '/v1/sound-generation?output_format=mp3_44100_64', {
          method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: SFX[kind], duration_seconds: 3, prompt_influence: 0.5 })
        });
        if (!r.ok) return fail(res, r.status === 429 || r.status === 402 ? 429 : 502, upstreamMsg(r.status));
        day.sfx += 1;
        const buf = Buffer.from(await r.arrayBuffer());
        sfxCache.set(kind, buf); /* effects are fixed per kind: generate once, reuse for every visitor */
        return send(res, 200, buf, { 'Content-Type': 'audio/mpeg' });
      }
      if (url.pathname === '/api/stt') {
        const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (!/^(audio|video)\/(webm|ogg|mp4|mpeg|wav|x-wav|m4a|x-m4a|aac)$/.test(ct)) return fail(res, 415, 'Send audio as webm, ogg, mp4, mp3 or wav.');
        if (day.stt >= dailyStt) return fail(res, 429, 'Daily voice-note limit reached for this demo.');
        const audio = await readBody(req, MAX_AUDIO_BYTES);
        if (audio.length < 200) return fail(res, 400, 'The recording is empty.');
        const form = new FormData();
        form.append('model_id', STT_MODEL);
        form.append('tag_audio_events', 'false');
        form.append('file', new Blob([audio], { type: ct }), 'note.' + (ct.split('/')[1] || 'webm'));
        const r = await doFetch(EL + '/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': key }, body: form });
        if (!r.ok) return fail(res, r.status === 429 || r.status === 402 ? 429 : 502, upstreamMsg(r.status));
        day.stt += 1;
        const j = await r.json();
        return send(res, 200, { text: String(j.text || '').trim().slice(0, 4000), language: j.language_code || null });
      }
      return fail(res, 404, 'Not found');
    } catch (e) {
      if (e && e.code === 413) return fail(res, 413, 'Request too large.');
      if (e instanceof SyntaxError) return fail(res, 400, 'Invalid JSON.');
      if (e && e.upstream) return fail(res, 502, upstreamMsg(e.upstream));
      return fail(res, 502, 'The voice service could not be reached.');
    }
  }

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Method not allowed');
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    const file = path.normalize(path.join(publicDir, p));
    if (file !== publicDir && !file.startsWith(publicDir + path.sep)) return fail(res, 403, 'Forbidden');
    fs.readFile(file, (err, data) => {
      if (err) return fail(res, 404, 'Not found');
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=()',
        'Cache-Control': 'no-cache'
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  }

  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return fail(res, 400, 'Bad request'); }
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    return serveStatic(req, res, url);
  });
  return { server, _state: { hits, day } };
}

module.exports = { createApp, SFX, TTS_MODEL, STT_MODEL };

if (require.main === module) {
  try { process.loadEnvFile && fs.existsSync('.env') && process.loadEnvFile('.env'); } catch { /* ignore */ }
  const { server } = createApp();
  const port = Number(process.env.PORT || 3000);
  server.listen(port, () => {
    console.log('Momentbuddy on http://localhost:' + port + (process.env.ELEVENLABS_API_KEY ? '  (ElevenLabs voice on)' : '  (no ELEVENLABS_API_KEY: browser voice only)'));
  });
}
