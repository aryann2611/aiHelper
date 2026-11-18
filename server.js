// Serves the app and its API. Run: `node server.js`. The AI provider and key come from .env (see ai.js).
// Data is saved to data.json next to this file; delete it to go back to the sample sessions.
const http = require('http');
const fs = require('fs');
const path = require('path');
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {} // OPENAI_API_KEY from .env, if the file exists
const store = require('./sessions');
const ai = require('./ai');
store.setModels(ai.provider.models.map(([id]) => id));

const DB = path.join(__dirname, 'data.json');
try { store.setData(JSON.parse(fs.readFileSync(DB, 'utf8'))); } catch {} // first run: keep sample data
// ponytail: rewrites the whole file per change; move to SQLite once there are thousands of sessions.
const save = () => fs.writeFileSync(DB, JSON.stringify(store.getData()));

const STATIC = { '/sessions.js': 'text/javascript', '/app.js': 'text/javascript', '/md.js': 'text/javascript', '/overlay.html': 'text/html; charset=utf-8' };

// Live events for the overlay window (Server-Sent Events): the current call, new lines, answers as they stream.
const listeners = new Set();
let liveId = null; // the call most recently started
const meetingAudio = new Set(); // calls the overlay is transcribing meeting audio for
const publish = (type, data) => { const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`; for (const res of listeners) res.write(msg); };
const snapshot = (s) => ({
  id: s.id, title: s.title, company: s.company, mode: s.mode, ended: s.ended, autoAnswer: s.autoAnswer, meetingAudio: meetingAudio.has(s.id),
  liveSince: s.liveSince, durationMin: s.durationMin, transcript: s.transcript.slice(-12), answers: s.answers.slice(-10),
});

// Auto Answer for meeting audio: speech arrives in pieces, so wait for a short pause, then answer if
// any piece reads like a question. The answer streams to the overlay; nobody waits on an HTTP reply.
const pendingSpeech = new Map(); // call id -> { texts, timer }
function autoAnswer(s, text) {
  const p = pendingSpeech.get(s.id) ?? { texts: [] };
  pendingSpeech.set(s.id, p);
  p.texts.push(text);
  clearTimeout(p.timer);
  p.timer = setTimeout(() => {
    pendingSpeech.delete(s.id);
    if (s.ended || !s.autoAnswer || s.mode === 'mock' || !p.texts.some(store.isQuestion)) return;
    const question = p.texts.join(' ');
    streamAnswer(null, s, question, 'auto-ai-help', ai.answerPrompt(s, resumeOf(s), question));
  }, 1500);
}
function subscribe(req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write(': connected\n\n');
  listeners.add(res);
  req.on('close', () => listeners.delete(res));
  try { if (liveId) res.write(`event: session\ndata: ${JSON.stringify(snapshot(store.get(liveId)))}\n\n`); } catch {} // live call was deleted
}
const file = (name) => fs.readFileSync(path.join(__dirname, name));
const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

function readJson(req, limit = 64e3) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > limit) { reject(new Error('Request is too large.')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('Send valid JSON.')); } });
  });
}

// Streams an answer to the caller and mirrors it to the overlay; saved with its kind when finished.
function streamAnswer(res, s, question, kind, prompt) {
  const key = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const ev = (extra) => publish('answer', { sessionId: s.id, key, question, kind, at: new Date().toISOString(), ...extra });
  ev({ text: '', done: false });
  return streamReply(res, prompt,
    (answer) => { s.answers.push({ question, answer, kind, at: new Date().toISOString() }); ev({ text: answer, done: true }); },
    (sofar) => ev({ text: sofar, done: false }),
    (error) => ev({ error, done: true }));
}

const resumeOf = (s) => { try { return s.resumeId ? store.getDoc(s.resumeId) : null; } catch { return null; } };
const text = (v, max, label) => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${label} is required.`);
  if (v.length > max) throw new Error(`${label} must be ${max} characters or fewer.`);
  return v.trim();
};

// Streams the AI's text to the browser as it arrives. Errors before the first word come back as JSON
// with a status code; errors mid-stream are appended to the text. onDone saves the finished reply;
// onProgress / onFail (optional) mirror the reply to the overlay. res is null when no browser is
// waiting (answers started by the server for meeting audio).
async function streamReply(res, prompt, onDone, onProgress = () => {}, onFail = () => {}) {
  const ac = new AbortController();
  res?.on('close', () => { if (!res.writableFinished) ac.abort(); }); // browser went away: stop paying for tokens
  const head = () => res && (res.headersSent || res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }));
  let sofar = '';
  try {
    const reply = await ai.ask(prompt, (t) => { head(); res?.write(t); onProgress((sofar += t)); }, ac.signal);
    onDone(reply);
    save();
    if (res) { head(); res.end(); }
  } catch (e) {
    if (ac.signal.aborted) return onFail('Stopped.');
    const msg = ai.errorMessage(e);
    onFail(msg);
    if (!res) return;
    if (!res.headersSent) return send(res, 502, { error: msg });
    res.end(`\n\n⚠ ${msg}`);
  }
}

