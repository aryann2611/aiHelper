const assert = require('assert');
const db = require('./sessions');
const ai = require('./ai');
const { query } = db;
const N = db.getData().sessions.length;

// search + paging
assert.equal(query().totalCount, N);                                        // empty term = everything
assert.equal(query().data.length, 10);                                      // page size
assert.equal(query({ search: '   ' }).totalCount, N);                       // whitespace trims to empty
assert.ok(query({ search: 'STRIPE' }).data.every((s) => s.company === 'Stripe')); // case-insensitive, company
assert.ok(query({ search: 'ml eng' }).data.every((s) => s.title === 'ML Engineer')); // role substring
assert.equal(query({ search: 'sql window' }).totalCount, 0);                // notes are not searched
const st = query({ sort: 'status' });
assert.ok(st.data.slice(0, 3).every((s) => !s.ended) && st.data[3].ended);  // active first
assert.deepEqual(query().statusCounts, { active: 3, ended: 32 });
const p1 = query(), p2 = query({ cursor: p1.nextCursor });
assert.ok(!p1.data.some((a) => p2.data.some((b) => a.id === b.id)));        // pages don't overlap
assert.equal(query({ cursor: 30 }).nextCursor, null);                       // last page
assert.equal(query({ sort: 'title_asc' }).data[0].title, 'Backend Engineer');
assert.ok(!('transcript' in query().data[0]) && 'lines' in query().data[0]); // list rows stay light

// type tabs
for (const mode of db.MODES) {
  const r = query({ mode, limit: 50 });
  assert.ok(r.totalCount > 0 && r.data.every((s) => s.mode === mode));
  assert.ok(r.statusCounts.active > 0 && r.statusCounts.ended > 0);          // every tab shows both sections
}

// documents
const resume = db.createDoc({ name: 'My resume', kind: 'resume', text: 'Built payment APIs at Acme for 4 years.' });
assert.equal(resume.chars, 39);
assert.throws(() => db.createDoc({ name: 'x', kind: 'resume', text: '  ' }), /has no text/);
assert.throws(() => db.createDoc({ name: 'x', kind: 'poster', text: 'hi' }), /Kind must be/);

// create / edit / delete with AI settings
const made = db.create({ title: '  Staff Engineer ', company: 'Zerodha', mode: 'interview', resumeId: resume.id, context: 'Fintech, Go' });
assert.deepEqual([made.title, made.model, made.language, made.autoAnswer, made.ended, made.activated], ['Staff Engineer', 'gpt-5.5', 'en-US', true, false, false]);
db.update(made.id, { model: 'gpt-5.4-nano', autoAnswer: false, language: 'en-IN' });
assert.deepEqual([db.get(made.id).model, db.get(made.id).autoAnswer, db.get(made.id).title], ['gpt-5.4-nano', false, 'Staff Engineer']);
assert.throws(() => db.update(made.id, { model: 'claude-opus-5-5' }), /listed AI models/);
assert.throws(() => db.update(made.id, { resumeId: 999 }), /no longer exists/);
assert.throws(() => db.update(made.id, { autoAnswer: 'yes' }), /on or off/);

// call lifecycle
db.start(made.id);
assert.ok(db.get(made.id).activated && !db.get(made.id).ended && db.get(made.id).liveSince);
db.addLine(made.id, { speaker: 'them', text: ' Tell me about yourself ' });
db.addLine(made.id, { speaker: 'me', text: 'I build payment systems.' });
assert.equal(db.get(made.id).transcript[0].text, 'Tell me about yourself');
assert.throws(() => db.addLine(made.id, { speaker: 'bot', text: 'x' }), /Speaker must be/);
assert.throws(() => db.addLine(made.id, { speaker: 'me', text: '   ' }), /Line text is required/);
db.end(made.id);
assert.ok(db.get(made.id).ended && db.get(made.id).durationMin >= 1 && !db.get(made.id).liveSince);
db.start(made.id);                                                          // rejoin reopens the call
assert.ok(!db.get(made.id).ended);
db.end(made.id);

// prompts
const s = db.get(made.id);
const a = ai.answerPrompt(s, db.getDoc(resume.id), 'Why us?');
assert.ok(a.messages[0].content.includes('Built payment APIs') && a.messages[0].content.includes('Fintech, Go') && a.model === 'gpt-5.4-nano');
assert.ok(ai.notesPrompt(s, null).messages[0].content.includes('Interviewer: Tell me about yourself'));
const mock = db.create({ title: 'PM', company: 'Figma', mode: 'mock' });
assert.equal(ai.mockPrompt(mock, null).messages.at(-1).role, 'user');      // first turn
db.addLine(mock.id, { speaker: 'them', text: 'Hi, tell me about a launch.' });
assert.equal(ai.mockPrompt(db.get(mock.id), null).messages.at(-1).role, 'user'); // never ends on the interviewer (no prefill)
db.addLine(mock.id, { speaker: 'me', text: 'I launched comments.' });
const mm = ai.mockPrompt(db.get(mock.id), null).messages;
assert.deepEqual(mm.map((x) => x.role), ['user', 'assistant', 'user']);

// deleting a resume unlinks it from sessions
db.removeDoc(resume.id);
assert.equal(db.get(made.id).resumeId, null);
db.remove(made.id); db.remove(mock.id);
assert.equal(query({ search: 'zerodha' }).totalCount, 0);
assert.throws(() => db.get(9999), /not found/);
assert.throws(() => db.create({ company: 'X' }), /Role is required/);

// switching provider swaps the allowed models and moves existing sessions to the new default
db.setModels(['gemini-3.5-flash-lite', 'gemini-3.5-flash']);
assert.equal(db.get(1).model, 'gemini-3.5-flash-lite');
assert.equal(db.create({ title: 'A', company: 'B' }).model, 'gemini-3.5-flash-lite');
assert.throws(() => db.update(1, { model: 'gpt-5.5' }), /listed AI models/);
assert.equal(typeof require('openai').APIConnectionTimeoutError, 'function');

// answer formatting: code blocks coloured, everything escaped, unfinished blocks still shown
const { md } = require('./md');
const html = md('Use this:\n```java\nint x = 1; // one\nString s = "a # b";\n```\n- `x` is **one** <b>');
assert.ok(html.includes('<span class="lang">java</span>') && html.includes('<span class="tk-k">int</span>'));
assert.ok(html.includes('<span class="tk-c">// one</span>') && html.includes('<span class="tk-s">&#34;a # b&#34;</span>'));
assert.ok(html.includes('<li><code>x</code> is <strong>one</strong> &#60;b&#62;</li>'));
assert.ok(md('```py\nprint(1)').includes('<pre class="code">'));

// Auto Answer: questions anywhere in what was said, after filler words; plain statements are not answered
for (const q of ['Okay. So what made you leave Acme', 'Great, thanks. Walk me through your last project.', 'I’d like to hear about a conflict you handled.',
  'That sounds good. Can you explain how a hash map works', 'Tell me about yourself.', 'and the deadline was tight?', "Let's talk about system design."])
  assert.ok(db.isQuestion(q), q);
for (const t of ['Thanks for joining today.', 'We are a payments company with 200 engineers.', 'Okay.', 'Sounds good, thank you.'])
  assert.ok(!db.isQuestion(t), t);
console.log('ok');
