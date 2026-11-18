/* aiHelper: sessions list + search, session panel
   (AI notes, transcript, Ask AI, details), live call assistant, mock interviews and documents.
   Talks to server.js. Without it (static hosting) the list and documents run on the in-page store
   and the AI and live features are switched off. */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const ICON = {
  cal: svg('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  chev: svg('<path d="m6 9 6 6 6-6"/>'),
  dots: svg('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'),
  x: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  searchX: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M8.5 8.5l5 5M13.5 8.5l-5 5"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  alert: svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>'),
  back: svg('<path d="m15 18-6-6 6-6"/>'),
  mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
  notes: svg('<path d="M4 4h16v16H4zM8 9h8M8 13h8M8 17h5"/>'),
  file: svg('<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4M9 13h6M9 17h6"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
};
// Page titles, nav items and empty states.
const TABS = { interview: 'Interviews', regular: 'Regular calls', mock: 'Mock interviews' };
const TYPE = { interview: 'Interview', regular: 'Regular call', mock: 'Mock interview' };
const EMPTY = {
  interview: ['No interviews yet', 'Sessions you create as an interview show up here.'],
  regular: ['No regular calls yet', 'Sessions you create as a regular call show up here.'],
  mock: ['No mock interviews yet', 'Practice runs with the AI interviewer show up here.'],
};
const PANES = { notes: 'AI notes', transcript: 'Transcript', chat: 'Ask AI', details: 'Call details' };
// Replaced by the server's active provider and models at startup (see /api/status).
let MODEL_LABEL = { 'gpt-5.5': 'GPT-5.5 (best answers)', 'gpt-5.4-mini': 'GPT-5.4 mini (balanced)', 'gpt-5.4-nano': 'GPT-5.4 nano (fastest)' };
let provider = { provider: 'The AI provider', keyVar: 'the API key' };
const LANG_LABEL = { 'en-US': 'English (US)', 'en-GB': 'English (UK)', 'en-IN': 'English (India)', 'hi-IN': 'Hindi', 'es-ES': 'Spanish', 'fr-FR': 'French', 'de-DE': 'German', 'pt-BR': 'Portuguese (Brazil)' };
const NEEDS_SERVER = 'This needs the app running on your computer: start node server.js with your AI key and open http://localhost:3000.';
const createLabel = (m) => (m === 'mock' ? 'Create mock interview' : 'Create session');

let server = false, aiReady = false, view = 'list', mode = 'interview';
let current = null, pane = 'notes', docsCache = [];
const busy = { notes: false, chat: false };
let term = '', pages = [], seq = 0, loading = true, error = false, fetchingMore = false, pollTimer, typing, toastTimer, menuFor = null;
let collapsed = [];                          // section keys collapsed while not searching (kept)
let searchCollapsed = { term: '', keys: [] }; // collapsed keys for the current search only

/* ================= data access ================= */
// Without server.js the same store runs here and saves to this browser only.
const LOCAL_KEY = 'interview-sessions-v2';
function loadLocal() { try { const d = JSON.parse(localStorage.getItem(LOCAL_KEY)); if (d) SessionsDB.setData(d); } catch {} }
function saveLocal() { try { localStorage.setItem(LOCAL_KEY, JSON.stringify(SessionsDB.getData())); } catch {} }

async function api(method, path, body) {
  if (!server) return localApi(method, path, body);
  const r = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body && JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `The server returned ${r.status}. Try again.`);
  return j;
}
function localApi(method, path, body) {
  const DB = SessionsDB, m = path.match(/^\/api\/(sessions|documents)(?:\/(\d+))?$/);
  if (!m) throw new Error(NEEDS_SERVER);
  const [, kind, id] = m;
  const out = kind === 'documents'
    ? (method === 'GET' ? DB.listDocs() : method === 'POST' ? DB.createDoc(body) : DB.removeDoc(id))
    : (method === 'GET' ? DB.get(id) : method === 'POST' ? DB.create(body) : method === 'PATCH' ? DB.update(id, body) : DB.remove(id));
  if (method !== 'GET') saveLocal();
  return JSON.parse(JSON.stringify(out));
}

// POSTs and reads the AI's reply as it streams in; onText gets the text so far.
async function streamPost(path, body, onText, signal) {
  if (!server) throw new Error(NEEDS_SERVER);
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), signal });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `The server returned ${r.status}. Try again.`); }
  const reader = r.body.getReader(), dec = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
    onText(text);
  }
  return text + dec.decode();
}

/* ================= helpers ================= */
function toast(msg) {
  $('toast').textContent = msg; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => ($('toast').hidden = true), 3200);
}
function dateLabel(iso) {
  const d = new Date(iso), days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 864e5);
  if (days === 0 || days === 1) return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-days, 'day');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}
const timeLabel = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const usage = (s) => (s.ended ? `${s.durationMin} min` : s.activated ? 'In progress' : 'No usage yet');
const themLabel = () => (current?.mode === 'regular' ? 'Them' : 'Interviewer');
const findRow = (id) => pages.flatMap((p) => p.data).find((s) => s.id === id);

const stateBlock = (icon, title, text, action = '') =>
  `<div class="state"><div class="icon">${icon}</div><b>${title}</b>${text ? `<p>${text}</p>` : ''}${action}</div>`;
const dlg = $('dlg');
const head = (title) => `<div class="dlg-head"><h2>${title}</h2><button type="button" class="icon-btn" data-close aria-label="Close">${ICON.x}</button></div>`;
function show(html) { dlg.innerHTML = html; if (!dlg.open) dlg.showModal(); }
function confirmDialog({ title, text, ok, cancel = 'Cancel' }) {
  return new Promise((resolve) => {
    show(`<h2>${title}</h2><p>${text}</p><div class="dlg-actions"><button class="btn" data-close>${cancel}</button><button class="btn danger" id="c-ok">${ok}</button></div>`);
    $('c-ok').addEventListener('click', () => { resolve(true); dlg.close(); });
    dlg.addEventListener('close', () => resolve(false), { once: true });
  });
}