async function route(req, res, u) {
  const m = u.pathname.match(/^\/api\/(sessions|documents)(?:\/(\d+))?(?:\/([a-z-]+))?$/);
  if (u.pathname === '/api/status') return send(res, 200, { ai: ai.hasCredentials(), provider: ai.provider.name, keyVar: ai.provider.keyVar, models: ai.provider.models });
  if (u.pathname === '/api/events') return subscribe(req, res);
  if (!m) return send(res, 404, { error: 'Not found.' });
  const [, kind, id, action] = m, M = req.method;

  if (kind === 'documents') {
    if (!id && M === 'GET') return send(res, 200, store.listDocs());
    if (!id && M === 'POST') {
      const body = await readJson(req, 14e6); // a PDF up to ~10 MB, base64-encoded
      if (typeof body.pdfBase64 === 'string') {
        if (!/^[A-Za-z0-9+/=]+$/.test(body.pdfBase64)) throw new Error('That PDF could not be read. Try exporting it again.');
        try { body.text = await ai.ask(ai.pdfPrompt(body.pdfBase64)); }
        catch (e) { return send(res, 502, { error: ai.errorMessage(e) }); }
      }
      const d = store.createDoc({ name: body.name, kind: body.kind, text: body.text }); save();
      return send(res, 201, d);
    }
    if (id && M === 'DELETE') { store.removeDoc(id); save(); return send(res, 200, { ok: true }); }
    return send(res, 405, { error: 'Method not allowed.' });
  }

  if (!id) {
    if (M === 'GET') return send(res, 200, store.query(Object.fromEntries(u.searchParams)));
    if (M === 'POST') { const s = store.create(await readJson(req)); save(); return send(res, 201, s); }
    return send(res, 405, { error: 'Method not allowed.' });
  }
  if (!action) {
    if (M === 'GET') return send(res, 200, store.get(id));
    if (M === 'PATCH') {
      const s = store.update(id, await readJson(req)); save();
      if (s.id === liveId) publish('session', snapshot(s)); // e.g. Auto Answer switched in the app or the overlay
      return send(res, 200, s);
    }
    if (M === 'DELETE') { store.remove(id); save(); return send(res, 200, { ok: true }); }
    return send(res, 405, { error: 'Method not allowed.' });
  }

  const s = store.get(id);
  if (M !== 'POST') return send(res, 405, { error: 'Method not allowed.' });
  switch (action) {
    case 'start': { store.start(id); save(); liveId = s.id; publish('session', snapshot(s)); return send(res, 200, s); }
    case 'end': { store.end(id); save(); meetingAudio.delete(s.id); publish('session', snapshot(s)); return send(res, 200, s); }
    case 'transcribe': { // a stretch of meeting audio (what the other people said) from the overlay
      const { audio } = await readJson(req, 3e6);
      if (typeof audio !== 'string' || audio.length < 100 || !/^[A-Za-z0-9+/=]+$/.test(audio)) throw new Error('Send the audio as base64 WAV.');
      if (s.ended) return send(res, 409, { error: 'This call has ended.' });
      if (!meetingAudio.has(s.id)) { meetingAudio.add(s.id); publish('session', snapshot(s)); } // the app now treats your mic as you
      let said;
      try { said = await ai.transcribe(audio); } catch (e) { return send(res, 502, { error: ai.errorMessage(e) }); }
      if (!said) return send(res, 200, { line: null });
      const line = store.addLine(id, { speaker: 'them', text: said.slice(0, 2000) }); save();
      publish('line', { sessionId: s.id, line });
      autoAnswer(s, line.text);
      return send(res, 201, { line });
    }
    case 'lines': {
      const line = store.addLine(id, await readJson(req)); save();
      publish('line', { sessionId: s.id, line });
      return send(res, 201, line);
    }
    case 'answer': { // kinds: Answer, Answer (auto), Chat
      const body = await readJson(req);
      const question = text(body.question, 2000, 'Question');
      const kind = ['ai-help', 'auto-ai-help', 'direct-message'].includes(body.kind) ? body.kind : 'ai-help';
      const prompt = kind === 'direct-message' ? ai.directPrompt(s, resumeOf(s), question) : ai.answerPrompt(s, resumeOf(s), question);
      return streamAnswer(res, s, question, kind, prompt);
    }
    case 'screenshot': {
      const { image } = await readJson(req, 14e6);
      if (typeof image !== 'string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) throw new Error('Send the screenshot as a PNG or JPEG data URL.');
      return streamAnswer(res, s, 'Screenshot', 'analyze-screen', ai.screenshotPrompt(s, resumeOf(s), image));
    }
    case 'notes': {
      if (!s.transcript.length) throw new Error('There is no transcript yet. Start the call first; notes are written from what was said.');
      return streamReply(res, ai.notesPrompt(s, resumeOf(s)), (notes) => { s.notes = notes; });
    }
    case 'chat': {
      const message = text((await readJson(req)).message, 2000, 'Message');
      return streamReply(res, ai.chatPrompt(s, resumeOf(s), message), (reply) => {
        const at = new Date().toISOString();
        s.chat.push({ role: 'user', content: message, at }, { role: 'assistant', content: reply, at });
      });
    }
    case 'mock-turn': {
      if (s.mode !== 'mock') throw new Error('Only mock interviews have an AI interviewer.');
      return streamReply(res, ai.mockPrompt(s, resumeOf(s)), (reply) => {
        const line = { speaker: 'them', text: reply.trim(), at: new Date().toISOString() };
        s.transcript.push(line);
        publish('line', { sessionId: s.id, line });
      });
    }
  }
  return send(res, 404, { error: 'Not found.' });
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/')) {
    try { return await route(req, res, u); }
    catch (e) { if (!res.headersSent) send(res, e.notFound ? 404 : 400, { error: e.message }); return; }
  }
  if (STATIC[u.pathname]) { res.setHeader('content-type', STATIC[u.pathname]); return res.end(file(u.pathname.slice(1))); }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end('<!doctype html>' + file('index.html')); // index.html has no doctype so it can also publish as an Artifact
}).listen(process.env.PORT || 3000, () => {
  console.log(`http://localhost:${process.env.PORT || 3000}`);
  console.log(`AI: ${ai.provider.name}${ai.hasCredentials() ? '' : ` (not set up: put your key in ${ai.provider.keyVar} in .env)`}`);
});
