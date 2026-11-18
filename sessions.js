// Store for sessions and documents: sample data, search query, create/edit/delete with validation,
// and the call lifecycle (start, transcript lines, end). Shared by server.js and index.html
// (when no server is reachable).
(function (root) {
  const MODES = ['interview', 'regular', 'mock'];
  let MODELS = ['gpt-5.5', 'gpt-5.4-mini', 'gpt-5.4-nano']; // replaced by the active provider's list via setModels
  const LANGS = ['en-US', 'en-GB', 'en-IN', 'hi-IN', 'es-ES', 'fr-FR', 'de-DE', 'pt-BR'];
  const KINDS = ['resume', 'document'];
  const ROLES = ['Backend Engineer', 'Data Analyst', 'Product Manager', 'ML Engineer', 'Designer', 'DevOps Engineer', 'QA Lead'];
  const COMPANIES = ['Stripe', 'Google', 'Notion', 'Razorpay', 'Swiggy', 'Atlassian', 'Figma'];
  const TOPICS = ['system design and caching', 'SQL window functions', 'roadmap prioritisation', 'model evaluation metrics', 'design critique', 'CI/CD rollbacks', 'test strategy'];

  const blank = () => ({
    notes: '', context: '', mode: 'interview', model: MODELS[0], language: 'en-US', autoAnswer: true, resumeId: null,
    ended: false, activated: false, durationMin: null, liveSince: null, endedAt: null, transcript: [], answers: [], chat: [],
  });

  function sample(now = Date.now()) {
    return Array.from({ length: 35 }, (_, i) => {
      const ended = i < 32; // newest 3 are still active, one per type
      const createdAt = new Date(ended ? now - (35 - i) * 864e5 : now - (35 - i) * 9e5).toISOString();
      return {
        ...blank(),
        id: i + 1,
        mode: i % 5 === 4 ? 'mock' : i % 3 === 2 ? 'regular' : 'interview',
        title: ROLES[i % ROLES.length],
        company: COMPANIES[(i * 3) % COMPANIES.length],
        notes: `Discussed ${TOPICS[(i * 2) % TOPICS.length]}. Follow up on round ${(i % 4) + 1}.`,
        createdAt,
        ended,
        activated: i < 34, // the newest one hasn't been joined yet
        durationMin: ended ? 18 + ((i * 7) % 40) : null,
        liveSince: !ended && i < 34 ? createdAt : null,
        endedAt: ended ? createdAt : null,
      };
    });
  }
  let rows = sample(), docs = [];

  const byNewest = (a, b) => b.createdAt.localeCompare(a.createdAt);
  const SORTS = {
    status: (a, b) => a.ended - b.ended || byNewest(a, b), // active first; the default
    createdAt_desc: byNewest,
    createdAt_asc: (a, b) => -byNewest(a, b),
    title_asc: (a, b) => a.title.localeCompare(b.title),
    title_desc: (a, b) => b.title.localeCompare(a.title),
  };

  // Placeholder is "Search by role or company", so only those fields are matched.
  // Single case-insensitive substring, same style as their client-side AnswerPicker filter.
  const SEARCH_FIELDS = ['title', 'company'];

  // List rows leave out the heavy per-call data.
  const summary = ({ transcript, answers, chat, ...s }) => ({ ...s, lines: transcript.length });

  function query({ search = '', sort = 'status', limit = 10, cursor = 0, mode = '' } = {}) {
    const term = String(search).trim().toLowerCase();
    const all = rows
      .filter((s) => !MODES.includes(mode) || s.mode === mode)
      .filter((s) => !term || SEARCH_FIELDS.map((f) => s[f]).join(' ').toLowerCase().includes(term))
      .sort(SORTS[sort] || SORTS.status);
    const start = Math.max(0, Number(cursor) || 0);
    const end = start + Math.min(50, Math.max(1, Number(limit) || 10));
    return {
      data: all.slice(start, end).map(summary),
      nextCursor: end < all.length ? end : null,
      totalCount: all.length,
      statusCounts: { active: all.filter((s) => !s.ended).length, ended: all.filter((s) => s.ended).length },
    };
  }

  // Validates user input (server trust boundary). `partial` allows a subset of fields for edits.
  const TEXT = {
    title: { max: 80, required: true, label: 'Role' },
    company: { max: 80, required: true, label: 'Company' },
    notes: { max: 20000, label: 'Notes' },
    context: { max: 6000, label: 'Context' },
  };
  function clean(input, partial) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Send the session as a JSON object.');
    const out = {};
    for (const [key, f] of Object.entries(TEXT)) {
      if (input[key] === undefined) { if (!partial && f.required) throw new Error(`${f.label} is required.`); continue; }
      if (typeof input[key] !== 'string') throw new Error(`${f.label} must be text.`);
      const v = input[key].trim();
      if (!v && f.required) throw new Error(`${f.label} can't be empty.`);
      if (v.length > f.max) throw new Error(`${f.label} must be ${f.max} characters or fewer.`);
      out[key] = v;
    }
    const pick = (key, list, msg) => {
      if (input[key] === undefined) return;
      if (!list.includes(input[key])) throw new Error(msg);
      out[key] = input[key];
    };
    pick('mode', MODES, 'Type must be interview, regular or mock.');
    pick('model', MODELS, 'Choose one of the listed AI models.');
    pick('language', LANGS, 'Choose one of the listed languages.');
    if (input.autoAnswer !== undefined) {
      if (typeof input.autoAnswer !== 'boolean') throw new Error('Auto-answer must be on or off.');
      out.autoAnswer = input.autoAnswer;
    }
    if (input.resumeId !== undefined) {
      if (input.resumeId !== null && !docs.some((d) => d.id === input.resumeId)) throw new Error('That resume no longer exists. Pick another one.');
      out.resumeId = input.resumeId;
    }
    return out;
  }

  function find(id) {
    const s = rows.find((r) => r.id === Number(id));
    if (!s) throw Object.assign(new Error('Session not found.'), { notFound: true });
    return s;
  }
  const nextId = (list) => list.reduce((m, r) => Math.max(m, r.id), 0) + 1;

  function create(input) {
    const s = { ...blank(), ...clean(input, false), id: nextId(rows), createdAt: new Date().toISOString() };
    rows.push(s);
    return s;
  }
  const update = (id, patch) => Object.assign(find(id), clean(patch, true));
  function remove(id) { const s = find(id); rows = rows.filter((r) => r !== s); return s; }

  /* ---- call lifecycle ---- */
  function start(id) {
    const s = find(id);
    if (!s.liveSince || s.ended) s.liveSince = new Date().toISOString(); // rejoining an ended call reopens it
    Object.assign(s, { activated: true, ended: false, endedAt: null });
    return s;
  }
  function end(id) {
    const s = find(id);
    if (s.ended) return s;
    const ms = s.liveSince ? Date.now() - Date.parse(s.liveSince) : 0;
    Object.assign(s, {
      ended: true, endedAt: new Date().toISOString(), liveSince: null,
      durationMin: Math.max(1, Math.round((s.durationMin || 0) + ms / 6e4)), // time adds up across rejoins
    });
    return s;
  }
  function addLine(id, input) {
    const s = find(id);
    const { speaker, text } = input || {};
    if (speaker !== 'them' && speaker !== 'me') throw new Error('Speaker must be "them" or "me".');
    if (typeof text !== 'string' || !text.trim()) throw new Error('Line text is required.');
    if (text.length > 2000) throw new Error('A single line must be 2000 characters or fewer.');
    if (s.transcript.length >= 5000) throw new Error('This transcript is full. Start a new session.');
    const line = { speaker, text: text.trim(), at: new Date().toISOString() };
    s.transcript.push(line);
    return line;
  }

  /* ---- documents (resumes, job specs) ---- */
  const docSummary = ({ text, ...d }) => ({ ...d, chars: text.length, preview: text.slice(0, 180) });
  const listDocs = () => docs.slice().sort(byNewest).map(docSummary);
  function getDoc(id) {
    const d = docs.find((x) => x.id === Number(id));
    if (!d) throw Object.assign(new Error('Document not found.'), { notFound: true });
    return d;
  }
  function createDoc(input) {
    const { name, kind, text } = input || {};
    if (typeof name !== 'string' || !name.trim()) throw new Error('Name is required.');
    if (name.trim().length > 120) throw new Error('Name must be 120 characters or fewer.');
    if (!KINDS.includes(kind)) throw new Error('Kind must be resume or document.');
    if (typeof text !== 'string' || !text.trim()) throw new Error('The document has no text. Paste the text or upload a .txt, .md or .pdf file.');
    if (text.length > 60000) throw new Error('The document is too long (over 60,000 characters). Trim it and try again.');
    const d = { id: nextId(docs), name: name.trim(), kind, text: text.trim(), createdAt: new Date().toISOString() };
    docs.push(d);
    return docSummary(d);
  }
  function removeDoc(id) {
    const d = getDoc(id);
    docs = docs.filter((x) => x !== d);
    for (const s of rows) if (s.resumeId === d.id) s.resumeId = null;
    return docSummary(d);
  }

  // Does speech read like a question or a request to answer? Any sentence counts, after filler words
  // ("Okay. So what…", "Great, thanks. Walk me through…"). Used for Auto Answer by the app and the server.
  const ASKS = /^(?:(?:so|and|okay|ok|alright|now|well|great|cool|right|next|then|also|um|uh|perfect|nice|thanks)[,.!]?\s+)*(?:what|why|how|when|where|who|which|can|could|would|will|should|do|does|did|have|has|is|are|was|were|tell (?:me|us)|talk (?:me|us) through|walk (?:me|us)|describe|explain|give (?:me|us)|share|let['’]s (?:talk|discuss)|i['’]d (?:like|love) to (?:hear|know)|i want to (?:hear|know)|i['’]m curious)\b/i;
  const isQuestion = (t) => String(t).trim().split(/(?<=[.?!])\s+/).some((x) => /\?$/.test(x) || ASKS.test(x));

  const api = {
    query, create, update, remove, get: find, start, end, addLine, isQuestion,
    listDocs, getDoc, createDoc, removeDoc,
    MODES, LANGS, KINDS,
    setModels: (ids) => { MODELS = ids; for (const s of rows) if (!MODELS.includes(s.model)) s.model = MODELS[0]; },
    getData: () => ({ sessions: rows, documents: docs }),
    setData: (d) => {
      // Sessions saved with a model that is no longer offered fall back to the default.
      if (Array.isArray(d?.sessions)) rows = d.sessions.map((s) => ({ ...blank(), ...s, model: MODELS.includes(s.model) ? s.model : MODELS[0] }));
      if (Array.isArray(d?.documents)) docs = d.documents;
    },
    reset: () => { rows = sample(); docs = []; },
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SessionsDB = api;
})(globalThis);