/* ================= views ================= */
function showView(v) {
  view = v;
  for (const k of ['list', 'docs', 'session', 'live']) $('view-' + k).hidden = k !== v;
  $('wrap').hidden = v === 'live';
  $('tabs').hidden = !(v === 'list' || v === 'docs');
  $('fab').hidden = v !== 'list';
  closeMenu(false);
  window.scrollTo(0, 0);
  renderTabs();
}
function renderTabs() {
  const sel = view === 'docs' ? 'docs' : mode;
  $('tabs').innerHTML = [...Object.entries(TABS), ['docs', 'Resumes &amp; documents']]
    .map(([k, v]) => `<button class="tab" role="tab" data-tab="${k}" aria-selected="${k === sel}">${v}</button>`).join('');
}
function selectTab(k) {
  if (k === 'docs') return openDocs();
  const changed = k !== mode;
  if (view !== 'list') showView('list');
  if (changed) {
    // Each type is its own list, so switching starts fresh: no search, sections open, skeletons.
    mode = k; term = ''; $('q').value = ''; collapsed = []; searchCollapsed = { term: '', keys: [] };
    pages = []; loading = true; error = false;
    reset();
  }
  renderTabs(); render();
  document.querySelector(`[data-tab="${k}"]`)?.focus();
}
function showBanner() {
  const b = $('banner');
  if (!server) b.innerHTML = '<span><b>Demo mode.</b> Search, sessions and documents work here and are saved in this browser. Live calls, AI notes, Ask AI and mock interviews run on your computer: start <code>node server.js</code> with your AI key and open <code>localhost:3000</code>.</span>';
  else b.innerHTML = `<span><b>${esc(provider.provider)} isn’t connected.</b> Put your key in <code>${esc(provider.keyVar)}</code> in the <code>.env</code> file, then restart the app. Everything except the AI features works until then.</span>`;
  b.hidden = server && aiReady;
}

/* ================= sessions list ================= */
async function fetchPage(cursor) {
  const params = { search: term, sort: $('sort').value, limit: 10, cursor, mode };
  return server ? api('GET', '/api/sessions?' + new URLSearchParams(params)) : SessionsDB.query(params);
}
// New term or sort: previous rows stay on screen until the new first page lands (like placeholderData).
async function reset() {
  const my = ++seq;
  try { const p = await fetchPage(0); if (my !== seq) return; pages = [p]; error = false; }
  catch { if (my !== seq) return; error = true; }
  loading = false; render(); schedulePoll();
}
async function loadMore() {
  const last = pages.at(-1);
  if (view !== 'list' || !last || last.nextCursor == null || fetchingMore) return;
  const my = seq; fetchingMore = true; render();
  try { const p = await fetchPage(last.nextCursor); if (my === seq) pages.push(p); } catch {}
  fetchingMore = false; render();
}
// Poll, focus, Retry and edits re-read every loaded page, as a react-query infinite refetch does.
async function refetch() {
  const my = seq, out = [];
  try {
    for (let c = 0, i = 0; i < Math.max(1, pages.length) && c != null; i++) { const p = await fetchPage(c); out.push(p); c = p.nextCursor; }
    if (my === seq) { pages = out; error = false; }
  } catch { if (my === seq) error = true; }
  loading = false; render(); schedulePoll();
}
// 30s while a session is live, 60s otherwise, times pages loaded; no polling after a failed first load.
// ponytail: no extra wake-up at each session's end time; add one if sessions expire on a clock.
function schedulePoll() {
  clearTimeout(pollTimer);
  if (error && !pages.length) return;
  const rows = pages.flatMap((p) => p.data);
  pollTimer = setTimeout(refetch, (rows.some((s) => !s.ended) ? 30e3 : 60e3) * Math.max(1, pages.length));
}
const collapsedKeys = () => (term === '' ? collapsed : searchCollapsed.term === term ? searchCollapsed.keys : []);
function toggle(key) {
  const cur = collapsedKeys(), next = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key];
  if (term === '') collapsed = next; else searchCollapsed = { term, keys: next };
  render();
}

function card(s) {
  return `<article class="card">
    <button class="card-hit" data-open="${s.id}" aria-label="Open ${esc(s.title)} at ${esc(s.company)}"></button>
    <span class="head"><span class="logo" aria-hidden="true">${esc(s.company[0] || '?')}</span>
      <span class="titles"><b>${esc(s.title)}</b><span>${esc(s.company)}</span></span></span>
    <button class="menu-btn" data-menu="${s.id}" aria-label="Actions for ${esc(s.title)} at ${esc(s.company)}" aria-haspopup="menu" aria-expanded="${menuFor === s.id}">${ICON.dots}</button>
    ${s.notes ? `<span class="notes"><span class="notes-label">AI notes</span>${esc(s.notes.replace(/[#*`]/g, ''))}</span>` : ''}
    <span class="divider"></span>
    <span class="foot">
      ${s.ended ? '<span class="pill">Ended</span>' : '<span class="pill live">live</span>'}
      <span>${ICON.cal}${dateLabel(s.createdAt)}</span>
      <span>${s.ended || s.activated ? ICON.clock : ''}${usage(s)}</span>
    </span>
  </article>`;
}

function render() {
  $('title').textContent = TABS[mode];
  $('fab-label').textContent = createLabel(mode);
  const rows = pages.flatMap((p) => p.data), last = pages.at(-1), total = last?.totalCount;
  const state = error && total === undefined ? 'error' : loading ? 'loading' : total !== 0 ? 'list' : term ? 'no-results' : 'empty';
  $('count').textContent = total === undefined ? '' : `${total.toLocaleString('en-US')} ${total === 1 ? 'Session' : 'Sessions'}`;

  let html;
  if (state === 'error') html = stateBlock(ICON.alert, "Couldn't load sessions", 'Check that the server is running, then try again.', '<button class="btn" data-retry>Retry</button>');
  else if (state === 'loading') html = `<div class="list">${'<div class="skel"></div>'.repeat(10)}</div>`;
  else if (state === 'no-results') html = stateBlock(ICON.searchX, 'No sessions found', 'Try a different search term or check the spelling.');
  else if (state === 'empty') html = stateBlock(ICON.plus, EMPTY[mode][0], EMPTY[mode][1], `<button class="btn brand" data-create>${ICON.plus}${createLabel(mode)}</button>`);
  else {
    const counts = last?.statusCounts ?? {};
    const sections = [
      { key: 'active', label: 'Active sessions', count: counts.active, sessions: rows.filter((s) => !s.ended) },
      { key: 'past', label: 'Past sessions', count: counts.ended, sessions: rows.filter((s) => s.ended) },
    ];
    // Grouped only when both sections have sessions; otherwise one flat list.
    html = sections.every((s) => (s.count ?? s.sessions.length) > 0)
      ? sections.filter((s) => s.sessions.length > 0).map((s) => {
          const open = !collapsedKeys().includes(s.key);
          return `<section class="section"><button class="section-head" data-key="${s.key}" aria-expanded="${open}">${ICON.chev}${s.label}<span class="n">${s.count ?? s.sessions.length}</span></button>
            ${open ? s.sessions.map(card).join('') : ''}</section>`;
        }).join('')
      : `<div class="list">${rows.map(card).join('')}</div>`;
  }
  // Keep keyboard focus on the same control when polling re-renders the list.
  const f = document.activeElement, keep = f && $('body').contains(f) && ['data-open', 'data-menu', 'data-key'].find((a) => f.hasAttribute(a));
  const keepVal = keep && f.getAttribute(keep);
  $('body').innerHTML = html;
  if (keep) document.querySelector(`#body [${keep}="${keepVal}"]`)?.focus();
  $('sentinel').textContent = fetchingMore ? 'Loading more sessions…' : '';
}

/* ---- actions menu ---- */
function openMenu(id, btn) {
  menuFor = id;
  const r = btn.getBoundingClientRect(), m = $('menu');
  m.hidden = false;
  m.style.top = Math.min(r.bottom + 4, innerHeight - m.offsetHeight - 8) + 'px';
  m.style.left = Math.max(8, r.right - m.offsetWidth) + 'px';
  btn.setAttribute('aria-expanded', 'true');
  m.querySelector('button').focus();
}
function closeMenu(refocus) {
  if (menuFor == null) return;
  const btn = document.querySelector(`[data-menu="${menuFor}"]`);
  btn?.setAttribute('aria-expanded', 'false');
  if (refocus) btn?.focus();
  menuFor = null; $('menu').hidden = true;
}

/* ---- create / edit: a step-by-step form ---- */
async function loadDocs() { try { docsCache = await api('GET', '/api/documents'); } catch (e) { toast(e.message); } return docsCache; }

function showForm(s) {
  const editing = !!s;
  const pick = (x) => ({ mode: x.mode, title: x.title, company: x.company, resumeId: x.resumeId, context: x.context, language: x.language, model: x.model, autoAnswer: x.autoAnswer });
  const draft = editing ? pick(s) : { mode, title: '', company: '', resumeId: null, context: '', language: 'en-US', model: Object.keys(MODEL_LABEL)[0], autoAnswer: true };
  const original = JSON.stringify(draft);
  const STEPS = ['Session', 'Resume', 'Context', 'AI settings'];
  let step = 0;
  const opts = (map, sel) => Object.entries(map).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v}</option>`).join('');

  const stepHtml = () => [
    () => `<label class="field">Type<select id="f-mode">${opts(TYPE, draft.mode)}</select></label>
      <label class="field">Role<input id="f-title" maxlength="80" value="${esc(draft.title)}" placeholder="e.g. Backend Engineer" autocomplete="off"></label>
      <label class="field">Company<input id="f-company" maxlength="80" value="${esc(draft.company)}" placeholder="e.g. Stripe" autocomplete="off"></label>`,
    () => {
      const sorted = docsCache.slice().sort((a, b) => (a.kind === 'resume' ? -1 : 0) - (b.kind === 'resume' ? -1 : 0));
      return `<label class="field">CV / Resume<select id="f-resume"><option value="">No resume</option>${sorted.map((d) =>
        `<option value="${d.id}" ${d.id === draft.resumeId ? 'selected' : ''}>${esc(d.name)} (${d.kind === 'resume' ? 'Resume' : 'Document'})</option>`).join('')}</select>
        <small>${docsCache.length ? 'The AI uses it to answer in your own words.' : 'No files yet. Add your resume under Resumes &amp; documents, then edit this session.'}</small></label>`;
    },
    () => `<label class="field">Context<textarea id="f-context" maxlength="6000" placeholder="Job spec, notes, anything the AI should know">${esc(draft.context)}</textarea></label>`,
    () => `<label class="field">Language<select id="f-language">${opts(LANG_LABEL, draft.language)}</select><small>The language you'll speak on the call.</small></label>
      <label class="field">AI model<select id="f-model">${opts(MODEL_LABEL, draft.model)}</select></label>
      ${draft.mode === 'mock' ? '' : `<label class="check"><input type="checkbox" id="f-auto" ${draft.autoAnswer ? 'checked' : ''}><span>Answer automatically<br><span class="muted small">Suggest an answer as soon as a question is detected. You can always press Answer now.</span></span></label>`}`,
  ][step]();

  const read = () => {
    const v = (id) => $(id)?.value;
    if (step === 0) Object.assign(draft, { mode: v('f-mode'), title: v('f-title'), company: v('f-company') });
    if (step === 1) draft.resumeId = v('f-resume') ? Number(v('f-resume')) : null;
    if (step === 2) draft.context = v('f-context');
    if (step === 3) Object.assign(draft, { language: v('f-language'), model: v('f-model'), autoAnswer: $('f-auto') ? $('f-auto').checked : draft.autoAnswer });
  };
  const err = (m) => { $('f-error').textContent = m; };

  const draw = () => {
    show(`<form id="session-form" novalidate>${head(editing ? 'Edit session' : createLabel(draft.mode))}
      <div class="steps" aria-hidden="true">${STEPS.map((_, i) => `<span class="${i <= step ? 'done' : ''}"></span>`).join('')}</div>
      <p class="step-label">Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}</p>
      ${stepHtml()}
      <p class="form-error" id="f-error" role="alert"></p>
      <div class="dlg-actions">
        ${step ? '<button type="button" class="btn" id="f-back">Back</button>' : '<button type="button" class="btn" data-close>Cancel</button>'}
        <button class="btn brand" id="f-submit">${step < STEPS.length - 1 ? 'Next' : editing ? 'Save changes' : createLabel(draft.mode)}</button></div></form>`);
    $('f-back')?.addEventListener('click', () => { read(); step--; draw(); });
    $('session-form').addEventListener('submit', async (e) => {
      e.preventDefault(); read();
      if (step === 0 && (!draft.title.trim() || !draft.company.trim())) return err('Add the role and company to continue.');
      if (step < STEPS.length - 1) { step++; return draw(); }
      if (editing && JSON.stringify(draft) === original) return err('No changes detected.');
      $('f-submit').disabled = true;
      try {
        const out = editing ? await api('PATCH', `/api/sessions/${s.id}`, draft) : await api('POST', '/api/sessions', draft);
        dlg.close();
        toast(editing ? 'Changes saved' : 'Session created');
        refetch();
        if (editing && view === 'session' && current?.id === out.id) { current = out; renderSession(); }
        else if (!editing) openSession(out.id);
      } catch (e2) { err(e2.message); $('f-submit').disabled = false; }
    });
    (dlg.querySelector('input:not([type=checkbox]),select,textarea'))?.focus();
  };
  draw();
  loadDocs().then(() => { if (dlg.open && step === 1) { read(); draw(); } });
}

async function deleteSession(id) {
  if (!(await confirmDialog({ title: 'Are you sure you want to delete this session?', text: 'This action cannot be undone and you will lose all your information.', ok: 'Delete session' }))) return;
  try { await api('DELETE', `/api/sessions/${id}`); } catch (e) { return toast(e.message); }
  toast('Session deleted');
  if (view === 'session' && current?.id === id) { current = null; showView('list'); }
  refetch();
}

/* ================= session panel ================= */
async function openSession(id, p = 'notes') {
  try { current = await api('GET', `/api/sessions/${id}`); } catch (e) { return toast(e.message); }
  pane = p; showView('session'); renderSession();
  loadDocs().then(() => { if (view === 'session' && pane === 'details') renderSession(); });
}
const lineHtml = (l) => `<div class="line ${l.speaker}"><span class="who">${l.speaker === 'me' ? 'Me' : themLabel()}<br><span class="tnum">${timeLabel(l.at)}</span></span><span class="t">${esc(l.text)}</span></div>`;
const msgHtml = (m) => `<div class="msg ${m.role}">${m.role === 'assistant' ? `<div class="md">${md(m.content)}</div>` : esc(m.content)}</div>`;

function renderSession() {
  const s = current, mock = s.mode === 'mock';
  const startLabel = mock ? (s.transcript.length ? 'Continue mock interview' : 'Start mock interview')
    : !s.ended && s.activated ? 'Rejoin call' : s.transcript.length ? 'Continue call' : 'Start call';
  $('view-session').innerHTML = `
    <button class="back" data-back>${ICON.back}Sessions</button>
    <header class="s-head">
      <span class="logo" aria-hidden="true">${esc(s.company[0])}</span>
      <div class="titles"><h1>${esc(s.title)}</h1><span>${esc(s.company)} · ${TYPE[s.mode]} · ${s.ended ? 'Ended' : s.activated ? 'Active' : 'Not started'}</span></div>
      <div class="s-actions"><button class="btn" data-edit-current>Edit</button><button class="btn brand" data-start>${ICON.mic}${startLabel}</button></div>
    </header>
    <nav class="tabs pane-tabs" role="tablist" aria-label="Session">${Object.entries(PANES).map(([k, v]) =>
      `<button class="tab" role="tab" data-pane="${k}" aria-selected="${k === pane}">${v}</button>`).join('')}</nav>
    <div class="pane" id="pane">${paneHtml()}</div>`;
}

function paneHtml() {
  const s = current;
  if (pane === 'notes') {
    if (busy.notes) return '<div class="md" id="notes-out"><p class="muted">Generating AI notes…</p></div>';
    if (s.notes) return `<div class="pane-actions">${s.transcript.length ? '<button class="btn" data-gen-notes>Regenerate</button>' : ''}<button class="btn" data-clear-notes>Clear notes</button></div><div class="md">${md(s.notes)}</div>`;
    return s.transcript.length
      ? stateBlock(ICON.notes, 'AI notes haven’t been generated yet', 'Get a summary, the questions asked and follow-ups from this call.', '<button class="btn brand" data-gen-notes>Generate AI notes</button>')
      : stateBlock(ICON.notes, 'No AI notes yet', 'Start the call first. Notes are written from the transcript.');
  }
  if (pane === 'transcript') {
    return s.transcript.length ? `<div class="lines">${s.transcript.map(lineHtml).join('')}</div>`
      : stateBlock(ICON.mic, 'No transcript yet', 'Start the call and the conversation is written down here as it happens.');
  }
  if (pane === 'chat') {
    const chips = ['Summarize this call', 'What should I follow up on?', 'Which answer could have been better, and how?'];
    return `<div class="chat" id="chat">${s.chat.length ? s.chat.map(msgHtml).join('')
      : `<p class="muted">Ask anything about this call. The AI reads the transcript, notes, resume and context.</p><div class="chips">${chips.map((c) => `<button class="chip" data-ask="${esc(c)}">${c}</button>`).join('')}</div>`}</div>
      <form class="inline-form" id="chat-form"><input id="chat-input" class="text-input" maxlength="2000" placeholder="Ask anything about this call" autocomplete="off" aria-label="Ask about this call"><button class="btn brand" ${busy.chat ? 'disabled' : ''}>Ask</button></form>`;
  }
  const resume = docsCache.find((d) => d.id === s.resumeId);
  const facts = [
    ['Role', s.title], ['Company', s.company], ['Type', TYPE[s.mode]], ['Status', s.ended ? 'Ended' : s.activated ? 'Active' : 'Not started'],
    ['Created', new Date(s.createdAt).toLocaleString()], ['Usage', usage(s)], ['Language', LANG_LABEL[s.language]], ['AI model', MODEL_LABEL[s.model] ?? s.model],
    ...(s.mode === 'mock' ? [] : [['Auto-answer', s.autoAnswer ? 'On' : 'Off']]),
    ['CV / Resume', resume ? resume.name : s.resumeId ? 'Loading…' : 'None'], ['Context', s.context || 'None'],
  ];
  return `<dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
}

async function generateNotes() {
  if (!server) return toast(NEEDS_SERVER);
  busy.notes = true; pane = 'notes';
  if (view === 'session') renderSession();
  try {
    await streamPost(`/api/sessions/${current.id}/notes`, {}, (t) => { const el = $('notes-out'); if (el) el.innerHTML = md(t); });
  } catch (e) { toast(e.message); }
  busy.notes = false;
  current = await api('GET', `/api/sessions/${current.id}`).catch(() => current); // what the server actually saved
  if (view === 'session') renderSession();
  refetch();
}
async function clearNotes() {
  if (!(await confirmDialog({ title: 'Clear notes?', text: 'The generated notes will be removed from this call.', ok: 'Clear notes', cancel: 'Keep notes' }))) return;
  try { current = await api('PATCH', `/api/sessions/${current.id}`, { notes: '' }); } catch (e) { return toast(e.message); }
  toast('Notes deleted'); renderSession(); refetch();
}
async function askAI(message) {
  message = message.trim();
  if (!message || busy.chat) return;
  if (!server) return toast(NEEDS_SERVER);
  busy.chat = true;
  current.chat.push({ role: 'user', content: message }, { role: 'assistant', content: '' });
  renderSession();
  const out = document.querySelector('#chat .msg.assistant:last-child .md');
  out.innerHTML = '<p class="muted">Thinking…</p>';
  try { await streamPost(`/api/sessions/${current.id}/chat`, { message }, (t) => { out.innerHTML = md(t); }); }
  catch (e) { toast(e.message); }
  busy.chat = false;
  current = await api('GET', `/api/sessions/${current.id}`).catch(() => current);
  if (view === 'session' && pane === 'chat') { renderSession(); $('chat-input')?.focus(); }
}

/* ================= live call + mock interview ================= */
const live = { rec: null, on: false, speaker: 'them', interim: '', pending: [], pendingTimer: null, clock: null, aborts: [], voice: true, turnBusy: false, events: null };
const isQuestion = SessionsDB.isQuestion;
const setMic = (text, on = false) => { const m = $('mic'); if (m) { m.textContent = text; m.classList.toggle('on', on); } };
const scrollDown = () => { const el = $('live-scroll'); if (el) el.scrollTop = el.scrollHeight; };

async function startCall() {
  if (!server) return toast(NEEDS_SERVER);
  if (!aiReady) toast(`${provider.provider} isn’t connected, so AI answers won’t work until you add ${provider.keyVar} to .env. The transcript still works.`);
  try { current = await api('POST', `/api/sessions/${current.id}/start`); } catch (e) { return toast(e.message); }
  Object.assign(live, { speaker: 'them', interim: '', pending: [], turnBusy: false });
  showView('live'); renderLive();
  live.clock = setInterval(tick, 1000); tick();
  // Follow changes made from the overlay window: its Auto Answer switch and its Exit button.
  live.events = new EventSource('/api/events');
  live.events.addEventListener('session', (e) => {
    const s = JSON.parse(e.data);
    if (view !== 'live' || s.id !== current?.id) return;
    current.autoAnswer = s.autoAnswer;
    if ($('auto')) $('auto').checked = s.autoAnswer;
    if (s.meetingAudio && live.speaker === 'them') { // the overlay hears the meeting, so this microphone is you
      live.speaker = 'me';
      document.querySelectorAll('[data-speaker]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.speaker === 'me')));
      toast('The overlay is hearing the meeting, so your microphone now counts as you.');
    }
    if (s.ended) endCall(true);
  });
  if (current.mode !== 'mock') listen(true);
  else if (current.transcript.at(-1)?.speaker === 'them') listen(true); // continuing: answer the last question
  else interviewerTurn();
}
function tick() {
  const ms = (current.durationMin || 0) * 6e4 + (current.liveSince ? Date.now() - Date.parse(current.liveSince) : 0);
  const t = Math.floor(ms / 1000), h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, sec = String(t % 60).padStart(2, '0');
  if ($('clock')) $('clock').textContent = h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
const answerHtml = (q, body) => `<article class="answer"><p class="q">${esc(q)}</p><div class="md a">${body}</div></article>`;

function renderLive() {
  const s = current, mock = s.mode === 'mock';
  $('view-live').innerHTML = `
    <div class="live-bar">
      <div class="live-title"><span class="pill live">live</span><b>${esc(s.title)}</b><span class="muted">${esc(s.company)}</span><span id="clock" class="muted tnum">0:00</span></div>
      <div class="live-controls">
        <span id="mic" class="mic" role="status">Starting microphone…</span>
        ${mock ? `<label class="toggle"><input type="checkbox" id="voice" ${live.voice ? 'checked' : ''}> Read questions aloud</label>`
          : `<div class="seg" role="radiogroup" aria-label="Who is speaking">${['them', 'me'].map((k) =>
              `<button role="radio" data-speaker="${k}" aria-checked="${live.speaker === k}">${k === 'me' ? 'Me' : themLabel()}</button>`).join('')}</div>
             <label class="toggle"><input type="checkbox" id="auto" ${s.autoAnswer ? 'checked' : ''}> Auto-answer</label>`}
        <button class="btn danger" data-end>${mock ? 'End interview' : 'End call'}</button>
      </div>
    </div>
    <div class="live-grid">
      <section class="panel" aria-label="Transcript">
        <h2>Transcript</h2>
        <div class="panel-scroll" id="live-scroll"><div class="lines" id="live-lines">${s.transcript.map(lineHtml).join('')}</div><p class="interim" id="interim"></p></div>
        <form class="inline-form" id="line-form"><input id="line-input" class="text-input" maxlength="2000" placeholder="${mock ? 'Type your answer instead of speaking' : 'Type what was said if the mic missed it'}" autocomplete="off" aria-label="Add a line to the transcript"><button class="btn">Add</button></form>
      </section>
      ${mock ? `<section class="panel" aria-label="Your turn"><h2>Your turn</h2>
          <p class="muted">Listen to the question, answer out loud, then press <b>Next question</b>. Your answer is written down as you speak.</p>
          <div><button class="btn brand" data-next id="next-btn">Next question</button></div>
          <p class="muted small">Press <b>End interview</b> when you're done. Your feedback appears in AI notes.</p></section>`
        : `<section class="panel" aria-label="AI answers"><h2>AI answers <button class="btn brand" data-answer>Answer now <kbd>Space</kbd></button></h2>
          <div class="panel-scroll answers" id="answers">${s.answers.slice().reverse().map((a) => answerHtml(a.question, md(a.answer))).join('')
            || '<p class="muted" id="answers-empty">Suggested answers appear here when a question is asked. Set who is speaking with the switch above.</p>'}</div></section>`}
    </div>`;
  scrollDown();
}

// Chrome's built-in speech recognition. It stops after silences, so it is restarted while the call is on.
function listen(on) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return setMic('Speech recognition needs Google Chrome. Type lines below instead.');
  live.on = on;
  if (!on) { try { live.rec?.stop(); } catch {} return setMic('Microphone paused'); }
  if (!live.rec) {
    const rec = (live.rec = new SR());
    rec.continuous = true; rec.interimResults = true; rec.lang = current.language;
    rec.onresult = (e) => {
      if (!live.on) return;
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) addLiveLine(current.mode === 'mock' ? 'me' : live.speaker, r[0].transcript);
        else interim += r[0].transcript;
      }
      live.interim = interim;
      if ($('interim')) $('interim').textContent = interim;
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { live.on = false; setMic('Microphone access is blocked. Allow it from the icon in Chrome’s address bar, or type lines below.'); }
      else if (e.error === 'audio-capture') { live.on = false; setMic('No microphone found. Connect one, or type lines below.'); }
    };
    rec.onend = () => { if (live.on) try { rec.start(); } catch {} };
    // Only claim to be listening once Chrome has really opened the microphone.
    rec.onaudiostart = () => { if (live.on) setMic(current.mode === 'mock' ? 'Listening to your answer…' : 'Listening…', true); };
  }
  try { live.rec.start(); } catch {} // already running
  if (!$('mic')?.classList.contains('on')) setMic('Waiting for the microphone. If Chrome asks, click Allow.');
}

async function addLiveLine(speaker, text) {
  text = text.trim();
  if (!text) return;
  let line;
  try { line = await api('POST', `/api/sessions/${current.id}/lines`, { speaker, text }); } catch (e) { return toast(e.message); }
  current.transcript.push(line);
  $('live-lines')?.insertAdjacentHTML('beforeend', lineHtml(line));
  scrollDown();
  if (current.mode !== 'mock' && speaker === 'them') {
    // Speech arrives in pieces; wait for a short pause, then answer if it reads like a question.
    live.pending.push(line.text);
    clearTimeout(live.pendingTimer);
    live.pendingTimer = setTimeout(() => { if ($('auto')?.checked && live.pending.some(isQuestion)) answerNow('auto-ai-help'); }, 1200);
  }
}

// kind: 'ai-help' when asked for, 'auto-ai-help' when a question was detected
function answerNow(kind = 'ai-help') {
  clearTimeout(live.pendingTimer);
  const q = live.pending.join(' ').trim() || [...current.transcript].reverse().find((l) => l.speaker === 'them')?.text;
  live.pending = [];
  if (!q) return toast('Nothing to answer yet. Wait for a question, or type it below.');
  $('answers-empty')?.remove();
  $('answers').insertAdjacentHTML('afterbegin', answerHtml(q, '<p class="muted">Thinking…</p>'));
  const out = $('answers').querySelector('.answer .a');
  const ac = new AbortController();
  live.aborts.push(ac);
  streamPost(`/api/sessions/${current.id}/answer`, { question: q, kind }, (t) => { out.innerHTML = md(t); }, ac.signal)
    .catch((e) => { if (!ac.signal.aborted) out.innerHTML = `<p class="error">${esc(e.message)}</p>`; });
}

function speak(text) {
  if (!live.voice || !window.speechSynthesis || !text.trim()) return Promise.resolve();
  const parts = text.match(/[^.!?]+[.!?]*/g) || [text]; // short utterances: Chrome cuts off long ones
  return new Promise((resolve) => {
    speechSynthesis.cancel();
    parts.forEach((p, i) => {
      const u = new SpeechSynthesisUtterance(p.trim());
      u.lang = current.language;
      if (i === parts.length - 1) u.onend = u.onerror = resolve;
      speechSynthesis.speak(u);
    });
    setTimeout(resolve, 90e3); // never wait forever
  });
}

async function interviewerTurn() {
  live.turnBusy = true;
  if ($('next-btn')) $('next-btn').disabled = true;
  listen(false); setMic('Interviewer is speaking…');
  const el = document.createElement('div');
  el.className = 'line them';
  el.innerHTML = '<span class="who">Interviewer</span><span class="t muted">…</span>';
  $('live-lines').append(el); scrollDown();
  const ac = new AbortController();
  live.aborts.push(ac);
  try {
    const text = await streamPost(`/api/sessions/${current.id}/mock-turn`, {}, (t) => { el.querySelector('.t').textContent = t; scrollDown(); }, ac.signal);
    el.querySelector('.t').classList.remove('muted');
    current.transcript.push({ speaker: 'them', text: text.trim(), at: new Date().toISOString() });
    if (view === 'live') await speak(text);
  } catch (e) {
    if (ac.signal.aborted) return;
    el.querySelector('.t').innerHTML = `<span class="error">${esc(e.message)}</span>`;
  }
  live.turnBusy = false;
  if ($('next-btn')) $('next-btn').disabled = false;
  if (view === 'live') listen(true);
}

async function nextQuestion() {
  if (live.turnBusy) return;
  const said = live.interim.trim();
  live.interim = ''; if ($('interim')) $('interim').textContent = '';
  listen(false);
  if (said) await addLiveLine('me', said); // keep words still being recognised
  interviewerTurn();
}

function stopLive() {
  live.on = false;
  try { live.rec?.abort(); } catch {}
  live.rec = null;
  window.speechSynthesis?.cancel();
  live.aborts.forEach((a) => a.abort()); live.aborts = [];
  clearInterval(live.clock); clearTimeout(live.pendingTimer);
  live.events?.close(); live.events = null;
}
// endedElsewhere: the overlay's Exit button already ended the call on the server.
async function endCall(endedElsewhere = false) {
  stopLive();
  try {
    current = endedElsewhere ? await api('GET', `/api/sessions/${current.id}`)
      : await api('POST', `/api/sessions/${current.id}/end`, { skipNotes: true }); // this page writes the notes itself, on screen
  } catch (e) { toast(e.message); }
  pane = 'notes'; showView('session'); renderSession(); refetch();
  if (!current.transcript.length || !aiReady) return;
  if (!endedElsewhere) return generateNotes();
  // Ended from the overlay: the app is already writing the notes. Show them when they're ready.
  toast('AI notes are being written. They appear here in a moment.');
  const id = current.id;
  for (let i = 0; i < 30 && !current.notes; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    if (current?.id !== id || view !== 'session') return;
    current = await api('GET', `/api/sessions/${id}`).catch(() => current);
  }
  if (view === 'session' && current?.id === id) renderSession();
}

/* ================= documents ================= */
async function openDocs() { showView('docs'); $('view-docs').innerHTML = '<h1>Resumes &amp; documents</h1><div class="list"><div class="skel"></div></div>'; await loadDocs(); renderDocs(); }
const docHtml = (d) => `<article class="card"><span class="head"><span class="logo" aria-hidden="true">${ICON.file}</span>
  <span class="titles"><b>${esc(d.name)}</b><span>${d.kind === 'resume' ? 'Resume' : 'Document'} · ${d.chars.toLocaleString()} characters · ${dateLabel(d.createdAt)}</span></span></span>
  <button class="menu-btn" data-del-doc="${d.id}" aria-label="Delete ${esc(d.name)}">${ICON.trash}</button>
  <span class="notes">${esc(d.preview)}</span></article>`;
function renderDocs() {
  if (view !== 'docs') return;
  $('view-docs').innerHTML = `<h1>Resumes &amp; documents</h1>
    <div class="toolbar"><p class="muted">The AI reads these when it suggests answers. Pick a resume when you create a session.</p><button class="btn brand" data-add-doc>${ICON.plus}Add document</button></div>
    <div class="list">${docsCache.length ? docsCache.map(docHtml).join('') : stateBlock(ICON.file, 'No documents yet', 'Add your resume or a job description so suggested answers sound like you.')}</div>`;
}
const toBase64 = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = () => rej(new Error('Could not read that file.')); r.readAsDataURL(f); });
function showDocForm() {
  show(`<form id="doc-form" novalidate>${head('Add document')}
    <label class="field">Kind<select id="d-kind"><option value="resume">Resume</option><option value="document">Job description or other document</option></select></label>
    <label class="field">File<input id="d-file" type="file" accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown"><small>PDF, .txt or .md, up to 10 MB.</small></label>
    <label class="field">Or paste the text<textarea id="d-text" maxlength="60000" placeholder="Paste your resume or the job description"></textarea></label>
    <label class="field">Name<input id="d-name" maxlength="120" placeholder="e.g. Resume 2026" autocomplete="off"></label>
    <p class="form-error" id="d-error" role="alert"></p>
    <div class="dlg-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn brand" id="d-submit">Add document</button></div></form>`);
  $('d-file').addEventListener('change', () => { const f = $('d-file').files[0]; if (f && !$('d-name').value) $('d-name').value = f.name.replace(/\.[^.]+$/, ''); });
  $('doc-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = $('d-file').files[0], body = { name: $('d-name').value || f?.name || '', kind: $('d-kind').value };
    $('d-error').textContent = ''; $('d-submit').disabled = true;
    try {
      if (f) {
        if (f.size > 10e6) throw new Error('That file is over 10 MB. Use a smaller file.');
        if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') {
          if (!server) throw new Error('Reading PDFs needs the app running on your computer. Paste the text instead.');
          $('d-submit').textContent = 'Reading PDF…';
          body.pdfBase64 = await toBase64(f);
        } else body.text = await f.text();
      } else body.text = $('d-text').value;
      await api('POST', '/api/documents', body);
      dlg.close(); toast('Document added');
      await loadDocs(); renderDocs();
    } catch (err) { $('d-error').textContent = err.message; $('d-submit').disabled = false; $('d-submit').textContent = 'Add document'; }
  });
}
async function deleteDoc(id) {
  const d = docsCache.find((x) => x.id === id);
  if (!(await confirmDialog({ title: `Delete ${esc(d?.name ?? 'this document')}?`, text: 'Sessions that use it will continue without it. This cannot be undone.', ok: 'Delete' }))) return;
  try { await api('DELETE', `/api/documents/${id}`); } catch (e) { return toast(e.message); }
  toast('Document deleted'); await loadDocs(); renderDocs();
}

/* ================= events ================= */
document.addEventListener('click', async (e) => {
  const t = e.target, at = (sel) => t.closest(sel), data = (sel, k) => at(sel)?.dataset[k];
  if (!at('#menu') && !at('[data-menu]')) closeMenu(false);
  if (at('[data-tab]')) return selectTab(data('[data-tab]', 'tab'));
  if (at('[data-key]')) return toggle(data('[data-key]', 'key'));
  if (at('[data-retry]')) return refetch();
  if (at('[data-create]')) return showForm(null);
  if (at('[data-close]')) return dlg.close();
  if (at('[data-menu]')) {
    const id = Number(data('[data-menu]', 'menu'));
    return menuFor === id ? closeMenu(true) : (closeMenu(false), openMenu(id, at('[data-menu]')));
  }
  if (at('[data-act]')) {
    const id = menuFor, act = data('[data-act]', 'act');
    closeMenu(false);
    if (act === 'details') return openSession(id, 'details');
    if (act === 'delete') return deleteSession(id);
    try { return showForm(await api('GET', `/api/sessions/${id}`)); } catch (err) { return toast(err.message); }
  }
  if (at('[data-open]')) return openSession(Number(data('[data-open]', 'open')));
  if (at('[data-back]')) { showView('list'); return refetch(); }
  if (at('[data-pane]')) { pane = data('[data-pane]', 'pane'); renderSession(); return document.querySelector(`[data-pane="${pane}"]`)?.focus(); }
  if (at('[data-edit-current]')) return showForm(current);
  if (at('[data-start]')) return startCall();
  if (at('[data-gen-notes]')) return generateNotes();
  if (at('[data-clear-notes]')) return clearNotes();
  if (at('[data-ask]')) return askAI(data('[data-ask]', 'ask'));
  if (at('[data-speaker]')) {
    live.speaker = data('[data-speaker]', 'speaker');
    document.querySelectorAll('[data-speaker]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.speaker === live.speaker)));
    return;
  }
  if (at('[data-answer]')) return answerNow('ai-help');
  if (at('[data-next]')) return nextQuestion();
  if (at('[data-end]')) return endCall();
  if (at('[data-add-doc]')) return showDocForm();
  if (at('[data-del-doc]')) return deleteDoc(Number(data('[data-del-doc]', 'delDoc')));
});
document.addEventListener('submit', (e) => {
  if (e.target.id === 'chat-form') { e.preventDefault(); const v = $('chat-input').value; $('chat-input').value = ''; askAI(v); }
  if (e.target.id === 'line-form') { e.preventDefault(); const v = $('line-input').value; $('line-input').value = ''; addLiveLine(current.mode === 'mock' ? 'me' : live.speaker, v); }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'voice') { live.voice = e.target.checked; if (!live.voice) window.speechSynthesis?.cancel(); }
  if (e.target.id === 'auto') api('PATCH', `/api/sessions/${current.id}`, { autoAnswer: e.target.checked }).then((s) => { current.autoAnswer = s.autoAnswer; }).catch((err) => toast(err.message));
});
dlg.addEventListener('click', (e) => { // close on a backdrop click, not on the dialog's own padding
  const r = dlg.getBoundingClientRect();
  if (e.target === dlg && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) dlg.close();
});
document.addEventListener('keydown', (e) => {
  if (view === 'live' && e.code === 'Space' && current?.mode !== 'mock' && !dlg.open && !e.target.closest?.('input,textarea,select,button')) { e.preventDefault(); return answerNow('ai-help'); }
  if (menuFor == null) return;
  const items = [...$('menu').querySelectorAll('button')], i = items.indexOf(document.activeElement);
  if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus(); }
});
$('q').addEventListener('input', (e) => {
  clearTimeout(typing);
  typing = setTimeout(() => { const v = e.target.value.trim(); if (v !== term) { term = v; reset(); } }, 500); // useDebounce default
});
$('sort').addEventListener('change', reset);
window.addEventListener('focus', () => { if (view === 'list') refetch(); }); // useRereadCallSessionListOnFocus
window.addEventListener('scroll', () => { closeMenu(false); $('fab').classList.toggle('docked', scrollY > 24); }, { passive: true });
window.addEventListener('resize', () => closeMenu(false));
new IntersectionObserver((es) => es[0].isIntersecting && loadMore()).observe($('sentinel')); // infinite scroll

// Decide once: talk to server.js if it answers, otherwise run the store in this page.
(async () => {
  renderTabs(); render();
  try {
    const r = await fetch('api/status');
    if (r.ok && (r.headers.get('content-type') || '').includes('json')) {
      server = true; provider = await r.json(); aiReady = provider.ai;
      if (provider.models?.length) MODEL_LABEL = Object.fromEntries(provider.models);
    }
  } catch {}
  if (!server) loadLocal();
  showBanner(); reset();
})();
